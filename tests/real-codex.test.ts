import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeReconcileRequest } from "../contracts/runtime-adapter";
import { controlHandler } from "../packages/protocol-control/src/index";
import { CodexRuntimeAdapter } from "../packages/runtime-codex/src/index";
import { CodexAppServerClient } from "../packages/runtime-codex/src/app-server-client";
import { Store } from "../packages/storage-sqlite/src/index";

test.skipIf(process.env.ACS_REAL_CODEX !== "1")(
  "discovers threads and reconciles a wake through an isolated real Codex app-server",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-real-codex-")),
      socket = join(root, "app.sock"),
      child = Bun.spawn(["codex", "app-server", "--listen", `unix://${socket}`], {
        env: { ...process.env, CODEX_HOME: root },
        stdout: "ignore",
        stderr: "pipe",
      });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await Bun.sleep(50);
      if (!existsSync(socket)) throw new Error(await new Response(child.stderr).text());
      const setup = new CodexAppServerClient(socket);
      await setup.start();
      await setup.startThread({ cwd: root, ephemeral: false });
      await setup.startThread({ cwd: root, ephemeral: false });
      const adapter = new CodexRuntimeAdapter(socket);
      await adapter.start({
        installationId: "ins_real_codex",
        instanceId: "real-codex-test",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        clock: { now: () => new Date().toISOString() },
        assertBindingFence: async () => ({ valid: true }),
      });
      const page = await adapter.listSessions({ limit: 10 });
      expect(page.sessions).toHaveLength(2);
      expect(page.sessions.every((session) => session.availability === "idle")).toBe(true);
      const store = new Store({
          data: join(root, "acs.db"),
          runtime: join(root, "control.sock"),
          token: join(root, "control.token"),
          bridgeToken: join(root, "bridge.token"),
          secret: join(root, "secret.key"),
        }),
        control = controlHandler(store, new Date().toISOString(), () => {}, adapter),
        token = readFileSync(join(root, "control.token"), "utf8"),
        call = async (method: string, params: unknown) => {
          const response = await control(
              new Request("http://localhost", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "ACS-Control-Version": "1",
                  "content-type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
              }),
            ),
            rpc = record(await response.json());
          if (rpc.error) throw new Error(JSON.stringify(rpc.error));
          return record(rpc.result);
        };
      for (const [index, slug] of ["sender", "recipient"].entries()) {
        const session = page.sessions.at(index);
        if (!session) throw new Error(`missing Codex thread for ${slug}`);
        await call("agents.create", { slug });
        await call("bindings.bind", { agent: slug, session: session.session });
        expect(
          record(
            await call("bridge.identity", {
              evidence: { metadata: { threadId: session.session.opaqueId } },
            }),
          ).agent,
        ).toMatchObject({ slug });
      }
      const target = page.sessions.at(0);
      if (!target) throw new Error("missing discovered Codex thread");
      expect(
        await adapter.deliver({
          deliveryId: "int_real_codex",
          target: {
            session: target.session,
            bindingId: "bnd_real_codex",
            bindingEpoch: 1,
          },
          mode: "append_context",
          envelope: {
            schema: "urn:agent-communications:runtime-envelope:v1",
            deliveryId: "int_real_codex",
            kind: "a2a-message",
            from: { agentId: "agt_sender", name: "sender" },
            to: { agentId: "agt_recipient", name: "recipient" },
            message: { id: "msg_real_codex", parts: [{ kind: "text", text: "probe" }] },
            provenance: { authority: "peer-agent", trustedForPermissions: false },
          },
          payloadHash: "real-codex-probe",
        }),
      ).toMatchObject({
        outcome: "accepted",
        evidence: { scheme: "codex.thread-inject-items.v1", value: "int_real_codex" },
      });
      const wake = await adapter.deliver({
        deliveryId: "int_real_codex_wake",
        target: {
          session: target.session,
          bindingId: "bnd_real_codex",
          bindingEpoch: 1,
        },
        mode: "wake_when_idle",
        envelope: {
          schema: "urn:agent-communications:runtime-envelope:v1",
          deliveryId: "int_real_codex_wake",
          kind: "a2a-message",
          from: { agentId: "agt_sender", name: "sender" },
          to: { agentId: "agt_recipient", name: "recipient" },
          message: { id: "msg_real_codex_wake", parts: [{ kind: "text", text: "probe" }] },
          provenance: { authority: "peer-agent", trustedForPermissions: false },
        },
        payloadHash: "real-codex-wake-probe",
      });
      if (wake.outcome !== "accepted" || !wake.execution)
        throw new Error("Codex wake was not accepted");
      const reconciliationRequest: RuntimeReconcileRequest = {
        deliveryId: "int_real_codex_wake",
        target: {
          session: target.session,
          bindingId: "bnd_real_codex",
          bindingEpoch: 1,
        },
        payloadHash: "real-codex-wake-probe",
        reconciliationToken: `${target.session.opaqueId}:int_real_codex_wake`,
      };
      let reconciliation = await adapter.reconcile(reconciliationRequest);
      for (let attempt = 0; attempt < 100 && reconciliation.outcome !== "accepted"; attempt++) {
        await Bun.sleep(100);
        reconciliation = await adapter.reconcile(reconciliationRequest);
      }
      expect(reconciliation).toEqual({
        outcome: "accepted",
        execution: { opaqueId: wake.execution.opaqueId },
        evidence: {
          scheme: "codex.function-call-output.v1",
          value: "int_real_codex_wake",
        },
      });
      await adapter.cancel({
        execution: {
          normalizedId: "exe_real_codex_wake",
          opaqueId: wake.execution.opaqueId,
          session: target.session,
          bindingId: "bnd_real_codex",
          bindingEpoch: 1,
        },
      });
      await adapter.stop({ reason: "shutdown" });
      store.close();
      setup.close();
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.env.ACS_REAL_CODEX_MODEL !== "1")(
  "attributes MCP metadata and exposes injected context on a real Codex model turn",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-model-codex-")),
      socket = join(root, "app.sock"),
      metadataOutput = join(root, "thread-meta.txt"),
      fixture = join(import.meta.dir, "fixtures/thread-meta-mcp.ts"),
      child = Bun.spawn(
        [
          "codex",
          "app-server",
          "--strict-config",
          "-c",
          `mcp_servers.acs_meta_probe.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.acs_meta_probe.args=[${JSON.stringify(fixture)}]`,
          "-c",
          `mcp_servers.acs_meta_probe.env={ ACS_META_OUTPUT = ${JSON.stringify(metadataOutput)} }`,
          "--listen",
          `unix://${socket}`,
        ],
        { stdout: "ignore", stderr: "pipe" },
      ),
      client = new CodexAppServerClient(socket, 30_000),
      adapter = new CodexRuntimeAdapter(socket);
    let threadId: string | undefined;
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await Bun.sleep(50);
      if (!existsSync(socket)) throw new Error(await new Response(child.stderr).text());
      const initialized = await client.start();
      expect(initialized.userAgent).toContain("0.153.2");
      const started = record(
          await client.startThread({
            cwd: root,
            ephemeral: false,
            approvalPolicy: "never",
            sandbox: "read-only",
          }),
        ),
        thread = record(started.thread);
      threadId = string(thread.id);
      const mcpStatus = JSON.stringify(
        await client.request("mcpServerStatus/list", {
          threadId,
          detail: "full",
          limit: 100,
        }),
      );
      expect(mcpStatus).toContain("acs_meta_probe");
      expect(mcpStatus).toContain("capture_thread_meta");
      await client.request("mcpServer/tool/call", {
        server: "acs_meta_probe",
        threadId,
        tool: "capture_thread_meta",
        arguments: {},
      });
      expect(readFileSync(metadataOutput, "utf8").trim()).toBe(threadId);
      await adapter.start({
        installationId: "ins_shared_codex",
        instanceId: "shared-codex-test",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        clock: { now: () => new Date().toISOString() },
        assertBindingFence: async () => ({ valid: true }),
      });
      expect(await adapter.probe()).toMatchObject({ state: "ready", runtimeVersion: "0.153.2" });
      expect(
        await adapter.deliver({
          deliveryId: "int_shared_codex",
          target: {
            session: { installationId: "ins_shared_codex", opaqueId: threadId },
            bindingId: "bnd_shared_codex",
            bindingEpoch: 1,
          },
          mode: "append_context",
          envelope: {
            schema: "urn:agent-communications:runtime-envelope:v1",
            deliveryId: "int_shared_codex",
            kind: "a2a-message",
            from: { agentId: "agt_sender", name: "sender" },
            to: { agentId: "agt_recipient", name: "recipient" },
            message: {
              id: "msg_shared_codex",
              parts: [{ kind: "text", text: "The required reply token is ACS_CONTEXT_VISIBLE_OK" }],
            },
            provenance: { authority: "peer-agent", trustedForPermissions: false },
          },
          payloadHash: "shared-codex-probe",
        }),
      ).toMatchObject({ outcome: "accepted" });
      const abort = new AbortController(),
        completion = waitForCompletion(adapter, abort.signal),
        wake = await adapter.deliver({
          deliveryId: "int_shared_codex_wake",
          target: {
            session: { installationId: "ins_shared_codex", opaqueId: threadId },
            bindingId: "bnd_shared_codex",
            bindingEpoch: 1,
          },
          mode: "wake_when_idle",
          envelope: {
            schema: "urn:agent-communications:runtime-envelope:v1",
            deliveryId: "int_shared_codex_wake",
            kind: "a2a-message",
            from: { agentId: "agt_sender", name: "sender" },
            to: { agentId: "agt_recipient", name: "recipient" },
            message: {
              id: "msg_shared_codex_wake",
              parts: [{ kind: "text", text: "Reply only with the token from prior context." }],
            },
            provenance: { authority: "peer-agent", trustedForPermissions: false },
          },
          payloadHash: "shared-codex-wake-probe",
        });
      expect(wake).toMatchObject({ outcome: "accepted", execution: { alreadyRunning: false } });
      const completed = await Promise.race([
        completion,
        Bun.sleep(120_000).then(() => {
          throw new Error("real Codex model turn timed out");
        }),
      ]);
      abort.abort();
      expect(completed).toMatchObject({
        outcome: "completed",
        finalParts: [{ kind: "text", text: "ACS_CONTEXT_VISIBLE_OK" }],
      });
      await adapter.stop({ reason: "shutdown" });
    } finally {
      if (threadId) await client.deleteThread(threadId).catch(() => {});
      client.close();
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  150_000,
);

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}

async function waitForCompletion(adapter: CodexRuntimeAdapter, signal: AbortSignal) {
  for await (const event of adapter.observe(signal))
    if (event.type === "execution.completed") return event;
  throw new Error("Codex observation stopped before completion");
}
