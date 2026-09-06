import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeliveryId,
  RuntimeDeliveryRequest,
  RuntimeEvent,
} from "../contracts/runtime-adapter";
import { CodexRuntimeAdapter } from "../packages/runtime-codex/src/index";
import { CodexAppServerClient } from "../packages/runtime-codex/src/app-server-client";

// A genuine Codex process and two independent app-server clients. Only the
// model's HTTP responses are mocked; no account credentials or billable calls.
test.skipIf(process.env.ACS_REAL_CODEX !== "1")(
  "real Codex delivers idle and active peer inputs with exact provenance and independent markers",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-native-codex-")),
      socket = join(root, "app.sock"),
      firstRequest = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      requests: Record<string, unknown>[] = [],
      events: RuntimeEvent[] = [];
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method !== "POST") return Response.json({ data: [] });
        const index = requests.push(record(await request.json()));
        firstRequest.resolve();
        if (index === 1) await release.promise;
        return new Response(modelResponse(index, "native probe complete"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    writeFileSync(
      join(root, "config.toml"),
      [
        'model_provider = "acs_probe"',
        'model = "acs-probe"',
        "[model_providers.acs_probe]",
        'name = "Isolated ACS test"',
        `base_url = "${model.url.origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );
    const child = Bun.spawn(
        [process.env.ACS_CODEX_BINARY ?? "codex", "app-server", "--listen", `unix://${socket}`],
        {
          env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
      stderr = new Response(child.stderr).text(),
      owner = new CodexAppServerClient(socket),
      adapter = new CodexRuntimeAdapter(socket),
      abort = new AbortController();
    let observed: Promise<void> | undefined;
    try {
      await until(() => existsSync(socket), "Codex app-server socket");
      const initialized = await owner.start();
      expect(initialized.userAgent).toContain(process.env.ACS_EXPECTED_CODEX_VERSION ?? "0.153.2");
      const created = record(
          await owner.startThread({
            cwd: root,
            ephemeral: false,
            approvalPolicy: "never",
            sandbox: "read-only",
          }),
        ),
        threadId = string(record(created.thread).id),
        first = delivery(threadId, "int_first"),
        second = delivery(threadId, "int_second"),
        third = delivery(threadId, "int_third");
      await adapter.start({
        installationId: "ins_native",
        instanceId: "native-test",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        clock: { now: () => new Date().toISOString() },
        assertBindingFence: async () => ({ valid: true }),
      });
      observed = (async () => {
        for await (const event of adapter.observe(abort.signal)) events.push(event);
      })();
      expect((await adapter.inspectSession(first.target.session)).availability).toBe("idle");
      const accepted = await adapter.deliver(first);
      if (accepted.outcome !== "accepted")
        throw new Error(`idle submission: ${JSON.stringify(accepted)}`);
      // A fresh thread has no rollout yet. Direct submission must not require
      // thread/resume, which fails for such threads on the pinned runtime.
      await bounded(firstRequest.promise, "first model request");
      expect((await adapter.inspectSession(first.target.session)).availability).toBe("busy");
      const next = await adapter.deliver(second),
        last = await adapter.deliver(third);
      expect(next).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: accepted.execution.opaqueId, relationship: "unknown" },
      });
      expect(last).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: accepted.execution.opaqueId },
      });
      expect(requests).toHaveLength(1); // accepted does not imply model-observed
      expect(envelopes(requests[0])).toEqual([
        expect.objectContaining({ deliveryId: first.deliveryId }),
      ]);
      await expect(
        owner.request("turn/steer", {
          threadId,
          expectedTurnId: accepted.execution.opaqueId,
          input: [],
          additionalContext: {
            forbidden: { kind: "untrusted", value: "ACS_CONTEXT_ONLY_STEER_MUST_NOT_APPEAR" },
          },
        }),
      ).rejects.toThrow("input must not be empty");
      expect(
        await adapter.cancel({
          execution: {
            normalizedId: "exe_unowned",
            opaqueId: accepted.execution.opaqueId,
            ...first.target,
            session: first.target.session,
          },
        }),
      ).toMatchObject({ outcome: "rejected", reason: "not-owned" });
      release.resolve();
      await until(() => requests.length >= 2, "next model request containing pending input");
      await until(
        () =>
          events.some(
            (event) =>
              event.type === "execution.completed" &&
              event.execution.opaqueId === accepted.execution.opaqueId,
          ),
        "adapter completion notification",
      );
      expect(envelopes(requests[1]).map((item) => item.deliveryId)).toEqual([
        first.deliveryId,
        second.deliveryId,
        third.deliveryId,
      ]);
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain("ACS_CONTEXT_ONLY_STEER_MUST_NOT_APPEAR");
        for (const item of array(request.input).map(record)) {
          if (item.role === "user" || item.role === "developer" || item.role === "system")
            expect(JSON.stringify(item)).not.toContain("ACS_PEER_PROBE_");
        }
      }
      for (const message of [first, second, third]) {
        const recovered = await adapter.reconcile({
          deliveryId: message.deliveryId,
          target: message.target,
          payloadHash: message.payloadHash,
          reconciliationToken: `${threadId}:${message.deliveryId}`,
        });
        expect(recovered).toMatchObject({
          outcome: "accepted",
          execution: { opaqueId: accepted.execution.opaqueId },
        });
      }
      expect(
        await adapter.reconcile({
          deliveryId: second.deliveryId,
          target: second.target,
          payloadHash: "conflicting-hash",
          reconciliationToken: `${threadId}:${second.deliveryId}`,
        }),
      ).toMatchObject({ outcome: "inconclusive" });
      expect(events.filter((event) => event.type === "execution.completed")).toHaveLength(1);
    } finally {
      release.resolve();
      abort.abort();
      await adapter.stop({ reason: "shutdown" });
      await observed;
      owner.close();
      child.kill();
      await child.exited;
      await stderr;
      await model.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

// Optional semantic smoke test. This uses the operator's existing authentication
// only when explicitly opted in; it is NOT a test of desktop/TUI ownership.
test.skipIf(process.env.ACS_REAL_CODEX_MODEL !== "1")(
  "authenticated Codex replies to an idle direct peer message",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-model-codex-")),
      socket = join(root, "app.sock"),
      child = Bun.spawn(
        [
          process.env.ACS_CODEX_BINARY ?? "codex",
          "app-server",
          "--strict-config",
          "--listen",
          `unix://${socket}`,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
      stderr = new Response(child.stderr).text(),
      client = new CodexAppServerClient(socket),
      adapter = new CodexRuntimeAdapter(socket),
      abort = new AbortController();
    let threadId: string | undefined, completed: Promise<RuntimeEvent> | undefined;
    try {
      await until(() => existsSync(socket), "authenticated Codex socket");
      await client.start();
      threadId = string(
        record(
          record(
            await client.startThread({
              cwd: root,
              ephemeral: false,
              approvalPolicy: "never",
              sandbox: "read-only",
            }),
          ).thread,
        ).id,
      );
      await adapter.start({
        installationId: "ins_native",
        instanceId: "model-test",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        clock: { now: () => new Date().toISOString() },
        assertBindingFence: async () => ({ valid: true }),
      });
      completed = (async () => {
        for await (const event of adapter.observe(abort.signal))
          if (event.type === "execution.completed") return event;
        throw new Error("observation ended");
      })();
      // Ensure rejection is consumed even if submission fails before we await it.
      void completed.catch(() => {});
      const request = delivery(threadId, "int_model_smoke");
      expect(
        await adapter.deliver({
          ...request,
          envelope: {
            ...request.envelope,
            message: {
              id: "msg_model",
              parts: [
                { kind: "text", text: "Reply only ACS_NATIVE_INPUT_OK. Do not use any tools." },
              ],
            },
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
      const event = await bounded(completed, "model response", 120_000);
      expect(event).toMatchObject({
        type: "execution.completed",
        outcome: "completed",
        finalParts: [{ kind: "text", text: "ACS_NATIVE_INPUT_OK" }],
      });
    } finally {
      abort.abort();
      await adapter.stop({ reason: "shutdown" });
      await completed?.catch(() => {});
      if (threadId) await client.deleteThread(threadId).catch(() => {});
      client.close();
      child.kill();
      await child.exited;
      await stderr;
      rmSync(root, { recursive: true, force: true });
    }
  },
  150_000,
);

function delivery(threadId: string, id: DeliveryId): RuntimeDeliveryRequest {
  return {
    deliveryId: id,
    mode: "direct",
    target: {
      session: { installationId: "ins_native", opaqueId: threadId },
      bindingId: "bnd_native",
      bindingEpoch: 1,
    },
    payloadHash: `hash-${id}`,
    envelope: {
      schema: "urn:agent-communications:runtime-envelope:v1",
      deliveryId: id,
      kind: "a2a-message",
      from: { agentId: "agt_sender", name: "sender" },
      to: { agentId: "agt_recipient", name: "recipient" },
      message: { id: `msg_${id}`, parts: [{ kind: "text", text: `ACS_PEER_PROBE_${id}` }] },
      provenance: { authority: "peer-agent", trustedForPermissions: false },
    },
  };
}
function modelResponse(index: number, text: string) {
  return [
    { type: "response.created", response: { id: `resp_${index}` } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${index}`,
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}
function envelopes(request: Record<string, unknown> | undefined) {
  if (!request) throw new Error("missing model request");
  return array(request.input)
    .map(record)
    .filter(
      (item) =>
        item.type === "function_call_output" &&
        item.namespace === "acs" &&
        item.name === "receive_agent_message",
    )
    .map((item) => {
      const envelope = record(JSON.parse(string(item.output)));
      expect(envelope.provenance).toEqual({
        authority: "peer-agent",
        trustedForPermissions: false,
      });
      return envelope;
    });
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out: ${label}`);
}
async function bounded<T>(promise: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
