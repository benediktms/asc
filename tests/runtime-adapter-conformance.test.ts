import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeAdapter,
  RuntimeAdapterContext,
  RuntimeDeliveryRequest,
  RuntimeReconcileRequest,
} from "../contracts/runtime-adapter";
import {
  CodexRuntimeAdapter,
  SUPPORTED_CODEX_VERSIONS,
  TESTED_CODEX_VERSION,
} from "../packages/runtime-codex/src/index";
import { responseItem } from "../packages/runtime-codex/src/protocol-codec";
import { canonical } from "../packages/domain/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("Codex codec renders the delivery envelope as canonical JSON", () => {
  const envelope = delivery().envelope,
    item = responseItem(envelope);
  if (item.type !== "function_call_output") throw new Error("expected function call output");
  expect(item.output).toBe(canonical(envelope));
});

type Fixture = {
  adapter: RuntimeAdapter;
  context: RuntimeAdapterContext;
  methods: string[];
  failNext(method: string, failure: "overload" | "disconnect" | "hang"): void;
  disconnect(): void;
  request(method: string, params: unknown): void;
  setFence(valid: boolean): void;
  setHistoryDelivery(deliveryId: string): void;
  setLoadedOnly(): void;
  setSessionPages(): void;
  setSource(source: unknown): void;
  setStatus(status: string): void;
  notify(method: string, params: unknown): void;
  close(): void;
};

