import type {
  BindingId,
  DeliveryId,
  JsonValue,
  RuntimeAvailability,
  RuntimeExecutionId,
  RuntimeInstallationId,
  RuntimeProbeResult,
  RuntimeSessionRef,
  RuntimeTraceContext,
} from "../../../contracts/runtime-adapter";
import type { BindingState, DeliveryState, TaskState } from "../../domain/src/index";

export type SqlBinding = string | bigint | Uint8Array | number | boolean | null;

export interface SqlStatement<Result, Params extends SqlBinding[]> {
  all(...params: Params): Result[];
  get(...params: Params): Result | null;
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqlPort {
  query<Result = unknown, Params extends SqlBinding[] = SqlBinding[]>(
    sql: string,
  ): SqlStatement<Result, Params>;
}

export interface StoredPart {
  content?:
    | { $case: "text"; value: string }
    | { $case: "url"; value: string }
    | { $case: "data"; value: JsonValue }
    | { $case: "raw"; value: unknown };
  metadata?: Record<string, unknown>;
  filename: string;
  mediaType: string;
}

export interface StoredMessage {
  messageId: string;
  contextId: string;
  taskId: string;
  role: number;
  parts: StoredPart[];
  metadata?: Record<string, unknown>;
  extensions: string[];
  referenceTaskIds: string[];
}

export interface StoredArtifact {
  artifactId: string;
  name: string;
  description: string;
  parts: StoredPart[];
  metadata?: Record<string, unknown>;
  extensions: string[];
}

export interface StoredTask {
  id: string;
  contextId: string;
  status?: { state: number; message?: StoredMessage; timestamp: string };
  artifacts: StoredArtifact[];
  history: StoredMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentRow {
  id: `agt_${string}`;
  slug: string;
  display_name: string;
  description: string;
  skills_json: string;
  enabled: number;
  profile_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
}

export interface BindingRow {
  id: BindingId;
  agent_id: `agt_${string}`;
  installation_id: RuntimeInstallationId;
  session_opaque_id: string;
  epoch: number;
  status: BindingState;
  continuity_policy: "follow-pending" | "strict";
  delivery_policy_json: string;
  created_at_ms: number;
  activated_at_ms: number | null;
  revoked_at_ms: number | null;
  last_observed_availability: string | null;
  last_observed_at_ms: number | null;
}

export interface DeliveryIntentRow {
  id: DeliveryId;
  kind: "a2a-message" | "task-event-notification";
  task_id: `tsk_${string}`;
  target_agent_id: `agt_${string}`;
  mode: "direct";
  state: DeliveryState;
  state_reason: string | null;
  attempt_count: number;
  payload_json: string;
  payload_hash: string;
  deadline_ms: number | null;
  pinned_binding_id: BindingId | null;
  pinned_binding_epoch: number | null;
  runtime_execution_id: RuntimeExecutionId | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AuthenticatedPrincipalRow {
  id: `prn_${string}`;
  kind: string;
  agent_id: `agt_${string}` | null;
  binding_id: BindingId | null;
  token_id: `tok_${string}`;
  token_hash: Uint8Array;
  scopes_json: string;
  scopes: string[];
}

export type StoredAttestation =
  | {
      readonly kind: "unattested";
      readonly reason:
        | "unsupported-harness"
        | "missing-session-id"
        | "invalid-session-id"
        | "unbound-session";
    }
  | {
      readonly kind: "attested";
      readonly scheme: string;
      readonly session: RuntimeSessionRef;
      readonly bindingId: BindingId;
      readonly bindingEpoch: number;
      readonly agentId: `agt_${string}`;
      readonly principalId: `prn_${string}`;
      readonly slug: string;
      readonly displayName: string;
      readonly evidenceFingerprint: string;
    };

export interface BindingHandle {
  id: BindingId;
  agentId: `agt_${string}`;
  sessionId: string;
  epoch: number;
  principalId: `prn_${string}`;
  rebound: boolean;
}

export interface BindingOptions {
  continuityPolicy?: "follow-pending" | "strict";
  /** Internal compatibility shape while storage policy JSON is simplified. */
  deliveryPolicy?: Partial<{
    wakeStrategy: "atomic-only" | "non-atomic-idle-check" | "disabled";
    allowActiveTurnSteering: boolean;
    autoResumeDormantThread: boolean;
    interruptOnCancel: boolean;
  }>;
  installationId?: RuntimeInstallationId;
  revokeExisting?: boolean;
}

export interface ClaimBindingResult extends BindingHandle {
  idempotent: boolean;
}

export interface DeliveryOptions {
  /** Internal storage selector. Public A2A/MCP callers cannot choose a mode. */
  mode?: "direct";
  priority?: "low" | "normal" | "high";
  notifyOn?: string[];
  replyExpected?: boolean;
  expiresAt?: string;
  traceContext?: RuntimeTraceContext;
}

export interface A2AStoragePort {
  agent(value: string): AgentRow | null;
  authenticate(token: string): AuthenticatedPrincipalRow | null;
  audit(
    actorPrincipalId: string | null,
    action: string,
    resourceType: string,
    resourceId?: string,
    details?: Record<string, unknown>,
    correlationId?: string,
  ): void;
  accept(
    agentId: string,
    principalId: string,
    message: StoredMessage,
    options: DeliveryOptions,
    requestHash?: string,
  ): { task: StoredTask; deliveryId: string; duplicate: boolean; stateVersion?: number };
  task(id: string, principalId: string, targetAgentId?: string): StoredTask | undefined;
  taskStreamState(
    id: string,
    principalId: string,
    targetAgentId?: string,
  ): { task: StoredTask; sequence: number } | undefined;
  taskVersion(taskId: string): number;
  listTasks(
    agentId: string,
    principalId: string,
    options: {
      contextId?: string;
      states?: readonly string[];
      updatedAfterMs?: number;
      cursor?: string;
      limit: number;
    },
  ): { tasks: StoredTask[]; nextCursor?: string; total: number };
  requestCancellation(taskId: string, principalId: string, reason?: string): StoredTask;
  eventsAfter(
    taskId: string,
    sequence: number,
  ): { sequence: number; eventType: string; task: StoredTask; createdAt: string }[];
}

export interface ControlStoragePort extends SqlPort {
  write<T>(operation: () => T): T;
  authenticate(token: string): AuthenticatedPrincipalRow | null;
  audit(
    actorPrincipalId: string | null,
    action: string,
    resourceType: string,
    resourceId?: string,
    details?: Record<string, unknown>,
    correlationId?: string,
  ): void;
  metrics(): unknown;
  createAgent(
    slug: string,
    displayName?: string,
    description?: string,
    skills?: unknown[],
  ): AgentRow;
  updateAgent(
    value: string,
    patch: {
      slug?: string;
      displayName?: string;
      description?: string;
      enabled?: boolean;
      skills?: unknown[];
    },
  ): AgentRow;
  deleteAgent(value: string): void;
  agent(value: string): AgentRow | null;
  agents(): AgentRow[];
  createClaim(
    agent: string,
    principalId: string,
    ttlSeconds?: number,
  ): { claimId: string; claimCode: string; expiresAt: string };
  bind(agent: string, sessionId: string, options?: BindingOptions): BindingHandle;
  claim(code: string, sessionId: string, options?: BindingOptions): ClaimBindingResult;
  binding(bindingId: string): BindingRow | null;
  revokeBinding(bindingId: string, reason?: string): BindingRow | null;
  observeSession(session: RuntimeSessionRef, availability: RuntimeAvailability): void;
  observeRuntime(installationId: RuntimeInstallationId, probe: RuntimeProbeResult): void;
  attestSession(
    session: RuntimeSessionRef,
    scheme: string,
    evidenceFingerprint: string,
  ): StoredAttestation;
  issueToken(principalId: string, scopes: readonly string[], ttlSeconds?: number): string;
  inbox(agentId: string): {
    id: string;
    state: TaskState;
    updated_at_ms: number;
    task: StoredTask;
  }[];
  inboxTask(agentId: string, taskId: string): unknown;
  acknowledgeTask(taskId: string, principalId: string, deliveryId?: string): StoredTask;
  publishMessage(
    taskId: string,
    principalId: string,
    parts: StoredPart[],
    summary?: string,
  ): { task: StoredTask; eventSequence: number };
  publishArtifacts(
    taskId: string,
    principalId: string,
    artifacts: StoredArtifact[],
  ): { task: StoredTask; eventSequence: number };
  completeTask(
    taskId: string,
    principalId: string,
    summary: string,
    artifacts: StoredArtifact[],
  ): StoredTask;
  setTaskState(
    taskId: string,
    principalId: string,
    next: TaskState,
    summary?: string,
    details?: Record<string, unknown>,
  ): StoredTask;
  eventSequence(taskId: string): number;
  retryDelivery(deliveryId: string): DeliveryIntentRow | null;
  cancelDelivery(deliveryId: string, reason?: string): DeliveryIntentRow | null;
  resolveUnknown(deliveryId: string, resolution: string): DeliveryIntentRow | null;
  encodeCursor(value: Record<string, unknown>): string;
  decodeCursor(cursor: string): unknown;
}

export interface DeliveryStoragePort extends SqlPort {
  write<Result>(operation: () => Result): Result;
  agent(value: string): AgentRow | null;
  observeRuntime(installationId: RuntimeInstallationId, probe: RuntimeProbeResult): void;
  markRuntimeOffline(installationId: RuntimeInstallationId): void;
  observeSession(session: RuntimeSessionRef, availability: RuntimeAvailability): void;
  setTaskState(
    taskId: string,
    principalId: string,
    next: TaskState,
    summary?: string,
    details?: Record<string, unknown>,
  ): StoredTask;
}
