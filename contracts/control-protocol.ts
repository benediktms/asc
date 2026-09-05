/**
 * Normative ACS local control protocol type map, version 1.0.
 *
 * Transport: JSON-RPC 2.0 over HTTP on an authenticated local Unix socket.
 * This protocol is NOT the inter-agent data plane.
 */

import type {
  JsonObject,
  JsonValue,
  RuntimeAvailability,
  RuntimeProbeResult,
  RuntimeSessionRef,
  RuntimeSessionSnapshot,
} from "./runtime-adapter";

export const ACS_CONTROL_PROTOCOL_VERSION = "1.0";

export interface ControlClientInfo {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
}

export interface ControlServerInfo {
  readonly name: "acs";
  readonly version: string;
  readonly instanceId: string;
}

export interface ControlErrorData {
  readonly code:
    | "NOT_AUTHENTICATED"
    | "NOT_AUTHORIZED"
    | "AGENT_NOT_FOUND"
    | "AGENT_DISABLED"
    | "BINDING_NOT_FOUND"
    | "BINDING_CONFLICT"
    | "UNATTESTED_CALLER"
    | "STALE_BINDING"
    | "RUNTIME_UNAVAILABLE"
    | "RUNTIME_INCOMPATIBLE"
    | "TASK_NOT_FOUND"
    | "TASK_STATE_CONFLICT"
    | "TASK_NOT_ASSIGNED"
    | "DELIVERY_NOT_FOUND"
    | "ACCEPTANCE_UNKNOWN"
    | "UNSUPPORTED_CAPABILITY"
    | "IDEMPOTENCY_CONFLICT"
    | "VALIDATION_FAILED"
    | "OVERLOADED"
    | "INTERNAL";
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly details?: JsonObject;
}

