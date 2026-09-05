import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { telemetry } from "../../observability/src/index";
import type { ThreadInjectItemsParams } from "../../codex-protocol-generated/src/v2/ThreadInjectItemsParams";
import type { ThreadListParams } from "../../codex-protocol-generated/src/v2/ThreadListParams";
import type { ThreadReadParams } from "../../codex-protocol-generated/src/v2/ThreadReadParams";
import type { ThreadStartParams } from "../../codex-protocol-generated/src/v2/ThreadStartParams";
import type { TurnStartParams } from "../../codex-protocol-generated/src/v2/TurnStartParams";

export type CodexThread = {
  id: string;
  preview: string;
  name: string | null;
  updatedAt: number;
  cwd: string;
  cliVersion: string;
  source: unknown;
  status: { type: string };
};

type RpcId = number | string;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class CodexAppServerClient {
  private socket?: Bun.Socket;
  private nextId = 1;
  private pending = new Map<
    RpcId,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: Timer;
      cleanup?: () => void;
    }
  >();
  private bytes = Buffer.alloc(0);
  private upgraded = false;
  private fragments: Buffer[] = [];
  private connectPromise?: Promise<void>;
  readonly notifications = new EventTarget();
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (id: RpcId, method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10_000,
    readonly connectTimeoutMs = 1_000,
    readonly maxInFlightRequests = 128,
  ) {}

  async start() {
    await this.connect();
    const initialized = record(
      await this.request("initialize", {
        clientInfo: {
          name: "agent_communications_service",
          title: "Agent Communications Service",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      }),
    );
    this.notify("initialized", {});
    return { userAgent: stringField(initialized, "userAgent") };
  }

  async loadedThreads(cursor: string | null = null, signal?: AbortSignal) {
    const response = record(
      await this.request("thread/loaded/list", { cursor, limit: 100 }, undefined, signal),
    );
    return {
      data: stringArray(response.data),
      nextCursor: nullableString(response.nextCursor),
    };
  }
  async listThreads(params: ThreadListParams = {}, signal?: AbortSignal) {
    const response = record(await this.request("thread/list", params, undefined, signal));
    if (!Array.isArray(response.data)) throw new Error("invalid app-server thread list");
    return {
      data: response.data.map(decodeThread),
      nextCursor: nullableString(response.nextCursor),
    };
  }
  async readThread(params: ThreadReadParams, signal?: AbortSignal) {
    const response = record(await this.request("thread/read", params, undefined, signal));
    return { thread: decodeThread(response.thread) };
  }
  async findDeliveryMarker(threadId: string, deliveryId: string, signal?: AbortSignal) {
    const response = record(
      await this.request("thread/read", { threadId, includeTurns: true }, undefined, signal),
    );
    return findDeliveryMarker(response.thread, deliveryId);
  }
  async startThread(params: ThreadStartParams) {
    return record(await this.request("thread/start", params));
  }
  async resumeThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.request("thread/resume", { threadId, excludeTurns: true }, undefined, signal);
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }
  async injectItems(
    params: ThreadInjectItemsParams,
    markRequestFlushed?: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("thread/inject_items", params, markRequestFlushed, signal);
  }
  async startTurn(params: TurnStartParams, markRequestFlushed?: () => void, signal?: AbortSignal) {
    const response = record(await this.request("turn/start", params, markRequestFlushed, signal)),
      turn = record(response.turn);
    return { turn: { id: stringField(turn, "id") } };
  }
  async interruptTurn(threadId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, () => {}, signal);
  }

  async request(
    method: string,
    params: unknown,
    markRequestFlushed?: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.upgraded) throw new Error("app-server client is not connected");
    if (this.pending.size >= this.maxInFlightRequests)
      throw new Error("app-server overloaded: maximum in-flight requests reached");
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        pending?.cleanup?.();
        this.pending.delete(id);
        reject(new Error(`app-server timeout: ${method}`));
      }, this.timeoutMs);
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pending.delete(id);
        reject(
          markRequestFlushed
            ? new Error("app-server request aborted after write")
            : abortError(signal),
        );
      };
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: signal ? () => signal.removeEventListener("abort", abort) : undefined,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      markRequestFlushed?.();
      this.sendFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      pending?.cleanup?.();
      this.pending.delete(id);
      throw error;
    }
    return telemetry.trace("codex.rpc", () => promise);
  }

  notify(method: string, params: unknown) {
    if (!this.upgraded) throw new Error("app-server client is not connected");
    this.sendFrame(0x1, Buffer.from(JSON.stringify({ method, params })));
  }

  close() {
    if (this.socket) {
      try {
        this.sendFrame(0x8, Buffer.alloc(0));
      } catch {}
      this.socket.end();
    }
    this.failPending(new Error("app-server connection closed"));
    this.upgraded = false;
  }

  private connect() {
    if (this.connectPromise) return this.connectPromise;
    if (!existsSync(this.socketPath))
      return Promise.reject(new Error("app-server socket unavailable"));
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expected = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64"),
        timer = setTimeout(() => {
          this.connectPromise = undefined;
          reject(new Error("app-server connection timeout"));
          this.socket?.end();
        }, this.connectTimeoutMs);
      Bun.connect({
        unix: this.socketPath,
        socket: {
          open: (socket) => {
            this.socket = socket;
            socket.write(
              `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            );
          },
          data: (_socket, data) => {
            this.bytes = Buffer.concat([this.bytes, Buffer.from(data)]);
            if (!this.upgraded) {
              const end = this.bytes.indexOf("\r\n\r\n");
              if (end < 0) return;
              const headers = this.bytes.subarray(0, end).toString();
              this.bytes = this.bytes.subarray(end + 4);
              if (
                !headers.startsWith("HTTP/1.1 101") ||
                !new RegExp(
                  `sec-websocket-accept:\\s*${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                  "i",
                ).test(headers)
              ) {
                clearTimeout(timer);
                reject(
                  new Error(`app-server websocket upgrade failed: ${headers.split("\r\n")[0]}`),
                );
                return;
              }
              this.upgraded = true;
              clearTimeout(timer);
              resolve();
            }
            this.readFrames();
          },
          close: () => {
            clearTimeout(timer);
            reject(new Error("app-server connection closed"));
            this.upgraded = false;
            this.connectPromise = undefined;
            this.failPending(new Error("app-server connection closed"));
            this.onClose?.();
          },
          error: (_socket, error) => {
            clearTimeout(timer);
            reject(error);
            this.failPending(error);
          },
        },
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return this.connectPromise;
  }

  private sendFrame(opcode: number, payload: Buffer) {
    if (!this.socket) throw new Error("app-server socket unavailable");
    const mask = randomBytes(4),
      size = payload.length,
      extra = size < 126 ? 0 : size <= 0xffff ? 2 : 8;
    const frame = Buffer.alloc(2 + extra + 4 + size);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (extra ? (extra === 2 ? 126 : 127) : size);
    if (extra === 2) frame.writeUInt16BE(size, 2);
    else if (extra === 8) frame.writeBigUInt64BE(BigInt(size), 2);
    const offset = 2 + extra;
    mask.copy(frame, offset);
    for (let index = 0; index < size; index++)
      frame[offset + 4 + index] = byte(payload, index) ^ byte(mask, index % 4);
    this.socket.write(frame);
  }

  private readFrames() {
    while (this.bytes.length >= 2) {
      const first = byte(this.bytes, 0),
        second = byte(this.bytes, 1),
        masked = Boolean(second & 0x80);
      let length = second & 0x7f,
        offset = 2;
      if (length === 126) {
        if (this.bytes.length < 4) return;
        length = this.bytes.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.bytes.length < 10) return;
        const large = this.bytes.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("app-server frame too large");
        length = Number(large);
        offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (this.bytes.length < offset + maskOffset + length) return;
      let payload = Buffer.from(
        this.bytes.subarray(offset + maskOffset, offset + maskOffset + length),
      );
      if (masked) {
        const mask = this.bytes.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((value, index) => value ^ byte(mask, index % 4)));
      }
      this.bytes = this.bytes.subarray(offset + maskOffset + length);
      const opcode = first & 0x0f,
        final = Boolean(first & 0x80);
      if (opcode === 0x8) {
        this.socket?.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1) this.fragments.push(payload);
      if (final && this.fragments.length) {
        const message = Buffer.concat(this.fragments).toString();
        this.fragments = [];
        this.receive(JSON.parse(message));
      }
    }
  }

  private receive(message: RpcMessage) {
    if (message.id !== undefined && message.method) {
      this.onRequest?.(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error)
        pending.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data,
          }),
        );
      else pending.resolve(message.result);
    } else if (message.method) {
      this.notifications.dispatchEvent(new CustomEvent(message.method, { detail: message.params }));
      this.onNotification?.(message.method, message.params);
    }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortError(signal: AbortSignal | undefined) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid app-server response");
  return value;
}
function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("invalid app-server frame");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`invalid app-server ${key}`);
  return field;
}
function nullableString(value: unknown) {
  if (value !== null && value !== undefined && typeof value !== "string")
    throw new Error("invalid app-server cursor");
  return value ?? null;
}
function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("invalid app-server string list");
  return value;
}
function decodeThread(value: unknown): CodexThread {
  const thread = record(value),
    name = thread.name,
    updatedAt = thread.updatedAt,
    status = record(thread.status);
  if (name !== null && typeof name !== "string") throw new Error("invalid app-server thread name");
  if (typeof updatedAt !== "number") throw new Error("invalid app-server thread timestamp");
  return {
    id: stringField(thread, "id"),
    preview: stringField(thread, "preview"),
    name,
    updatedAt,
    cwd: stringField(thread, "cwd"),
    cliVersion: stringField(thread, "cliVersion"),
    source: thread.source,
    status: { type: stringField(status, "type") },
  };
}

function findDeliveryMarker(value: unknown, deliveryId: string) {
  const thread = record(value);
  if (!Array.isArray(thread.turns)) throw new Error("invalid app-server thread turns");
  for (const turnValue of thread.turns) {
    const turn = record(turnValue);
    if (!Array.isArray(turn.items)) throw new Error("invalid app-server turn items");
    for (const itemValue of turn.items) {
      const item = record(itemValue);
      if (
        item.type !== "functionCallOutput" ||
        item.name !== "receive_agent_message" ||
        item.namespace !== "acs" ||
        typeof item.output !== "string"
      )
        continue;
      try {
        const envelope: unknown = JSON.parse(item.output);
        if (isRecord(envelope) && envelope.deliveryId === deliveryId)
          return { turnId: stringField(turn, "id") };
      } catch {}
    }
  }
}
