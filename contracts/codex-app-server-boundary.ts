/**
 * Codex app-server anti-corruption boundary.
 *
 * This file belongs conceptually inside runtime-codex. It MUST NOT be imported
 * by ACS domain, application, A2A, control, or generic MCP packages.
 */

export type CodexWireId = string | number;

export enum CodexAppServerFailureKind {
  Backpressure = "BACKPRESSURE",
  Busy = "BUSY",
  ConnectionLost = "CONNECTION_LOST",
  ConnectionUnavailable = "CONNECTION_UNAVAILABLE",
  InvalidPayload = "INVALID_PAYLOAD",
  NotInitialized = "NOT_INITIALIZED",
  NotRunning = "NOT_RUNNING",
  RequestAbortedAfterWrite = "REQUEST_ABORTED_AFTER_WRITE",
  RequestMarkerFailedAfterWrite = "REQUEST_MARKER_FAILED_AFTER_WRITE",
  RequestTimedOut = "REQUEST_TIMED_OUT",
  SessionNotFound = "SESSION_NOT_FOUND",
  UnsupportedMethod = "UNSUPPORTED_METHOD",
  Unknown = "UNKNOWN",
}

export interface CodexAppServerFailureDto {
  readonly kind: CodexAppServerFailureKind;
  readonly requestFlushed: boolean;
  readonly rpcCode?: number;
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly failure: CodexAppServerFailureDto,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export type CodexJson =
  | null
  | boolean
  | number
  | string
  | CodexJson[]
  | { readonly [key: string]: CodexJson };

export interface CodexThreadDto {
  readonly id: string;
  readonly preview: string;
  readonly name: string | null;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly cliVersion: string;
  readonly source: unknown;
  readonly status: { readonly type: string };
}

export interface CodexThreadListRequestDto {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly sourceKinds?: readonly string[] | null;
  readonly useStateDbOnly?: boolean;
  readonly searchTerm?: string | null;
}

export interface CodexThreadReadRequestDto {
  readonly threadId: string;
  readonly includeTurns?: boolean;
}

export interface CodexThreadStartRequestDto {
  readonly cwd?: string | null;
  readonly ephemeral?: boolean | null;
  readonly approvalPolicy?: "untrusted" | "on-request" | "never" | null;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
}

export interface CodexThreadInjectItemsRequestDto {
  readonly threadId: string;
  readonly items: readonly CodexJson[];
}

export interface CodexTurnStartRequestDto {
  readonly threadId: string;
  readonly input: readonly CodexJson[];
  readonly turnTrigger?: string | null;
  readonly toolOutput?: {
    readonly name: string;
    readonly namespace: string | null;
    readonly output: string;
  } | null;
}

export interface CodexFunctionCallOutputDto {
  readonly type: "function_call_output";
  readonly name: string;
  readonly namespace: string;
  readonly output: string;
}

export interface CodexWireRequest {
  readonly id: CodexWireId;
  readonly method: string;
  readonly params?: CodexJson;
}

export interface CodexWireNotification {
  readonly method: string;
  readonly params?: CodexJson;
}

export interface CodexWireSuccess {
  readonly id: CodexWireId;
  readonly result: CodexJson;
}

export interface CodexWireFailure {
  readonly id: CodexWireId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: CodexJson;
  };
}

export type CodexWireInbound =
  | CodexWireSuccess
  | CodexWireFailure
  | CodexWireNotification
  | CodexWireRequest;

export interface CodexTransportWriteReceipt {
  /**
   * false: transport guarantees no request bytes were handed to the peer.
   * true: loss of the response can create acceptance ambiguity.
   */
  readonly flushed: boolean;
  readonly writtenAt: string;
}

export interface CodexAppServerTransport {
  readonly kind: "unix-websocket" | "stdio-child";

  connect(signal?: AbortSignal): Promise<void>;

