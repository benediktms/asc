/**
 * Normative Runtime Adapter API v1 for Agent Communications Service.
 *
 * This package MUST NOT import any vendor SDK or runtime protocol types.
 * Adapters translate vendor types at their own boundary.
 */

export const RUNTIME_ADAPTER_API_VERSION = 1;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type RuntimeInstallationId = `ins_${string}`;
export type BindingId = `bnd_${string}`;
export type DeliveryId = `int_${string}`;
export type RuntimeExecutionId = `exe_${string}`;

export type NeutralPart =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly mediaType?: "text/plain" | "text/markdown";
    }
  | {
      readonly kind: "uri";
      readonly uri: string;
      readonly name?: string;
      readonly mediaType?: string;
      readonly description?: string;
    }
  | {
      readonly kind: "data";
      readonly data: JsonValue;
      readonly mediaType: string;
      readonly name?: string;
    };

export interface RuntimeSessionRef {
  /** Identifies one configured/reachable harness control plane. */
  readonly installationId: RuntimeInstallationId;

  /**
   * Vendor session identifier. It is deliberately opaque to the ACS core.
   * For Codex this is currently a thread ID, but core code MUST NOT rely on it.
   */
  readonly opaqueId: string;
}

export type RuntimeAvailability =
  | "unknown"
  | "offline"
  | "dormant"
  | "idle"
  | "busy"
  | "awaiting-local-input"
  | "degraded";

export interface RuntimeSessionSnapshot {
  readonly session: RuntimeSessionRef;
  readonly availability: RuntimeAvailability;
  readonly observedAt: string;
  readonly revision?: string;
  readonly attributes: {
    readonly displayTitle?: string;
    readonly cwdHint?: string;
    readonly sourceKind?: string;
    readonly [key: string]: JsonValue | undefined;
  };
}

export interface RuntimeSessionQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly availability?: readonly RuntimeAvailability[];
  readonly text?: string;
}

export interface RuntimeSessionPage {
  readonly sessions: readonly RuntimeSessionSnapshot[];
  readonly nextCursor?: string;
}

export interface RuntimeCapabilities {
  readonly listSessions: boolean;
  readonly observeSessionState: boolean;
  readonly observeExecutions: boolean;
  readonly directDelivery: boolean;
  readonly cancelOwnedExecution: boolean;
  readonly reconcileDelivery: boolean;
  readonly callerAttestationSchemes: readonly string[];
  readonly supportedPartKinds: readonly NeutralPart["kind"][];
}

export interface RuntimeAdapterDescriptor {
  readonly adapterApiVersion: typeof RUNTIME_ADAPTER_API_VERSION;
  readonly adapterId: string;
  readonly harnessId: string;
  readonly implementationVersion: string;
  readonly capabilities: RuntimeCapabilities;
}

export interface RuntimeProbeResult {
  readonly state: "ready" | "degraded" | "unavailable" | "incompatible";
  readonly observedAt: string;
  readonly runtimeVersion?: string;
  readonly protocolFingerprint?: string;
  readonly capabilities: RuntimeCapabilities;
  readonly diagnostics: readonly {
    readonly severity: "info" | "warning" | "error";
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
  }[];
}

export interface RuntimeAdapterContext {
  readonly installationId: RuntimeInstallationId;
  readonly instanceId: string;
  readonly logger: RuntimeAdapterLogger;
  readonly clock: RuntimeAdapterClock;

  /**
   * A side-effect fence supplied by the application layer.
   * An adapter MUST call this immediately before each vendor-side mutation.
   */
  readonly assertBindingFence: (
    bindingId: BindingId,
    expectedEpoch: number,
    signal?: AbortSignal,
  ) => Promise<
    | { readonly valid: true }
    | { readonly valid: false; readonly reason: "stale" | "revoked" | "missing" }
  >;
}

export interface RuntimeTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface RuntimeAdapterStopContext {
  readonly reason: "shutdown" | "restart" | "configuration-change";
  readonly deadline?: string;
}

