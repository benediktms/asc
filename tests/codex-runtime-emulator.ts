import { createHash } from "node:crypto";

type ThreadState = "active" | "idle" | "notLoaded" | "offline";

interface RecordedDelivery {
  readonly threadId: string;
  readonly turnId?: string;
  readonly envelope: Record<string, unknown>;
}

interface TimelineEntry {
  readonly event: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly deliveryId?: string;
}

export function createCodexRuntimeEmulator(path: string, threadIds: readonly string[]) {
  const buffers = new WeakMap<object, Buffer>(),
    states = new Map<string, ThreadState>(),
    turns = new Map<string, Array<{ id: string; items: unknown[] }>>(),
    deliveries = new Array<RecordedDelivery>(),
    timeline = new Array<TimelineEntry>(),
    clientResponses = new Array<Record<string, unknown>>();
  let activeSocket: { write(data: string | Buffer): number; end(error?: Error): void } | undefined,
    nextTurn = 1,
    nextServerRequest = 1,
    dropNextTurnStart = false;
  for (const threadId of threadIds) {
    states.set(threadId, "idle");
    turns.set(threadId, []);
  }

  const server = Bun.listen({
    unix: path,
    socket: {
      open() {},
      data(socket, data) {
        const bytes = Buffer.from(data),
          text = bytes.toString();
        if (text.startsWith("GET ")) {
          const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.at(1);
          if (!key) throw new Error("missing WebSocket key");
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          activeSocket = socket;
          return;
        }
        let pending = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), bytes]);
        for (;;) {
          const frame = clientFrame(pending);
          if (!frame) break;
          pending = pending.subarray(frame.consumed);
          if (!frame.text) continue;
          const message = record(JSON.parse(frame.text));
          if ("id" in message && !("method" in message)) {
            clientResponses.push(message);
            continue;
          }
          if (typeof message.id !== "number" || typeof message.method !== "string") continue;
          const params = isRecord(message.params) ? message.params : {},
            response = codexResponse(message.method, params);
          if (response.error)
            socket.write(serverFrame(JSON.stringify({ id: message.id, error: response.error })));
          else if (message.method === "turn/start" && dropNextTurnStart) {
            dropNextTurnStart = false;
            timeline.push({
              event: "turn/start.response-dropped",
              threadId: string(params.threadId),
            });
            socket.end();
          } else {
            socket.write(serverFrame(JSON.stringify({ id: message.id, result: response.result })));
            if (message.method === "turn/start") {
              const delivery = deliveries.at(-1);
              if (delivery?.turnId)
                queueMicrotask(() => {
                  notify("turn/started", {
                    threadId: delivery.threadId,
                    turn: { id: delivery.turnId },
                  });
                  notify("thread/status/changed", {
                    threadId: delivery.threadId,
                    status: { type: "active" },
                  });
                });
            }
          }
        }
        buffers.set(socket, pending);
      },
      close() {
        activeSocket = undefined;
      },
      error() {},
    },
  });

  function codexResponse(method: string, params: Record<string, unknown>) {
    if (method === "initialize") return success({ userAgent: "codex-cli 0.153.2" });
    if (method === "thread/list")
      return success({
        data: [...states.entries()]
          .filter((entry) => entry[1] !== "offline")
          .map(([threadId]) => thread(threadId)),
        nextCursor: null,
      });
    if (method === "thread/loaded/list")
      return success({
        data: [...states.entries()]
          .filter((entry) => entry[1] !== "notLoaded" && entry[1] !== "offline")
          .map((entry) => entry[0]),
        nextCursor: null,
      });
    if (method === "thread/read") {
      const threadId = string(params.threadId);
      if (states.get(threadId) === "offline" || !states.has(threadId))
        return failure(-32602, "thread not found");
      return success({ thread: thread(threadId, params.includeTurns === true) });
    }
    if (method === "thread/resume") {
      const threadId = string(params.threadId);
      if (states.get(threadId) === "notLoaded") states.set(threadId, "idle");
      return success({});
    }
    if (method === "thread/inject_items") {
      const threadId = string(params.threadId),
        items = array(params.items);
      for (const item of items) captureEnvelope(threadId, item);
      timeline.push({ event: "thread/inject_items", threadId });
      return success({});
    }
    if (method === "turn/start") return success(recordTurn(params));
    if (method === "turn/interrupt") {
      const threadId = string(params.threadId),
        turnId = string(params.turnId);
      queueMicrotask(() => finishTurn(turnId, "interrupted"));
      timeline.push({ event: "turn/interrupt", threadId, turnId });
      return success({});
    }
    return success({});
  }

  function recordTurn(params: Record<string, unknown>) {
    const threadId = string(params.threadId),
      turnId = `turn-${nextTurn++}`,
      toolOutput = record(params.toolOutput),
      envelope = record(JSON.parse(string(toolOutput.output)));
    states.set(threadId, "active");
    const threadTurns = turns.get(threadId);
    if (!threadTurns) throw new Error("unknown thread");
    threadTurns.push({
      id: turnId,
      items: [
        {
          type: "functionCallOutput",
          name: toolOutput.name,
          namespace: toolOutput.namespace,
          output: toolOutput.output,
        },
      ],
    });
    deliveries.push({ threadId, turnId, envelope });
    timeline.push({
      event: "turn/start",
      threadId,
      turnId,
      deliveryId: optionalString(envelope.deliveryId),
    });
    return { turn: { id: turnId } };
  }

  function captureEnvelope(threadId: string, value: unknown) {
    if (!isRecord(value) || typeof value.output !== "string") return;
    try {
      const envelope = record(JSON.parse(value.output));
      deliveries.push({ threadId, envelope });
    } catch {}
  }

  function thread(threadId: string, includeTurns = false) {
    return {
      id: threadId,
      preview: threadId,
      name: threadId,
      updatedAt: Date.now(),
      cwd: "/workspace/e2e",
      cliVersion: "0.153.2",
      source: "test",
      status: { type: states.get(threadId) ?? "idle" },
      ...(includeTurns ? { turns: turns.get(threadId) ?? [] } : {}),
    };
  }

  function notify(method: string, params: unknown) {
    activeSocket?.write(serverFrame(JSON.stringify({ method, params })));
  }

  function finishTurn(
    turnId: string,
    status: "completed" | "interrupted" = "completed",
    text?: string,
  ) {
    const delivery = deliveries.find((item) => item.turnId === turnId);
    if (!delivery) throw new Error(`unknown turn ${turnId}`);
    if (text)
      notify("item/completed", {
        threadId: delivery.threadId,
        turnId,
        item: { type: "agentMessage", text },
      });
    states.set(delivery.threadId, "idle");
    notify("turn/completed", { threadId: delivery.threadId, turn: { id: turnId, status } });
    notify("thread/status/changed", {
      threadId: delivery.threadId,
      status: { type: "idle" },
    });
    timeline.push({ event: `turn/${status}`, threadId: delivery.threadId, turnId });
  }

  return {
    server,
    deliveries,
    clientResponses,
    timeline: () => timeline.map((entry) => ({ ...entry })),
    state(threadId: string, state: ThreadState) {
      states.set(threadId, state);
      if (state !== "offline")
        notify("thread/status/changed", { threadId, status: { type: state } });
      timeline.push({ event: `thread/${state}`, threadId });
    },
    finishTurn,
    requestApproval(turnId: string) {
      const delivery = deliveries.find((item) => item.turnId === turnId);
      if (!delivery) throw new Error(`unknown turn ${turnId}`);
      const requestId = `approval-${nextServerRequest++}`;
      activeSocket?.write(
        serverFrame(
          JSON.stringify({
            id: requestId,
            method: "item/commandExecution/requestApproval",
            params: { threadId: delivery.threadId, turnId, isBlocking: true },
          }),
        ),
      );
      timeline.push({ event: "approval/requested", threadId: delivery.threadId, turnId });
      return requestId;
    },
    dropResponseAfterNextTurnStart() {
      dropNextTurnStart = true;
    },
  };
}

function clientFrame(frame: Buffer) {
  if (frame.length < 6) return undefined;
  const lengthCode = byte(frame, 1) & 0x7f,
    offset = lengthCode === 126 ? 4 : lengthCode === 127 ? 10 : 2,
    length =
      lengthCode === 126
        ? frame.readUInt16BE(2)
        : lengthCode === 127
          ? Number(frame.readBigUInt64BE(2))
          : lengthCode;
  if (frame.length < offset + 4 + length) return undefined;
  const mask = frame.subarray(offset, offset + 4),
    payload = frame.subarray(offset + 4, offset + 4 + length);
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

function success(result: unknown) {
  return { result, error: undefined };
}
function failure(code: number, message: string) {
  return { result: undefined, error: { code, message } };
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
function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