function runtimeAdapterConformance(name: string, create: () => Promise<Fixture>) {
  describe(`${name} runtime adapter conformance`, () => {
    test("preserves fences, correlation, conservative state, and shutdown", async () => {
      const fixture = await create(),
        { adapter, context, methods } = fixture;
      await adapter.start(context);
      await adapter.start(context);
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      const iterator = adapter.observe(new AbortController().signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        type: "adapter.connection",
        state: "online",
      });

      let flushes = 0;
      const markRequestFlushed = () => flushes++;
      fixture.setFence(false);
      expect(await adapter.deliver({ ...delivery(), markRequestFlushed })).toMatchObject({
        outcome: "rejected",
        reason: "stale-binding",
      });
      expect(flushes).toBe(0);
      expect(mutations(methods)).toEqual([]);

      const reads = methods.filter((method) => method === "thread/read").length,
        unsupported: RuntimeDeliveryRequest = JSON.parse(JSON.stringify(delivery()));
      Object.assign(unsupported.envelope.message?.parts[0] ?? {}, { kind: "future" });
      expect(await adapter.deliver(unsupported)).toMatchObject({
        outcome: "rejected",
        reason: "unsupported-content",
      });
      expect(methods.filter((method) => method === "thread/read")).toHaveLength(reads);
      expect(mutations(methods)).toEqual([]);

      expect(await adapter.deliver(delivery("join_active"))).toMatchObject({
        outcome: "rejected",
        reason: "unsupported-mode",
      });
      expect(methods.filter((method) => method === "thread/read")).toHaveLength(reads);
      expect(mutations(methods)).toEqual([]);

      fixture.setFence(true);
      const accepted = await adapter.deliver({ ...delivery(), markRequestFlushed });
      expect(accepted).toEqual({
        outcome: "accepted",
        acceptedAt: expect.any(String),
        evidence: { scheme: "codex.thread-inject-items.v1", value: "int_conformance" },
      });
      expect(flushes).toBe(1);
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      fixture.setStatus("active");
      expect(
        await adapter.deliver({ ...delivery("wake_when_idle"), markRequestFlushed }),
      ).toMatchObject({
        outcome: "deferred",
        reason: "busy",
      });
      expect(flushes).toBe(1);
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      fixture.setStatus("future-status");
      expect((await adapter.inspectSession(delivery().target.session)).availability).toBe(
        "unknown",
      );
      expect(
        await adapter.cancel({
          execution: {
            normalizedId: "exe_unowned",
            opaqueId: "foreign-turn",
            session: delivery().target.session,
            bindingId: "bnd_conformance",
            bindingEpoch: 1,
          },
        }),
      ).toMatchObject({ outcome: "rejected", reason: "not-owned" });
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      const reconciliation: RuntimeReconcileRequest = {
        deliveryId: "int_conformance",
        target: delivery().target,
        payloadHash: "payload-hash",
        reconciliationToken: "thread-1:int_conformance",
      };
      expect(
        await adapter.reconcile({ ...reconciliation, reconciliationToken: "invalid" }),
      ).toMatchObject({ outcome: "inconclusive", reason: "invalid Codex reconciliation token" });
      expect((await adapter.reconcile(reconciliation)).outcome).toBe("inconclusive");
      expect((await adapter.reconcile(reconciliation)).outcome).toBe("inconclusive");
      fixture.failNext("thread/read", "overload");
      expect(await adapter.reconcile(reconciliation)).toEqual({
        outcome: "inconclusive",
        reason: "Codex reconciliation failed (BACKPRESSURE)",
        operatorActionRequired: true,
      });
      fixture.setHistoryDelivery("int_conformance");
      expect(await adapter.reconcile(reconciliation)).toEqual({
        outcome: "accepted",
        execution: { opaqueId: "turn-history" },
        evidence: {
          scheme: "codex.function-call-output.v1",
          value: "int_conformance",
        },
      });
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      fixture.setStatus("idle");
      expect(await adapter.deliver(delivery("wake_when_idle"))).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-1" },
      });
      expect(await adapter.deliver(delivery("wake_when_idle"))).toEqual({
        outcome: "deferred",
        reason: "busy",
      });
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
      const started = iterator.next();
      fixture.notify("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress" },
      });
      expect((await started).value).toEqual({
        type: "execution.started",
        session: { installationId: "ins_conformance", opaqueId: "thread-1" },
        execution: {
          opaqueId: "turn-1",
          session: { installationId: "ins_conformance", opaqueId: "thread-1" },
        },
        correlation: { deliveryId: "int_conformance", payloadHash: "payload-hash" },
      });
      const localInput = iterator.next();
      fixture.request("item/tool/requestUserInput", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [],
      });
      expect((await localInput).value).toEqual({
        type: "execution.awaiting-local-input",
        execution: {
          opaqueId: "turn-1",
          session: { installationId: "ins_conformance", opaqueId: "thread-1" },
        },
        request: {
          opaqueId: "server-request-1",
          kind: "question",
          blocking: true,
          summary: "Local runtime input required",
        },
      });
      const output = iterator.next();
      fixture.notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "reasoning", summary: ["private reasoning"] },
      });
      expect(
        await Promise.race([output.then(() => "event"), Bun.sleep(25).then(() => "none")]),
      ).toBe("none");
      fixture.notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "final answer" },
      });
      expect((await output).value).toEqual({
        type: "execution.output",
        execution: {
          opaqueId: "turn-1",
          session: { installationId: "ins_conformance", opaqueId: "thread-1" },
        },
        channel: "final-message",
        parts: [{ kind: "text", text: "final answer", mediaType: "text/markdown" }],
      });
      const completion = iterator.next();
      fixture.notify("turn/completed", {
        turn: { id: "foreign-turn", status: "completed" },
      });
      expect(
        await Promise.race([completion.then(() => "event"), Bun.sleep(25).then(() => "none")]),
      ).toBe("none");
      fixture.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      expect((await completion).value).toMatchObject({
        type: "execution.completed",
        execution: { opaqueId: "turn-1" },
        finalParts: [{ kind: "text", text: "final answer" }],
      });

      fixture.failNext("thread/inject_items", "overload");
      expect(await adapter.deliver(delivery())).toMatchObject({
        outcome: "deferred",
        reason: "backpressure",
      });

      fixture.failNext("thread/inject_items", "disconnect");
      expect(await adapter.deliver(delivery())).toMatchObject({
        outcome: "acceptance-unknown",
        ambiguity: "connection-reset",
      });
      expect((await iterator.next()).value).toEqual({
        type: "adapter.connection",
        state: "offline",
      });

      await adapter.stop({ reason: "shutdown" });
      expect((await iterator.next()).done).toBe(true);
      const mutationsBeforeStoppedCall = mutations(methods);
      await expect(adapter.deliver(delivery())).rejects.toThrow("runtime adapter stopped");
      expect(mutations(methods)).toEqual(mutationsBeforeStoppedCall);
      fixture.close();
    }, 30_000);

    test("reconnects after a disconnect without duplicating notifications", async () => {
      const fixture = await create(),
        { adapter, context, methods } = fixture;
      await adapter.start(context);
      const iterator = adapter.observe(new AbortController().signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ state: "online" });
      fixture.disconnect();
      expect((await iterator.next()).value).toMatchObject({ state: "offline" });
      expect(await adapter.deliver(delivery())).toMatchObject({
        outcome: "deferred",
        reason: "offline",
      });
      expect(mutations(methods)).toEqual([]);

      await adapter.start(context);
      expect((await iterator.next()).value).toMatchObject({ state: "online" });
      expect(await adapter.deliver(delivery("wake_when_idle"))).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-1" },
      });
      fixture.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      expect((await iterator.next()).value).toMatchObject({
        type: "execution.completed",
        execution: { opaqueId: "turn-1" },
      });
      expect(
        await Promise.race([iterator.next().then(() => "event"), Bun.sleep(25).then(() => "none")]),
      ).toBe("none");
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("resumes a dormant thread only when policy permits", async () => {
      const fixture = await create(),
        { adapter, context, methods } = fixture;
      await adapter.start(context);
      fixture.setStatus("notLoaded");
      let flushes = 0;
      expect(await adapter.deliver(delivery("wake_when_idle"))).toMatchObject({
        outcome: "deferred",
        reason: "dormant",
      });
      expect(mutations(methods)).toEqual([]);
      expect(
        await adapter.deliver({
          ...delivery("wake_when_idle"),
          autoResumeDormantThread: true,
          markRequestFlushed: () => flushes++,
        }),
      ).toMatchObject({ outcome: "accepted", execution: { opaqueId: "turn-1" } });
      expect(mutations(methods)).toEqual(["turn/start"]);
      expect(flushes).toBe(1);
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("does not repeat loaded sessions across stored pages", async () => {
      const fixture = await create(),
        { adapter, context } = fixture;
      fixture.setSessionPages();
      await adapter.start(context);
      const first = await adapter.listSessions({ limit: 1 }),
        second = await adapter.listSessions({ limit: 1, cursor: first.nextCursor }),
        third = await adapter.listSessions({ limit: 1, cursor: second.nextCursor });
      expect(first.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-2"]);
      expect(second.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-1"]);
      expect(second.sessions[0]?.availability).toBe("idle");
      expect(third).toEqual({ sessions: [], nextCursor: undefined });
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("lists loaded sessions that are not persisted yet", async () => {
      const fixture = await create(),
        { adapter, context } = fixture;
      fixture.setLoadedOnly();
      await adapter.start(context);
      const page = await adapter.listSessions({ limit: 1 });
      expect(page.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-3"]);
      expect(page.nextCursor).toBeUndefined();
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("does not expose unknown runtime source metadata", async () => {
      const fixture = await create(),
        { adapter, context } = fixture;
      await adapter.start(context);
      fixture.setSource({ type: "cli", token: "secret-value" });
      const snapshot = await adapter.inspectSession(delivery().target.session);
      expect(snapshot.attributes.sourceKind).toBe("cli");
      expect(JSON.stringify(snapshot)).not.toContain("secret-value");
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("honors aborts without hiding an ambiguous write", async () => {
      const fixture = await create(),
        { adapter, context, methods } = fixture;
      await adapter.start(context);

      fixture.failNext("thread/read", "hang");
      const readAbort = new AbortController(),
        read = adapter.inspectSession(delivery().target.session, readAbort.signal);
      readAbort.abort();
      await expect(read).rejects.toThrow(/operation was aborted/i);

      fixture.failNext("thread/inject_items", "hang");
      let flushes = 0;
      const writeAbort = new AbortController(),
        write = adapter.deliver(
          { ...delivery(), markRequestFlushed: () => flushes++ },
          writeAbort.signal,
        );
      await waitForMethod(methods, "thread/inject_items");
      writeAbort.abort();
      expect(await write).toMatchObject({
        outcome: "acceptance-unknown",
        ambiguity: "connection-reset",
      });
      expect(flushes).toBe(1);
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("preserves ambiguity across shutdown and cancellation disconnects", async () => {
      const shutdownFixture = await create(),
        {
          adapter: shutdownAdapter,
          context: shutdownContext,
          methods: shutdownMethods,
        } = shutdownFixture;
      await shutdownAdapter.start(shutdownContext);
      shutdownFixture.failNext("thread/inject_items", "hang");
      const deliveryResult = shutdownAdapter.deliver(delivery());
      await waitForMethod(shutdownMethods, "thread/inject_items");
      await shutdownAdapter.stop({ reason: "shutdown" });
      expect(await deliveryResult).toMatchObject({
        outcome: "acceptance-unknown",
        ambiguity: "connection-reset",
      });
      shutdownFixture.close();

      const cancelFixture = await create(),
        { adapter: cancelAdapter, context: cancelContext, methods: cancelMethods } = cancelFixture;
      await cancelAdapter.start(cancelContext);
      const accepted = await cancelAdapter.deliver(delivery("wake_when_idle"));
      if (accepted.outcome !== "accepted" || !accepted.execution)
        throw new Error("expected owned execution");
      cancelFixture.failNext("turn/interrupt", "hang");
      const cancelResult = cancelAdapter.cancel({
        execution: {
          normalizedId: "exe_cancel",
          opaqueId: accepted.execution.opaqueId,
          session: delivery().target.session,
          bindingId: delivery().target.bindingId,
          bindingEpoch: delivery().target.bindingEpoch,
        },
      });
      await waitForMethod(cancelMethods, "turn/interrupt");
      cancelFixture.disconnect();
      expect(await cancelResult).toMatchObject({ outcome: "unknown" });
      await cancelAdapter.stop({ reason: "shutdown" });
      cancelFixture.close();
    });
  });
}

runtimeAdapterConformance("Codex", () => codexFixture());

test("Codex runtime adapter enables mutations for every supported runtime", async () => {
  for (const version of SUPPORTED_CODEX_VERSIONS) {
    const fixture = await codexFixture(`codex-cli ${version}`),
      { adapter, context, methods } = fixture;
    await adapter.start(context);
    expect(await adapter.probe()).toMatchObject({ state: "ready", runtimeVersion: version });
    expect(await adapter.deliver(delivery())).toMatchObject({ outcome: "accepted" });
    expect(mutations(methods)).toEqual(["thread/inject_items"]);
    await adapter.stop({ reason: "shutdown" });
    fixture.close();
  }
});

test("Codex runtime adapter disables mutations for an untested runtime", async () => {
  const fixture = await codexFixture("codex-cli 99.0.0"),
    { adapter, context, methods } = fixture;
  await adapter.start(context);
  expect(await adapter.probe()).toMatchObject({
    state: "incompatible",
    runtimeVersion: "99.0.0",
    protocolFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    capabilities: { appendContext: false, wakeWhenIdle: false, cancelOwnedExecution: false },
  });
  expect(await adapter.deliver(delivery())).toMatchObject({
    outcome: "rejected",
    reason: "runtime-protocol-error",
  });
  expect(mutations(methods)).toEqual([]);
  await adapter.stop({ reason: "shutdown" });
  fixture.close();
});

async function codexFixture(userAgent = `codex-cli ${TESTED_CODEX_VERSION}`): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "acs-adapter-"));
  roots.push(root);
  const path = join(root, "codex.sock"),
    methods: string[] = [],
    buffers = new WeakMap<object, Buffer>(),
    failures = new Map<string, "overload" | "disconnect" | "hang">();
  let fence = true,
    historyDelivery: string | undefined,
    loadedOnly = false,
    sessionPages = false,
    source: unknown = "test",
    status = "idle";
  let sendNotification: ((method: string, params: unknown) => void) | undefined,
    sendRequest: ((method: string, params: unknown) => void) | undefined,
    disconnect: (() => void) | undefined;
  const server = Bun.listen({
    unix: path,
    socket: {
      open() {},
      data(socket, data) {
        disconnect = () => socket.end();
        sendNotification = (method, params) =>
          void socket.write(serverFrame(JSON.stringify({ method, params })));
        sendRequest = (method, params) =>
          void socket.write(
            serverFrame(JSON.stringify({ id: "server-request-1", method, params })),
          );
        const bytes = Buffer.from(data),
          text = bytes.toString();
        if (text.startsWith("GET ")) {
          const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.[1];
          if (!key) throw new Error("missing websocket key");
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          return;
        }
        let pending = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), bytes]);
        for (;;) {
          const decoded = decodeClientFrame(pending);
          if (!decoded) break;
          pending = pending.subarray(decoded.consumed);
          const request = record(JSON.parse(decoded.text)),
            method = string(request.method);
          methods.push(method);
          const failure = failures.get(method);
          failures.delete(method);
          if (failure === "hang") continue;
          if (failure === "disconnect") {
            socket.end();
            return;
          }
          if (typeof request.id === "number" && failure === "overload")
            socket.write(
              serverFrame(
                JSON.stringify({
                  id: request.id,
                  error: { code: -32000, message: "ingress overloaded" },
                }),
              ),
            );
          else if (typeof request.id === "number")
            socket.write(
              serverFrame(
                JSON.stringify({
                  id: request.id,
                  result: response(
                    method,
                    status,
                    userAgent,
                    historyDelivery,
                    source,
                    request.params,
                    sessionPages,
                    loadedOnly,
                  ),
                }),
              ),
            );
        }
        buffers.set(socket, pending);
      },
      close() {},
      error() {},
    },
  });
  return {
    adapter: new CodexRuntimeAdapter(path),
    context: {
      installationId: "ins_conformance",
      instanceId: "conformance",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      clock: { now: () => new Date().toISOString() },
      assertBindingFence: async () => (fence ? { valid: true } : { valid: false, reason: "stale" }),
    },
    methods,
    failNext(method, failure) {
      failures.set(method, failure);
    },
    disconnect() {
      if (!disconnect) throw new Error("emulator is not connected");
      disconnect();
    },
    request(method, params) {
      if (!sendRequest) throw new Error("emulator is not connected");
      sendRequest(method, params);
    },
    setFence(value) {
      fence = value;
    },
    setHistoryDelivery(deliveryId) {
      historyDelivery = deliveryId;
    },
    setLoadedOnly() {
      loadedOnly = true;
    },
    setSessionPages() {
      sessionPages = true;
    },
    setSource(value) {
      source = value;
    },
    setStatus(value) {
      status = value;
    },
    notify(method, params) {
      if (!sendNotification) throw new Error("emulator is not connected");
      sendNotification(method, params);
    },
    close() {
      server.stop();
    },
  };
}

function delivery(mode: RuntimeDeliveryRequest["mode"] = "append_context"): RuntimeDeliveryRequest {
  return {
    deliveryId: "int_conformance",
    target: {
      session: { installationId: "ins_conformance", opaqueId: "thread-1" },
      bindingId: "bnd_conformance",
      bindingEpoch: 1,
    },
    mode,
    envelope: {
      schema: "urn:agent-communications:runtime-envelope:v1",
      deliveryId: "int_conformance",
      kind: "a2a-message",
      from: { agentId: "agt_sender", name: "sender" },
      to: { agentId: "agt_target", name: "target" },
      message: { id: "msg_1", parts: [{ kind: "text", text: "hello" }] },
      provenance: { authority: "peer-agent", trustedForPermissions: false },
    },
    payloadHash: "payload-hash",
  };
}

function response(
  method: string,
  status: string,
  userAgent: string,
  historyDelivery?: string,
  source: unknown = "test",
  params?: unknown,
  sessionPages = false,
  loadedOnly = false,
) {
  if (method === "initialize") return { userAgent };
  if (method === "thread/loaded/list")
    return { data: sessionPages ? ["thread-1"] : loadedOnly ? ["thread-3"] : [], nextCursor: null };
  if (method === "thread/list") {
    if (!sessionPages) return { data: [], nextCursor: null };
    return record(params).cursor === "page-2"
      ? { data: [thread("thread-1", status, source, historyDelivery)], nextCursor: null }
      : { data: [thread("thread-2", status, source)], nextCursor: "page-2" };
  }
  if (method === "thread/read") {
    const threadId = record(params).threadId;
    return {
      thread: thread(
        typeof threadId === "string" ? threadId : "thread-1",
        status,
        source,
        historyDelivery,
      ),
    };
  }
  if (method === "turn/start") return { turn: { id: "turn-1" } };
  return {};
}

function thread(id: string, status: string, source: unknown, historyDelivery?: string) {
  return {
    id,
    preview: "test",
    name: null,
    updatedAt: 1,
    cwd: "/tmp",
    cliVersion: "test",
    source,
    status: { type: status },
    turns: historyDelivery
      ? [
          {
            id: "turn-history",
            items: [
              {
                type: "functionCallOutput",
                name: "receive_agent_message",
                namespace: "acs",
                output: JSON.stringify({ deliveryId: historyDelivery }),
              },
            ],
          },
        ]
      : [],
  };
}

function mutations(methods: string[]) {
  return methods.filter((method) =>
    ["thread/inject_items", "turn/start", "turn/interrupt"].includes(method),
  );
}

async function waitForMethod(methods: string[], method: string) {
  for (let index = 0; index < 100 && !methods.includes(method); index++) await Bun.sleep(1);
  expect(methods).toContain(method);
}

function decodeClientFrame(frame: Buffer) {
  if (frame.length < 6) return undefined;
  const lengthCode = byte(frame, 1) & 0x7f,
    offset = lengthCode === 126 ? 4 : 2,
    length = lengthCode === 126 ? frame.readUInt16BE(2) : lengthCode,
    mask = frame.subarray(offset, offset + 4),
    payload = frame.subarray(offset + 4, offset + 4 + length);
  if (payload.length < length) return undefined;
  return {
    text: Buffer.from(payload.map((value, index) => value ^ byte(mask, index % 4))).toString(),
    consumed: offset + 4 + length,
  };
}

function serverFrame(text: string) {
  const body = Buffer.from(text);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("invalid WebSocket frame");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown) {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
