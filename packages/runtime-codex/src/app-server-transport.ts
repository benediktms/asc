import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  CodexAppServerTransport,
  CodexJson,
  CodexTransportWriteReceipt,
  CodexWireFailure,
  CodexWireInbound,
  CodexWireNotification,
  CodexWireRequest,
  CodexWireSuccess,
} from "../../../contracts/codex-app-server-boundary";

export class UnixSocketWebSocketTransport implements CodexAppServerTransport {
  get kind(): "unix-websocket" {
    return "unix-websocket";
  }
  private socket?: Bun.Socket;
  private bytes = Buffer.alloc(0);
  private connected = false;
  private fragments: Buffer[] = [];
  private connectPromise?: Promise<void>;
  private messages: CodexWireInbound[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;

  constructor(
    readonly socketPath: string,
    readonly connectTimeoutMs = 1_000,
  ) {}

  connect(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.connectPromise) return this.connectPromise;
    if (!existsSync(this.socketPath))
      return Promise.reject(new Error("app-server socket unavailable"));
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const key = randomBytes(16).toString("base64"),
        expected = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64"),
        abort = () => {
          reject(abortError(signal));
          this.socket?.end();
        },
        timer = setTimeout(() => {
          this.connectPromise = undefined;
          reject(new Error("app-server connection timeout"));
          this.socket?.end();
        }, this.connectTimeoutMs),
        cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
      signal?.addEventListener("abort", abort, { once: true });
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
            if (!this.connected) {
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
                cleanup();
                reject(
                  new Error(`app-server websocket upgrade failed: ${headers.split("\r\n")[0]}`),
                );
                return;
              }
              this.connected = true;
              cleanup();
              resolve();
            }
            this.readFrames();
          },
          close: () => {
            cleanup();
            reject(new Error("app-server connection closed"));
            this.connected = false;
            this.connectPromise = undefined;
            this.ended = true;
            this.wake();
          },
          error: (_socket, error) => {
            cleanup();
            reject(error);
            this.ended = true;
            this.wake();
          },
        },
      }).catch((error) => {
        cleanup();
        reject(error);
      });
    });
    return this.connectPromise;
  }

  async write(
    message: CodexWireRequest | CodexWireNotification | CodexWireSuccess | CodexWireFailure,
    signal?: AbortSignal,
  ): Promise<CodexTransportWriteReceipt> {
    signal?.throwIfAborted();
    if (!this.connected) throw new Error("app-server client is not connected");
    this.sendFrame(0x1, Buffer.from(JSON.stringify(message)));
    return { flushed: true, writtenAt: new Date().toISOString() };
  }

  async *incoming(signal: AbortSignal): AsyncIterable<CodexWireInbound> {
    while (!signal.aborted) {
      const message = this.messages.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        const abort = () => resolve();
        signal.addEventListener("abort", abort, { once: true });
        this.waiters.push(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
  }

  async close() {
    if (this.socket) {
      try {
        this.sendFrame(0x8, Buffer.alloc(0));
      } catch {}
      this.socket.end();
    }
    this.connected = false;
    this.ended = true;
    this.wake();
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
        const message: unknown = JSON.parse(Buffer.concat(this.fragments).toString());
        this.fragments = [];
        this.messages.push(wireMessage(message));
        this.wake();
      }
    }
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

function wireMessage(value: unknown): CodexWireInbound {
  if (!isRecord(value)) throw new Error("invalid app-server message");
  const id = value.id,
    method = value.method,
    params = value.params === undefined ? undefined : json(value.params);
  if (typeof method === "string") {
    if (id === undefined) return { method, params };
    if (typeof id === "string" || typeof id === "number") return { id, method, params };
  }
  if (typeof id !== "string" && typeof id !== "number")
    throw new Error("invalid app-server message id");
  if (value.error !== undefined) {
    if (!isRecord(value.error)) throw new Error("invalid app-server error");
    const code = value.error.code,
      message = value.error.message;
    if (typeof code !== "number" || typeof message !== "string")
      throw new Error("invalid app-server error");
    return {
      id,
      error: {
        code,
        message,
        data: value.error.data === undefined ? undefined : json(value.error.data),
      },
    };
  }
  return { id, result: json(value.result) };
}

export function json(value: unknown): CodexJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .map(([key, item]) => [key, json(item)]),
    );
  throw new Error("invalid app-server JSON value");
}

function abortError(signal: AbortSignal | undefined) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}
function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("invalid app-server frame");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
