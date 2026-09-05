import { telemetry } from "../../observability/src/index";
import {
  CodexAppServerError,
  CodexAppServerFailureKind,
  type CodexThreadDto,
  type CodexThreadInjectItemsRequestDto,
  type CodexThreadListRequestDto,
  type CodexThreadReadRequestDto,
  type CodexThreadStartRequestDto,
  type CodexTurnStartRequestDto,
  type CodexWireId,
} from "../../../contracts/codex-app-server-boundary";
import { json, UnixSocketWebSocketTransport } from "./app-server-transport";

export class CodexAppServerClient {
  private transport: UnixSocketWebSocketTransport;
  private incomingAbort = new AbortController();
  private nextId = 1;
  private pending = new Map<
    CodexWireId,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: Timer;
      requestFlushed: boolean;
      cleanup?: () => void;
      onResult?: (value: unknown) => void;
    }
  >();
  private connected = false;
  readonly notifications = new EventTarget();
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (id: CodexWireId, method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10_000,
    readonly connectTimeoutMs = 1_000,
    readonly maxInFlightRequests = 128,
  ) {
    this.transport = new UnixSocketWebSocketTransport(socketPath, connectTimeoutMs);
  }

  async start() {
    try {
      await this.transport.connect();
    } catch (error) {
      throw appServerError(CodexAppServerFailureKind.ConnectionUnavailable, false, error);
    }
    this.connected = true;
    void this.receive();
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
    await this.notify("initialized", {});
    return { userAgent: stringField(initialized, "userAgent") };
  }

  async loadedThreads(cursor: string | null = null, signal?: AbortSignal, limit = 100) {
    const response = record(
      await this.request("thread/loaded/list", { cursor, limit }, undefined, signal),
    );
    return {
      data: stringArray(response.data),
      nextCursor: nullableString(response.nextCursor),
    };
  }
  async listThreads(params: CodexThreadListRequestDto = {}, signal?: AbortSignal) {
    const response = record(await this.request("thread/list", params, undefined, signal));
    if (!Array.isArray(response.data)) throw new Error("invalid app-server thread list");
    return {
      data: response.data.map(decodeThread),
      nextCursor: nullableString(response.nextCursor),
    };
  }
  async readThread(params: CodexThreadReadRequestDto, signal?: AbortSignal) {
    const response = record(await this.request("thread/read", params, undefined, signal));
    return { thread: decodeThread(response.thread) };
  }
  async findDeliveryMarker(threadId: string, deliveryId: string, signal?: AbortSignal) {
    const response = record(
      await this.request("thread/read", { threadId, includeTurns: true }, undefined, signal),
    );
    return findDeliveryMarker(response.thread, deliveryId);
  }
  async startThread(params: CodexThreadStartRequestDto) {
    return record(await this.request("thread/start", params));
  }
  async resumeThread(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.request("thread/resume", { threadId, excludeTurns: true }, undefined, signal);
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }
  async injectItems(
    params: CodexThreadInjectItemsRequestDto,
    markRequestFlushed?: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("thread/inject_items", params, markRequestFlushed, signal);
  }
  async startTurn(
    params: CodexTurnStartRequestDto,
    markRequestFlushed?: () => void,
    signal?: AbortSignal,
    onStarted?: (turnId: string) => void,
  ) {
    const response = record(
        await this.request("turn/start", params, markRequestFlushed, signal, (value) => {
          const turn = record(record(value).turn);
          onStarted?.(stringField(turn, "id"));
        }),
      ),
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
    onResult?: (value: unknown) => void,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.connected)
      throw appServerError(
        CodexAppServerFailureKind.ConnectionUnavailable,
        false,
        new Error("app-server client is not connected"),
      );
    if (this.pending.size >= this.maxInFlightRequests)
      throw appServerError(
        CodexAppServerFailureKind.Backpressure,
        false,
        new Error("app-server overloaded: maximum in-flight requests reached"),
      );
    const id = this.nextId++;
    let flushed = false,
      writeSettled = false;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        pending?.cleanup?.();
        this.pending.delete(id);
        reject(
          appServerError(
            CodexAppServerFailureKind.RequestTimedOut,
            pending?.requestFlushed ?? false,
            new Error(`app-server timeout: ${method}`),
          ),
        );
      }, this.timeoutMs);
      const abort = () => {
        if (!writeSettled) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pending.delete(id);
        reject(
          flushed && markRequestFlushed
            ? appServerError(
                CodexAppServerFailureKind.RequestAbortedAfterWrite,
                true,
                new Error("app-server request aborted after write"),
              )
            : abortError(signal),
        );
      };
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        requestFlushed: false,
        cleanup: signal ? () => signal.removeEventListener("abort", abort) : undefined,
        onResult,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      const receipt = await this.transport.write({ id, method, params: json(params) }, signal);
      flushed = receipt.flushed;
      const writtenRequest = this.pending.get(id);
      if (writtenRequest) writtenRequest.requestFlushed = flushed;
      writeSettled = true;
      if (flushed)
        try {
          markRequestFlushed?.();
        } catch {
          throw appServerError(
            CodexAppServerFailureKind.RequestMarkerFailedAfterWrite,
            true,
            new Error("app-server request marker failed after write"),
          );
        }
      if (signal?.aborted) this.pending.get(id)?.cleanup?.();
      if (signal?.aborted) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            flushed && markRequestFlushed
              ? appServerError(
                  CodexAppServerFailureKind.RequestAbortedAfterWrite,
                  true,
                  new Error("app-server request aborted after write"),
                )
              : abortError(signal),
          );
        }
      }
    } catch (error) {
      writeSettled = true;
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      pending?.cleanup?.();
      this.pending.delete(id);
      if (error instanceof CodexAppServerError || (signal?.aborted && !flushed)) throw error;
      throw appServerError(
        flushed
          ? CodexAppServerFailureKind.ConnectionLost
          : CodexAppServerFailureKind.ConnectionUnavailable,
        flushed,
        error,
      );
    }
    return telemetry.trace("codex.rpc", () => promise);
  }

  async notify(method: string, params: unknown) {
    if (!this.connected)
      throw appServerError(
        CodexAppServerFailureKind.ConnectionUnavailable,
        false,
        new Error("app-server client is not connected"),
      );
    await this.transport.write({ method, params: json(params) });
  }

  close() {
    this.incomingAbort.abort();
    void this.transport.close();
    this.failPending(new Error("app-server connection closed"));
    this.connected = false;
  }

  private async receive() {
    try {
      for await (const message of this.transport.incoming(this.incomingAbort.signal)) {
        if ("id" in message && "method" in message) {
          this.onRequest?.(message.id, message.method, message.params);
          continue;
        }
        if ("id" in message) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.cleanup?.();
          if ("error" in message)
            pending.reject(
              appServerError(
                remoteFailureKind(message.error.message),
                true,
                new Error(message.error.message),
                message.error.code,
              ),
            );
          else
            try {
              pending.onResult?.(message.result);
              pending.resolve(message.result);
            } catch (error) {
              pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
          continue;
        }
        this.notifications.dispatchEvent(
          new CustomEvent(message.method, { detail: message.params }),
        );
        this.onNotification?.(message.method, message.params);
      }
    } finally {
      if (!this.incomingAbort.signal.aborted) {
        this.connected = false;
        this.failPending(new Error("app-server connection closed"));
        this.onClose?.();
      }
    }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(
        appServerError(
          pending.requestFlushed
            ? CodexAppServerFailureKind.ConnectionLost
            : CodexAppServerFailureKind.ConnectionUnavailable,
          pending.requestFlushed,
          error,
        ),
      );
    }
    this.pending.clear();
  }
}

function appServerError(
  kind: CodexAppServerFailureKind,
  requestFlushed: boolean,
  error: unknown,
  rpcCode?: number,
) {
  return new CodexAppServerError(errorMessage(error), { kind, requestFlushed, rpcCode });
}

function remoteFailureKind(message: string) {
  if (/overload|queue.*full|too many/i.test(message)) return CodexAppServerFailureKind.Backpressure;
  if (/not initialized/i.test(message)) return CodexAppServerFailureKind.NotInitialized;
  if (/not running/i.test(message)) return CodexAppServerFailureKind.NotRunning;
  if (/not found|invalid thread/i.test(message)) return CodexAppServerFailureKind.SessionNotFound;
  if (/method not found|unsupported method/i.test(message))
    return CodexAppServerFailureKind.UnsupportedMethod;
  if (/invalid (?:payload|params|request)/i.test(message))
    return CodexAppServerFailureKind.InvalidPayload;
  return CodexAppServerFailureKind.Unknown;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
function decodeThread(value: unknown): CodexThreadDto {
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
