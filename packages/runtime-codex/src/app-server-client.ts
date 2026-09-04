import { createHash, randomBytes } from "node:crypto";
import type { InitializeResponse } from "../../codex-protocol-generated/src/InitializeResponse";
import type { ThreadInjectItemsParams } from "../../codex-protocol-generated/src/v2/ThreadInjectItemsParams";
import type { ThreadListParams } from "../../codex-protocol-generated/src/v2/ThreadListParams";
import type { ThreadListResponse } from "../../codex-protocol-generated/src/v2/ThreadListResponse";
import type { ThreadLoadedListResponse } from "../../codex-protocol-generated/src/v2/ThreadLoadedListResponse";
import type { ThreadReadParams } from "../../codex-protocol-generated/src/v2/ThreadReadParams";
import type { ThreadReadResponse } from "../../codex-protocol-generated/src/v2/ThreadReadResponse";
import type { ThreadStartParams } from "../../codex-protocol-generated/src/v2/ThreadStartParams";
import type { ThreadStartResponse } from "../../codex-protocol-generated/src/v2/ThreadStartResponse";
import type { TurnStartParams } from "../../codex-protocol-generated/src/v2/TurnStartParams";
import type { TurnStartResponse } from "../../codex-protocol-generated/src/v2/TurnStartResponse";

type RpcId = number;
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
    { resolve(value: unknown): void; reject(error: Error): void; timer: Timer }
  >();
  private bytes = Buffer.alloc(0);
  private upgraded = false;
  private fragments: Buffer[] = [];
  private connectPromise?: Promise<void>;
  readonly notifications = new EventTarget();
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10_000,
  ) {}

  async start(): Promise<InitializeResponse> {
    await this.connect();
    const initialized = await this.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "agent_communications_service",
        title: "Agent Communications Service",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return initialized;
  }

  async loadedThreads(cursor: string | null = null): Promise<ThreadLoadedListResponse> {
    return this.request("thread/loaded/list", { cursor, limit: 100 });
  }
  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.request("thread/list", params);
  }
  async readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request("thread/read", params);
  }
  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params);
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }
  async injectItems(params: ThreadInjectItemsParams): Promise<void> {
    await this.request("thread/inject_items", params);
  }
  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request("turn/start", params);
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.upgraded) throw new Error("app-server client is not connected");
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.sendFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    return promise;
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
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expected = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
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
                reject(
                  new Error(`app-server websocket upgrade failed: ${headers.split("\r\n")[0]}`),
                );
                return;
              }
              this.upgraded = true;
              resolve();
            }
            this.readFrames();
          },
          close: () => {
            this.upgraded = false;
            this.connectPromise = undefined;
            this.failPending(new Error("app-server connection closed"));
            this.onClose?.();
          },
          error: (_socket, error) => {
            reject(error);
            this.failPending(error);
          },
        },
      }).catch(reject);
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
      frame[offset + 4 + index] = payload[index]! ^ mask[index % 4]!;
    this.socket.write(frame);
  }

  private readFrames() {
    while (this.bytes.length >= 2) {
      const first = this.bytes[0]!,
        second = this.bytes[1]!,
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
        payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]!));
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
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
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
      pending.reject(error);
    }
    this.pending.clear();
  }
}
