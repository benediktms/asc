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
  failNext(method: string, failure: "overload" | "disconnect" | "hang" | "malformed"): void;
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
    test("preserves fences, direct input, shared correlation, and local ownership", async () => {
      const fixture = await create(),
        { adapter, context, methods } = fixture;
      await adapter.start(context);
      await adapter.start(context);
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      const abort = new AbortController(),
        iterator = adapter.observe(abort.signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ state: "online" });
      let flushes = 0;
      const markRequestFlushed = () => flushes++;
      fixture.setFence(false);
      expect(await adapter.deliver({ ...delivery(), markRequestFlushed })).toMatchObject({
        outcome: "rejected",
        reason: "stale-binding",
      });
      expect(flushes).toBe(0);
      expect(mutations(methods)).toEqual([]);
      const unsupported: RuntimeDeliveryRequest = JSON.parse(JSON.stringify(delivery()));
      Object.assign(unsupported.envelope.message?.parts[0] ?? {}, { kind: "future" });
      expect(await adapter.deliver(unsupported)).toMatchObject({
        outcome: "rejected",
        reason: "unsupported-content",
      });
      fixture.setFence(true);
      const accepted = await adapter.deliver({ ...delivery(), markRequestFlushed });
      expect(accepted).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-1", relationship: "unknown" },
        evidence: { scheme: "codex.turn-start.tool-output.v1", value: "turn-1" },
      });
      fixture.setStatus("active");
      const second = delivery();
      const secondRequest: RuntimeDeliveryRequest = {
        ...second,
        deliveryId: "int_second",
        envelope: { ...second.envelope, deliveryId: "int_second" },
      };
      expect(await adapter.deliver({ ...secondRequest, markRequestFlushed })).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-1", relationship: "unknown" },
      });
      expect(flushes).toBe(2);
      expect(mutations(methods)).toEqual(["turn/start", "turn/start"]);
      const started = iterator.next();
      fixture.notify("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress" },
      });
      expect((await started).value).toMatchObject({
        type: "execution.started",
        correlation: { deliveryIds: ["int_conformance", "int_second"] },
      });
      const localInput = iterator.next();
      fixture.request("item/tool/requestUserInput", {
        threadId: "thread-1",
        turnId: "turn-1",
        isBlocking: true,
        questions: [],
      });
      expect((await localInput).value).toMatchObject({
        type: "execution.awaiting-local-input",
        request: { kind: "question", blocking: true },
      });
      expect(
        await adapter.cancel({
          execution: {
            normalizedId: "exe_shared",
            opaqueId: "turn-1",
            session: delivery().target.session,
            bindingId: "bnd_conformance",
            bindingEpoch: 1,
          },
        }),
      ).toMatchObject({ outcome: "rejected", reason: "not-owned" });
      expect(methods).not.toContain("turn/interrupt");
      const output = iterator.next();
      fixture.notify("item/completed", {
        threadId: "another-thread",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "foreign final" },
      });
      fixture.notify("turn/completed", {
        threadId: "another-thread",
        turn: { id: "turn-1", status: "completed" },
      });
      fixture.notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "reasoning", summary: ["private"] },
      });
      expect(
        await Promise.race([output.then(() => "event"), Bun.sleep(25).then(() => "none")]),
      ).toBe("none");
      fixture.notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "final answer" },
      });
      expect((await output).value).toMatchObject({
        type: "execution.output",
        parts: [{ kind: "text", text: "final answer" }],
      });
      const completed = iterator.next();
      fixture.notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      expect((await completed).value).toMatchObject({
        type: "execution.completed",
        finalParts: [{ kind: "text", text: "final answer" }],
      });
      abort.abort();
      await adapter.stop({ reason: "shutdown" });
      expect((await iterator.next()).done).toBe(true);
      await expect(adapter.deliver(delivery())).rejects.toThrow("runtime adapter stopped");
      fixture.close();
    });

    test("checks the binding immediately before submission without resuming a second session", async () => {
      const fixture = await create();
      let checks = 0;
      await fixture.adapter.start({
        ...fixture.context,
        assertBindingFence: async () => {
          checks++;
          expect(fixture.methods).toContain("thread/read");
          expect(fixture.methods).not.toContain("turn/start");
          return { valid: false, reason: "stale" };
        },
      });
      expect(await fixture.adapter.deliver(delivery())).toMatchObject({
        outcome: "rejected",
        reason: "stale-binding",
      });
      expect(checks).toBe(1);
      expect(fixture.methods).not.toContain("thread/resume");
      expect(fixture.methods).not.toContain("turn/start");
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("defers dormant, blocked, unknown, and foreign-route sessions without fallback", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      for (const [status, reason] of [
        ["notLoaded", "dormant"],
        ["waitingOnApproval", "local-input"],
        ["waitingOnUserInput", "local-input"],
        ["future-status", "unsupported-active-state"],
      ]) {
        fixture.setStatus(status);
        expect(await fixture.adapter.deliver(delivery())).toMatchObject({
          outcome: "deferred",
          reason,
        });
      }
      const request = delivery();
      expect(
        await fixture.adapter.deliver({
          ...request,
          target: {
            ...request.target,
            session: { ...request.target.session, installationId: "ins_foreign" },
          },
        }),
      ).toMatchObject({ outcome: "deferred", reason: "route-unavailable" });
      expect(fixture.methods).not.toContain("thread/resume");
      expect(mutations(fixture.methods)).toEqual([]);
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("treats malformed successful admission responses as ambiguous, not rejected", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      fixture.failNext("turn/start", "malformed");
      expect(await fixture.adapter.deliver(delivery())).toMatchObject({
        outcome: "acceptance-unknown",
      });
      expect(mutations(fixture.methods)).toEqual(["turn/start"]);
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("retries post-acceptance observation without resubmitting input", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      fixture.failNext("thread/resume", "overload");
      expect(await fixture.adapter.deliver(delivery())).toMatchObject({ outcome: "accepted" });
      await waitForMethodCount(fixture.methods, "thread/resume", 2);
      expect(mutations(fixture.methods)).toEqual(["turn/start"]);
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("reconciles exact markers and leaves missing or conflicting evidence inconclusive", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      const request: RuntimeReconcileRequest = {
        deliveryId: "int_conformance",
        target: delivery().target,
        payloadHash: "payload-hash",
        reconciliationToken: "thread-1:int_conformance",
      };
      expect(
        await fixture.adapter.reconcile({ ...request, reconciliationToken: "invalid" }),
      ).toMatchObject({ outcome: "inconclusive" });
      expect(await fixture.adapter.reconcile(request)).toMatchObject({ outcome: "inconclusive" });
      fixture.setHistoryDelivery("int_conformance");
      expect(await fixture.adapter.reconcile(request)).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-history", relationship: "unknown" },
      });
      expect(
        await fixture.adapter.reconcile({ ...request, payloadHash: "conflict" }),
      ).toMatchObject({ outcome: "inconclusive" });
      fixture.failNext("thread/read", "overload");
      expect(await fixture.adapter.reconcile(request)).toMatchObject({
        outcome: "inconclusive",
        operatorActionRequired: true,
      });
      expect(mutations(fixture.methods)).toEqual([]);
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("reconnects without duplicate delivery and never equates tracking with ownership", async () => {
      const fixture = await create(),
        { adapter, methods } = fixture;
      await adapter.start(fixture.context);
      const abort = new AbortController(),
        iterator = adapter.observe(abort.signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ state: "online" });
      fixture.disconnect();
      expect((await iterator.next()).value).toMatchObject({ state: "offline" });
      expect(await adapter.deliver(delivery())).toMatchObject({
        outcome: "deferred",
        reason: "offline",
      });
      expect(mutations(methods)).toEqual([]);
      await adapter.start(fixture.context);
      expect((await iterator.next()).value).toMatchObject({ state: "online" });
      expect(await adapter.deliver(delivery())).toMatchObject({ outcome: "accepted" });
      expect(
        await adapter.cancel({
          execution: {
            normalizedId: "exe_one",
            opaqueId: "turn-1",
            session: delivery().target.session,
            bindingId: "bnd_conformance",
            bindingEpoch: 1,
          },
        }),
      ).toMatchObject({ outcome: "rejected", reason: "not-owned" });
      expect(methods).not.toContain("turn/interrupt");
      fixture.notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      expect((await iterator.next()).value).toMatchObject({ type: "execution.completed" });
      expect(
        await Promise.race([iterator.next().then(() => "event"), Bun.sleep(25).then(() => "none")]),
      ).toBe("none");
      abort.abort();
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });

    test("does not repeat loaded sessions across stored pages", async () => {
      const fixture = await create();
      fixture.setSessionPages();
      await fixture.adapter.start(fixture.context);
      const first = await fixture.adapter.listSessions({ limit: 1 }),
        second = await fixture.adapter.listSessions({ limit: 1, cursor: first.nextCursor }),
        third = await fixture.adapter.listSessions({ limit: 1, cursor: second.nextCursor });
      expect(first.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-2"]);
      expect(second.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-1"]);
      expect(third).toEqual({ sessions: [], nextCursor: undefined });
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });
    test("lists loaded sessions that are not persisted yet", async () => {
      const fixture = await create();
      fixture.setLoadedOnly();
      await fixture.adapter.start(fixture.context);
      const page = await fixture.adapter.listSessions({ limit: 1 });
      expect(page.sessions.map((session) => session.session.opaqueId)).toEqual(["thread-3"]);
      expect(page.nextCursor).toBeUndefined();
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });
    test("does not expose unknown runtime source metadata", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      fixture.setSource({ type: "cli", token: "secret-value" });
      const snapshot = await fixture.adapter.inspectSession(delivery().target.session);
      expect(snapshot.attributes.sourceKind).toBe("cli");
      expect(JSON.stringify(snapshot)).not.toContain("secret-value");
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });
    test("honors aborts without hiding a flushed ambiguous write", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      fixture.failNext("thread/read", "hang");
      const readAbort = new AbortController(),
        read = fixture.adapter.inspectSession(delivery().target.session, readAbort.signal);
      readAbort.abort();
      await expect(read).rejects.toThrow(/operation was aborted/i);
      fixture.failNext("turn/start", "hang");
      let flushes = 0;
      const writeAbort = new AbortController(),
        write = fixture.adapter.deliver(
          { ...delivery(), markRequestFlushed: () => flushes++ },
          writeAbort.signal,
        );
      await waitForMethod(fixture.methods, "turn/start");
      writeAbort.abort();
      expect(await write).toMatchObject({ outcome: "acceptance-unknown" });
      expect(flushes).toBe(1);
      expect(fixture.methods).not.toContain("thread/inject_items");
      await fixture.adapter.stop({ reason: "shutdown" });
      fixture.close();
    });
    test("distinguishes overload from lost acceptance and preserves shutdown ambiguity", async () => {
      const fixture = await create();
      await fixture.adapter.start(fixture.context);
      fixture.failNext("turn/start", "overload");
      expect(await fixture.adapter.deliver(delivery())).toMatchObject({
        outcome: "deferred",
        reason: "backpressure",
      });
      fixture.failNext("turn/start", "disconnect");
      expect(await fixture.adapter.deliver(delivery())).toMatchObject({
        outcome: "acceptance-unknown",
      });
      await fixture.adapter.start(fixture.context);
      fixture.failNext("turn/start", "hang");
      const before = fixture.methods.length,
        write = fixture.adapter.deliver(delivery());
      for (
        let index = 0;
        index < 100 && !fixture.methods.slice(before).includes("turn/start");
        index++
      )
        await Bun.sleep(1);
      await fixture.adapter.stop({ reason: "shutdown" });
      expect(await write).toMatchObject({ outcome: "acceptance-unknown" });
      fixture.close();
    });
  });
}