export interface RuntimeAdapterLogger {
  debug(event: string, attributes?: JsonObject): void;
  info(event: string, attributes?: JsonObject): void;
  warn(event: string, attributes?: JsonObject): void;
  error(event: string, attributes?: JsonObject): void;
}

export interface RuntimeAdapterClock {
  now(): string;
}

export type RuntimeDeliveryMode = "direct";
export type RuntimeExecutionRelationship = "started" | "joined" | "unknown";

export interface RuntimeDeliveryEnvelopeV1 {
  readonly schema: "urn:agent-communications:runtime-envelope:v1";
  readonly deliveryId: DeliveryId;
  /** Included by the adapter in the submitted marker; never permission evidence. */
  readonly payloadHash?: string;
  readonly kind: "a2a-message" | "a2a-task-event";

  readonly from: {
    readonly agentId: string;
    readonly name: string;
  };

  readonly to: {
    readonly agentId: string;
    readonly name: string;
  };

  readonly task?: {
    readonly id: string;
    readonly contextId: string;
    readonly state: string;
  };

  readonly message?: {
    readonly id: string;
    readonly parts: readonly NeutralPart[];
  };

  readonly event?: {
    readonly sequence: number;
    readonly state?: string;
    readonly summary?: string;
    readonly parts?: readonly NeutralPart[];
  };

  readonly reply?: {
    readonly completeTool: string;
    readonly failTool: string;
    readonly requestInputTool: string;
    readonly taskId: string;
  };

  /**
   * This field is informational and MUST NOT be interpreted as permission
   * or approval by a runtime adapter.
   */
  readonly provenance: {
    readonly authority: "peer-agent";
    readonly trustedForPermissions: false;
  };
}

export interface RuntimeDeliveryRequest {
  readonly deliveryId: DeliveryId;
  readonly target: {
    readonly session: RuntimeSessionRef;
    readonly bindingId: BindingId;
    readonly bindingEpoch: number;
  };
  readonly mode: RuntimeDeliveryMode;
  readonly envelope: RuntimeDeliveryEnvelopeV1;
  readonly payloadHash: string;
  readonly deadline?: string;
  readonly markRequestFlushed?: () => void;
  readonly traceContext?: RuntimeTraceContext;
}

export type RuntimeDeliveryResult =
  | {
      readonly outcome: "accepted";
      readonly acceptedAt: string;
      readonly execution: {
        readonly opaqueId: string;
        readonly relationship: RuntimeExecutionRelationship;
      };
      readonly evidence: {
        readonly scheme: string;
        readonly value: string;
      };
    }
  | {
      readonly outcome: "deferred";
      readonly reason:
        | "offline"
        | "dormant"
        | "local-input"
        | "unsupported-active-state"
        | "route-unavailable"
        | "backpressure"
        | "policy";
      readonly retryAfterMs?: number;
    }
  | {
      readonly outcome: "rejected";
      readonly reason:
        | "stale-binding"
        | "session-not-found"
        | "unsupported-content"
        | "permission-denied"
        | "runtime-protocol-error";
      readonly retryable: boolean;
      readonly details?: JsonObject;
    }
  | {
      readonly outcome: "acceptance-unknown";
      readonly ambiguity:
        | "request-flushed-no-response"
        | "response-lost-before-persist"
        | "connection-reset"
        | "runtime-state-ambiguous";
      readonly reconciliationToken: string;
    };

export interface RuntimeReconcileRequest {
  readonly deliveryId: DeliveryId;
  readonly target: {
    readonly session: RuntimeSessionRef;
    readonly bindingId: BindingId;
    readonly bindingEpoch: number;
  };
  readonly payloadHash: string;
  readonly reconciliationToken: string;
}

export type RuntimeReconcileResult =
  | {
      readonly outcome: "accepted";
      readonly execution?: {
        readonly opaqueId: string;
        readonly relationship?: RuntimeExecutionRelationship;
      };
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "not-accepted";
      readonly evidence: JsonObject;
      readonly safeToRetry: boolean;
    }
  | {
      readonly outcome: "inconclusive";
      readonly reason: string;
      readonly operatorActionRequired: boolean;
    };

