/**
 * Harness-neutral application port used by the A2A protocol adapter.
 *
 * The protocol-a2a package maps official @a2a-js/sdk types to these commands.
 * The application package implements this port. Neither domain nor application
 * imports the A2A SDK.
 */

import type { JsonObject, NeutralPart } from "./runtime-adapter";

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly kind: "bound-agent" | "external-a2a-client" | "service";
  readonly agentId?: string;
  readonly bindingId?: string;
  readonly scopes: readonly string[];
}

export interface A2ATarget {
  readonly agentId: string;
  readonly slug: string;
  readonly profileRevision: number;
}

export interface DeliveryPreference {
  readonly mode: "wake_when_idle" | "append_context";
  readonly priority: "low" | "normal" | "high";
  readonly notifyOn: readonly (
    | "working"
    | "input-required"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected"
    | "terminal"
  )[];
  readonly replyExpected: boolean;
  readonly expiresAt?: string;
}

export interface AcceptA2AMessageCommand {
  readonly principal: AuthenticatedPrincipal;
  readonly target: A2ATarget;
  readonly requestCorrelationId: string;
  readonly externalMessageId: string;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly role: "user" | "agent";
  readonly parts: readonly NeutralPart[];
  readonly requestMetadata: JsonObject;
  readonly messageMetadata: JsonObject;
  readonly delivery: DeliveryPreference;
  readonly canonicalRequestHash: string;
}

export interface AcceptedTaskSnapshot {
  readonly taskId: string;
  readonly contextId: string;
  readonly targetAgentId: string;
  readonly requesterPrincipalId: string;
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
  readonly a2aSnapshot: JsonObject;
  readonly deliveryId: string;
  readonly duplicate: boolean;
}

export interface A2ATaskQuery {
  readonly principal: AuthenticatedPrincipal;
  readonly target: A2ATarget;
  readonly taskId: string;
  readonly historyLength?: number;
}

export interface A2ATaskListQuery {
  readonly principal: AuthenticatedPrincipal;
  readonly target: A2ATarget;
  readonly contextId?: string;
  readonly states?: readonly string[];
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface A2ATaskPage {
  readonly tasks: readonly JsonObject[];
  readonly nextCursor?: string;
}

export interface CancelA2ATaskCommand {
  readonly principal: AuthenticatedPrincipal;
  readonly target: A2ATarget;
  readonly taskId: string;
  readonly reason?: string;
  readonly requestCorrelationId: string;
}

export interface TaskEventRecord {
  readonly taskId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly a2aEvent: JsonObject;
  readonly createdAt: string;
}

export interface TaskEventSubscription {
  /**
   * Snapshot captured before live subscription begins. The protocol adapter
   * uses it to avoid a persisted-event/live-event gap.
   */
  readonly currentTask: JsonObject;
  readonly replay: readonly TaskEventRecord[];
  readonly live: AsyncIterable<TaskEventRecord>;
  close(): Promise<void>;
}

export interface A2AApplicationPort {
  /**
   * MUST commit idempotency, task, message, event and delivery intent in one
   * transaction before resolving.
   */
  acceptMessage(
    command: AcceptA2AMessageCommand,
    signal?: AbortSignal,
  ): Promise<AcceptedTaskSnapshot>;

  getTask(query: A2ATaskQuery, signal?: AbortSignal): Promise<JsonObject>;

  listTasks(query: A2ATaskListQuery, signal?: AbortSignal): Promise<A2ATaskPage>;

  cancelTask(command: CancelA2ATaskCommand, signal?: AbortSignal): Promise<JsonObject>;

  /**
   * The returned subscription MUST not miss events between the initial
   * persisted read and registration of the live listener.
   */
  subscribeTask(
    query: A2ATaskQuery & { readonly afterSequence?: number },
    signal?: AbortSignal,
  ): Promise<TaskEventSubscription>;
}