  /**
   * Serializes one complete app-server object using the selected framing.
   * The object MUST NOT include a JSON-RPC `jsonrpc` member.
   */
  write(
    message: CodexWireRequest | CodexWireNotification | CodexWireSuccess | CodexWireFailure,
    signal?: AbortSignal,
  ): Promise<CodexTransportWriteReceipt>;

  incoming(signal: AbortSignal): AsyncIterable<CodexWireInbound>;

  close(reason?: string): Promise<void>;
}

export type CodexRpcResult =
  | {
      readonly outcome: "success";
      readonly result: CodexJson;
      readonly requestFlushed: true;
    }
  | {
      readonly outcome: "failure";
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: CodexJson;
      };
      readonly requestFlushed: true;
    }
  | {
      readonly outcome: "transport-failure";
      readonly failure: CodexAppServerFailureDto;
    };

export interface CodexAppServerClient {
  initialize(signal?: AbortSignal): Promise<void>;

  request(method: string, params: CodexJson, signal?: AbortSignal): Promise<CodexRpcResult>;

  notify(
    method: string,
    params: CodexJson,
    signal?: AbortSignal,
  ): Promise<CodexTransportWriteReceipt>;

  notifications(signal: AbortSignal): AsyncIterable<CodexWireNotification>;

  serverRequests(signal: AbortSignal): AsyncIterable<CodexWireRequest>;

  close(): Promise<void>;
}

/**
 * This codec is the only component that imports generated Codex types.
 * It converts strongly typed generated objects to/from neutral adapter values.
 */
export interface CodexProtocolCodec {
  readonly testedCodexVersion: string;
  readonly protocolFingerprint: string;

  encodeInitialize(client: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  }): CodexJson;

  decodeInitializeResult(value: CodexJson): {
    readonly runtimeVersion?: string;
    readonly capabilities: Readonly<Record<string, boolean>>;
  };

  encodeThreadList(cursor?: string, limit?: number): CodexJson;
  decodeThreadList(value: CodexJson): {
    readonly threads: readonly CodexThreadSummary[];
    readonly nextCursor?: string;
  };

  encodeThreadRead(threadOpaqueId: string): CodexJson;
  decodeThreadRead(value: CodexJson): CodexThreadSnapshot;

  encodeLoadedThreadList(): CodexJson;
  decodeLoadedThreadList(value: CodexJson): readonly string[];

  encodeContextInjection(
    threadOpaqueId: string,
    canonicalEnvelopeJson: string,
    deliveryId: string,
  ): CodexJson;

  encodeTurnStartWithToolOutput(threadOpaqueId: string, canonicalEnvelopeJson: string): CodexJson;

  decodeTurnStart(value: CodexJson): {
    readonly turnOpaqueId: string;
  };

  encodeTurnInterrupt(threadOpaqueId: string, turnOpaqueId: string): CodexJson;

  normalizeNotification(
    notification: CodexWireNotification,
  ): CodexNormalizedNotification | undefined;
}

export interface CodexThreadSummary {
  readonly opaqueId: string;
  readonly title?: string;
  readonly status: string;
  readonly cwdHint?: string;
}

export interface CodexThreadSnapshot extends CodexThreadSummary {
  readonly turns?: readonly {
    readonly opaqueId: string;
    readonly status: string;
    readonly items?: readonly CodexJson[];
  }[];
}

export type CodexNormalizedNotification =
  | {
      readonly type: "thread-status";
      readonly threadOpaqueId: string;
      readonly vendorStatus: string;
    }
  | {
      readonly type: "turn-started";
      readonly threadOpaqueId: string;
      readonly turnOpaqueId: string;
    }
  | {
      readonly type: "final-message";
      readonly threadOpaqueId: string;
      readonly turnOpaqueId: string;
      readonly text: string;
    }
  | {
      readonly type: "local-input";
      readonly threadOpaqueId: string;
      readonly turnOpaqueId: string;
      readonly requestOpaqueId: string;
      readonly kind: string;
      readonly blocking: boolean;
    }
  | {
      readonly type: "turn-completed";
      readonly threadOpaqueId: string;
      readonly turnOpaqueId: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly error?: string;
    };