runtimeAdapterConformance("Codex", () => codexFixture());

test("Codex runtime adapter keeps direct delivery disabled until release gates pass", async () => {
  for (const version of SUPPORTED_CODEX_VERSIONS) {
    const fixture = await codexFixture(`codex-cli ${version}`),
      { adapter, context, methods } = fixture;
    await adapter.start(context);
    expect(await adapter.probe()).toMatchObject({
      state: "ready",
      runtimeVersion: version,
      capabilities: { directDelivery: false },
    });
    expect(await adapter.deliver(delivery())).toMatchObject({ outcome: "accepted" });
    expect(mutations(methods)).toEqual(["turn/start"]);
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
    capabilities: { directDelivery: false, cancelOwnedExecution: false },
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
    failures = new Map<string, "overload" | "disconnect" | "hang" | "malformed">();
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
                  result:
                    failure === "malformed"
                      ? {}
                      : response(
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

function delivery(mode: RuntimeDeliveryRequest["mode"] = "direct"): RuntimeDeliveryRequest {
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
    status: status.startsWith("waitingOn")
      ? { type: "active", activeFlags: [status] }
      : { type: status },
    turns: historyDelivery
      ? [
          {
            id: "turn-history",
            items: [
              {
                type: "functionCallOutput",
                name: "receive_agent_message",
                namespace: "acs",
                output: JSON.stringify({
                  deliveryId: historyDelivery,
                  payloadHash: "payload-hash",
                }),
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

async function waitForMethodCount(methods: string[], method: string, count: number) {
  for (
    let index = 0;
    index < 150 && methods.filter((candidate) => candidate === method).length < count;
    index++
  )
    await Bun.sleep(10);
  expect(methods.filter((candidate) => candidate === method)).toHaveLength(count);
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