export interface RuntimeCancelRequest {
  readonly execution: {
    readonly normalizedId: RuntimeExecutionId;
    readonly opaqueId: string;
    readonly session: RuntimeSessionRef;
    readonly bindingId: BindingId;
    readonly bindingEpoch: number;
  };
  readonly reason?: string;
}

export type RuntimeCancelResult =
  | {
      readonly outcome: "accepted";
      readonly acceptedAt: string;
    }
  | {
      readonly outcome: "not-running";
    }
  | {
      readonly outcome: "unsupported";
    }
  | {
      readonly outcome: "rejected";
      readonly reason: "stale-binding" | "not-owned" | "runtime-protocol-error";
      readonly retryable: boolean;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: string;
    };

export interface RuntimeExecutionRef {
  readonly normalizedId?: RuntimeExecutionId;
  readonly opaqueId: string;
  readonly session: RuntimeSessionRef;
}

export interface RuntimeCorrelation {
  readonly deliveryId?: DeliveryId;
  readonly deliveryIds?: readonly DeliveryId[];
  readonly payloadHash?: string;
}

export interface LocalInputRequest {
  readonly opaqueId: string;
  readonly kind: "approval" | "question" | "authentication" | "unknown";
  readonly blocking: boolean;
  readonly summary?: string;
  readonly expiresAt?: string;
}

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export type RuntimeEvent =
  | {
      readonly type: "session.observed";
      readonly session: RuntimeSessionRef;
      readonly snapshot: RuntimeSessionSnapshot;
    }
  | {
      readonly type: "execution.started";
      readonly session: RuntimeSessionRef;
      readonly execution: RuntimeExecutionRef;
      readonly correlation?: RuntimeCorrelation;
    }
  | {
      readonly type: "execution.output";
      readonly execution: RuntimeExecutionRef;
      readonly channel: "final-message" | "status";
      readonly parts: readonly NeutralPart[];
    }
  | {
      readonly type: "execution.awaiting-local-input";
      readonly execution: RuntimeExecutionRef;
      readonly request: LocalInputRequest;
    }
  | {
      readonly type: "execution.completed";
      readonly execution: RuntimeExecutionRef;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly finalParts: readonly NeutralPart[];
      readonly error?: RuntimeError;
    }
  | {
      readonly type: "adapter.connection";
      readonly state: "online" | "degraded" | "offline";
      readonly reason?: string;
    };

export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor;

  start(context: RuntimeAdapterContext): Promise<void>;

  stop(context: RuntimeAdapterStopContext): Promise<void>;

  probe(signal?: AbortSignal): Promise<RuntimeProbeResult>;

  listSessions(query: RuntimeSessionQuery, signal?: AbortSignal): Promise<RuntimeSessionPage>;

  inspectSession(session: RuntimeSessionRef, signal?: AbortSignal): Promise<RuntimeSessionSnapshot>;

  observe(signal: AbortSignal): AsyncIterable<RuntimeEvent>;

  deliver(request: RuntimeDeliveryRequest, signal?: AbortSignal): Promise<RuntimeDeliveryResult>;

  reconcile(
    request: RuntimeReconcileRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeReconcileResult>;

  cancel(request: RuntimeCancelRequest, signal?: AbortSignal): Promise<RuntimeCancelResult>;
}

export interface HostInvocationEvidence {
  readonly harnessId: string;
  readonly bridge: "mcp";
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly bridgeInstanceId: string;
}

export type CallerAttestationResult =
  | {
      readonly kind: "attested";
      readonly scheme: string;
      readonly session: RuntimeSessionRef;
      readonly evidenceFingerprint: string;
      readonly attributes?: JsonObject;
    }
  | {
      readonly kind: "unattested";
      readonly reason:
        | "unsupported-harness"
        | "missing-host-metadata"
        | "missing-session-id"
        | "invalid-session-id"
        | "runtime-unreachable";
    };

export interface RuntimeCallerAttestor {
  readonly harnessId: string;
  readonly schemes: readonly string[];

  attest(evidence: HostInvocationEvidence, signal?: AbortSignal): Promise<CallerAttestationResult>;
}
