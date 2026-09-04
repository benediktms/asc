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
import { CodexRuntimeAdapter, TESTED_CODEX_VERSION } from "../packages/runtime-codex/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

type Fixture = {
  adapter: RuntimeAdapter;
  context: RuntimeAdapterContext;
  methods: string[];
  failNext(method: string, failure: "overload" | "disconnect"): void;
  disconnect(): void;
  request(method: string, params: unknown): void;
  setFence(valid: boolean): void;
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
      const iterator = adapter.observe(new AbortController().signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        type: "adapter.connection",
        state: "online",
      });

      fixture.setFence(false);
      expect(await adapter.deliver(delivery())).toMatchObject({
        outcome: "rejected",
        reason: "stale-binding",
      });
      expect(mutations(methods)).toEqual([]);

      fixture.setFence(true);
      const accepted = await adapter.deliver(delivery());
      expect(accepted).toEqual({
        outcome: "accepted",
        acceptedAt: expect.any(String),
        evidence: { scheme: "codex.thread-inject-items.v1", value: "int_conformance" },
      });
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      fixture.setStatus("active");
      expect(await adapter.deliver(delivery("wake_when_idle"))).toMatchObject({
        outcome: "deferred",
        reason: "busy",
      });
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
        reconciliationToken: "token",
      };
      expect((await adapter.reconcile(reconciliation)).outcome).toBe("inconclusive");
      expect((await adapter.reconcile(reconciliation)).outcome).toBe("inconclusive");
      expect(mutations(methods)).toEqual(["thread/inject_items"]);

      fixture.setStatus("idle");
      expect(await adapter.deliver(delivery("wake_when_idle"))).toMatchObject({
        outcome: "accepted",
        execution: { opaqueId: "turn-1" },
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
      fixture.close();
    }, 30_000);

    test("maps a disconnect before delivery to offline without mutation", async () => {
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
      await adapter.stop({ reason: "shutdown" });
      fixture.close();
    });
  });
}

runtimeAdapterConformance("Codex", () => codexFixture());

test("Codex runtime adapter disables mutations for an untested runtime", async () => {
  const fixture = await codexFixture("codex-cli 99.0.0"),
    { adapter, context, methods } = fixture;
  await adapter.start(context);
  expect(await adapter.probe()).toMatchObject({
    state: "incompatible",
    runtimeVersion: "99.0.0",
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
    failures = new Map<string, "overload" | "disconnect">();
  let fence = true,
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
                JSON.stringify({ id: request.id, result: response(method, status, userAgent) }),
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

function response(method: string, status: string, userAgent: string) {
  if (method === "initialize") return { userAgent };
  if (method === "thread/list") return { data: [], nextCursor: null };
  if (method === "thread/read")
    return {
      thread: {
        id: "thread-1",
        preview: "test",
        name: null,
        updatedAt: 1,
        cwd: "/tmp",
        cliVersion: "test",
        source: "test",
        status: { type: status },
      },
    };
  if (method === "turn/start") return { turn: { id: "turn-1" } };
  return {};
}

function mutations(methods: string[]) {
  return methods.filter((method) =>
    ["thread/inject_items", "turn/start", "turn/interrupt"].includes(method),
  );
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