export interface LogicalAgentDto {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly skills: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly tags: readonly string[];
  }[];
  readonly availability: RuntimeAvailability;
  readonly binding?: {
    readonly id: string;
    readonly harnessId: string;
    readonly epoch: number;
    readonly status: "pending" | "active" | "stale" | "revoked";
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeBindingDto {
  readonly id: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly harnessId: string;
  readonly session: RuntimeSessionRef;
  readonly epoch: number;
  readonly status: "pending" | "active" | "stale" | "revoked";
  readonly continuityPolicy: "follow-pending" | "strict";
  readonly deliveryPolicy: {
    readonly wakeStrategy: "atomic-only" | "non-atomic-idle-check" | "disabled";
    readonly allowActiveTurnSteering: boolean;
    readonly autoResumeDormantThread: boolean;
    readonly interruptOnCancel: boolean;
  };
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly revokedAt?: string;
}

export interface TaskDto {
  readonly id: string;
  readonly contextId: string;
  readonly targetAgentId: string;
  readonly requesterAgentId?: string;
  readonly state:
    | "submitted"
    | "working"
    | "input-required"
    | "auth-required"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected";
  readonly stateVersion: number;
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryDto {
  readonly id: string;
  readonly kind: "a2a-message" | "task-event-notification";
  readonly taskId?: string;
  readonly targetAgentId: string;
  readonly state:
    | "pending"
    | "leased"
    | "attempting"
    | "deferred"
    | "accepted"
    | "acceptance-unknown"
    | "failed-terminal"
    | "canceled"
    | "superseded";
  readonly reason?: string;
  readonly attemptCount: number;
  readonly bindingId?: string;
  readonly bindingEpoch?: number;
  readonly runtimeExecutionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export type BridgeAttestationDto =
  | {
      readonly kind: "attested";
      readonly scheme: string;
      readonly session: RuntimeSessionRef;
      readonly bindingId: string;
      readonly bindingEpoch: number;
      readonly agentId: string;
      readonly principalId: string;
      readonly evidenceFingerprint: string;
    }
  | {
      readonly kind: "unattested";
      readonly reason: string;
    };

export interface ControlMethodMap {
  "system.initialize": {
    readonly params: {
      readonly protocolVersion: typeof ACS_CONTROL_PROTOCOL_VERSION;
      readonly client: ControlClientInfo;
      readonly capabilities: JsonObject;
    };
    readonly result: {
      readonly protocolVersion: typeof ACS_CONTROL_PROTOCOL_VERSION;
      readonly server: ControlServerInfo;
      readonly capabilities: {
        readonly codex: boolean;
        readonly a2aJsonRpc: boolean;
        readonly taskEventNotifications: boolean;
      };
    };
  };

  "system.health": {
    readonly params: Record<string, never>;
    readonly result: {
      readonly status: "ok" | "degraded";
      readonly database: "ok" | "degraded";
      readonly adapters: readonly {
        readonly adapterId: string;
        readonly status: "ready" | "degraded" | "unavailable" | "incompatible";
      }[];
      readonly startedAt: string;
      readonly metrics: readonly {
        readonly name: string;
        readonly labels: Readonly<Record<string, string>>;
        readonly value: number;
        readonly count?: number;
      }[];
      readonly traces: readonly {
        readonly name: string;
        readonly startedAt: string;
        readonly durationMs: number;
        readonly status: "ok" | "error";
      }[];
    };
  };

  "system.capabilities": {
    readonly params: Record<string, never>;
    readonly result: JsonObject;
  };

  "system.shutdown": {
    readonly params: { readonly reason?: string };
    readonly result: { readonly accepted: true };
  };

  "agents.create": {
    readonly params: {
      readonly slug: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly skills?: readonly {
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly tags?: readonly string[];
      }[];
    };
    readonly result: { readonly agent: LogicalAgentDto };
  };

  "agents.get": {
    readonly params: { readonly agent: string };
    readonly result: { readonly agent: LogicalAgentDto };
  };

  "agents.list": {
    readonly params: {
      readonly enabled?: boolean;
      readonly availability?: readonly RuntimeAvailability[];
      readonly skill?: string;
      readonly text?: string;
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: CursorPage<LogicalAgentDto>;
  };

  "agents.update": {
    readonly params: {
      readonly agent: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly enabled?: boolean;
      readonly skills?: readonly {
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly tags?: readonly string[];
      }[];
    };
    readonly result: { readonly agent: LogicalAgentDto };
  };

  "agents.delete": {
    readonly params: { readonly agent: string };
    readonly result: { readonly deleted: true };
  };

  "agents.createClaim": {
    readonly params: {
      readonly agent: string;
      readonly ttlSeconds?: number;
    };
    readonly result: {
      readonly claimId: string;
      readonly claimCode: string;
      readonly expiresAt: string;
    };
  };

  "bindings.bind": {
    readonly params: {
      readonly agent: string;
      readonly installationId: string;
      readonly session: RuntimeSessionRef;
      readonly continuityPolicy?: "follow-pending" | "strict";
      readonly deliveryPolicy?: Partial<RuntimeBindingDto["deliveryPolicy"]>;
      readonly revokeExisting?: boolean;
    };
    readonly result: { readonly binding: RuntimeBindingDto };
  };

  "bindings.claim": {
    readonly params: {
      readonly claimCode: string;
      readonly evidence: {
        readonly harnessId: "codex";
        readonly bridge: "mcp";
        readonly metadata?: JsonObject;
        readonly bridgeInstanceId: string;
      };
    };
    readonly result: {
      readonly agent: LogicalAgentDto;
      readonly binding: RuntimeBindingDto;
    };
  };

  "bindings.get": {
    readonly params: { readonly bindingId: string };
    readonly result: { readonly binding: RuntimeBindingDto };
  };

  "bindings.list": {
    readonly params: {
      readonly agent?: string;
      readonly status?: readonly RuntimeBindingDto["status"][];
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: CursorPage<RuntimeBindingDto>;
  };

  "bindings.revoke": {
    readonly params: {
      readonly bindingId: string;
      readonly reason?: string;
    };
    readonly result: { readonly binding: RuntimeBindingDto };
  };

  "bindings.retargetPending": {
    readonly params: {
      readonly agent: string;
      readonly fromBindingId?: string;
      readonly toBindingId: string;
      readonly deliveryIds?: readonly string[];
    };
    readonly result: { readonly retargeted: number };
  };

  "runtimes.list": {
    readonly params: {
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: {
      readonly runtimes: readonly {
        readonly installationId: string;
        readonly harnessId: string;
        readonly adapterId: string;
        readonly label: string;
        readonly probe?: RuntimeProbeResult;
      }[];
      readonly nextCursor?: string;
    };
  };

  "runtimes.probe": {
    readonly params: { readonly installationId: string };
    readonly result: { readonly probe: RuntimeProbeResult };
  };

  "runtimes.sessions.list": {
    readonly params: {
      readonly installationId: string;
      readonly availability?: readonly RuntimeAvailability[];
      readonly text?: string;
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: {
      readonly sessions: readonly RuntimeSessionSnapshot[];
      readonly nextCursor?: string;
    };
  };

  "runtimes.sessions.inspect": {
    readonly params: {
      readonly installationId: string;
      readonly session: RuntimeSessionRef;
    };
    readonly result: { readonly session: RuntimeSessionSnapshot };
  };

  "bridge.attestCaller": {
    readonly params: {
      readonly evidence: {
        readonly harnessId: string;
        readonly bridge: "mcp";
        readonly metadata?: JsonObject;
        readonly bridgeInstanceId: string;
      };
    };
    readonly result: BridgeAttestationDto;
  };

  "bridge.issueA2AToken": {
    readonly params: {
      readonly bindingId: string;
      readonly bindingEpoch: number;
      readonly scopes: readonly ("a2a:send" | "a2a:read" | "a2a:cancel")[];
      readonly ttlSeconds?: number;
    };
    readonly result: {
      readonly token: string;
      readonly expiresAt: string;
    };
  };

  "bridge.identity": {
    readonly params: {
      readonly evidence: {
        readonly harnessId: string;
        readonly bridge: "mcp";
        readonly metadata?: JsonObject;
        readonly bridgeInstanceId: string;
      };
    };
    readonly result: {
      readonly attestation: BridgeAttestationDto;
      readonly agent?: LogicalAgentDto;
    };
  };

  "executor.task.publishMessage": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
      readonly parts: readonly ExecutorPart[];
      readonly summary?: string;
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "executor.task.publishArtifact": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
      readonly artifacts: readonly ExecutorArtifact[];
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "executor.task.requestInput": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
      readonly question: string;
      readonly choices?: readonly string[];
      readonly blocking?: boolean;
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "executor.task.complete": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
      readonly summary: string;
      readonly artifacts?: readonly ExecutorArtifact[];
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "executor.task.fail": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
      readonly summary: string;
      readonly retryable?: boolean;
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "executor.task.acknowledge": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
    };
    readonly result: { readonly task: TaskDto; readonly eventSequence: number };
  };

  "inbox.list": {
    readonly params: ExecutorTaskEvidence & {
      readonly states?: readonly TaskDto["state"][];
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: CursorPage<TaskDto>;
  };

  "inbox.get": {
    readonly params: ExecutorTaskEvidence & {
      readonly taskId: string;
    };
    readonly result: { readonly task: TaskDto };
  };

  "deliveries.list": {
    readonly params: {
      readonly state?: readonly DeliveryDto["state"][];
      readonly targetAgent?: string;
      readonly taskId?: string;
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly result: CursorPage<DeliveryDto>;
  };

  "deliveries.get": {
    readonly params: { readonly deliveryId: string };
    readonly result: { readonly delivery: DeliveryDto };
  };

  "deliveries.retry": {
    readonly params: {
      readonly deliveryId: string;
      readonly force?: boolean;
    };
    readonly result: { readonly delivery: DeliveryDto };
  };

  "deliveries.cancel": {
    readonly params: {
      readonly deliveryId: string;
      readonly reason?: string;
    };
    readonly result: { readonly delivery: DeliveryDto };
  };

  "deliveries.resolveUnknown": {
    readonly params: {
      readonly deliveryId: string;
      readonly resolution: "accepted" | "not-accepted-and-retry" | "not-accepted-and-cancel";
      readonly evidence?: string;
    };
    readonly result: { readonly delivery: DeliveryDto };
  };
}

export interface ExecutorTaskEvidence {
  readonly evidence: {
    readonly harnessId: "codex";
    readonly bridge: "mcp";
    readonly metadata?: JsonObject;
    readonly bridgeInstanceId: string;
  };
}

export type ExecutorPart =
  | { readonly kind: "text"; readonly text: string; readonly mediaType?: string }
  | {
      readonly kind: "uri";
      readonly uri: string;
      readonly name?: string;
      readonly mediaType?: string;
    }
  | {
      readonly kind: "data";
      readonly data: JsonValue;
      readonly mediaType: string;
      readonly name?: string;
    };

export interface ExecutorArtifact {
  readonly kind: "uri" | "data";
  readonly uri?: string;
  readonly data?: JsonValue;
  readonly name: string;
  readonly mediaType?: string;
  readonly description?: string;
}

export type ControlMethod = keyof ControlMethodMap;

export type ControlParams<M extends ControlMethod> = ControlMethodMap[M]["params"];

export type ControlResult<M extends ControlMethod> = ControlMethodMap[M]["result"];

export interface ControlRpcClient {
  call<M extends ControlMethod>(
    method: M,
    params: ControlParams<M>,
    signal?: AbortSignal,
  ): Promise<ControlResult<M>>;
}
