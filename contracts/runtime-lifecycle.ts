/**
 * Proposed runtime-neutral lifecycle port (spike version 0).
 *
 * This contract is intentionally not wired into the production application.
 * Vendor options remain opaque and workspace creation is delegated to a
 * provisioner so the ASC core does not become coupled to Git or Codex.
 */

import type { JsonObject, RuntimeInstallationId, RuntimeSessionRef } from "./runtime-adapter";

export const RUNTIME_LIFECYCLE_API_VERSION = 0;

export type WorkspaceSpec =
  | { readonly kind: "existing"; readonly path: string }
  | {
      readonly kind: "provisioned";
      readonly provisionerId: string;
      readonly request: JsonObject;
    };

export interface RuntimeLifecycleCapabilities {
  readonly spawn: boolean;
  readonly stop: boolean;
  readonly inspectBySession: boolean;
  readonly inspectByRequestId: boolean;
}

export interface RuntimeSpawnRequest {
  /** Stable ASC idempotency/correlation key, not necessarily a runtime key. */
  readonly requestId: string;
  readonly installationId: RuntimeInstallationId;
  readonly nameHint?: string;
  readonly workspace: WorkspaceSpec;
  readonly runtimeProfileId: string;
  readonly runtimeOptions: JsonObject;
  readonly origin?: {
    readonly requestingAgentId: string;
    readonly requestingBindingId: string;
  };
}

export type RuntimeSpawnResult =
  | {
      readonly outcome: "created";
      readonly session: RuntimeSessionRef;
      readonly observedAt: string;
      readonly evidence: JsonObject;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: "unsupported" | "invalid-profile" | "resource-limit" | "runtime-error";
      readonly retryable: boolean;
    }
  | {
      /** The request may have reached the runtime, but no session identity is proven. */
      readonly outcome: "unknown";
      readonly reason: "response-lost-after-write" | "reconciliation-inconclusive";
      readonly retryable: false;
      readonly reconciliationKey: string;
    };

export interface RuntimeStopRequest {
  readonly requestId: string;
  readonly session: RuntimeSessionRef;
  /** `detach` is the only portable, non-destructive operation. */
  readonly disposition: "detach" | "terminate";
}

export type RuntimeStopResult =
  | { readonly outcome: "stopped" | "not-found"; readonly observedAt: string }
  | { readonly outcome: "rejected"; readonly reason: string; readonly retryable: boolean }
  | {
      readonly outcome: "unknown";
      readonly reason: "response-lost-after-write" | "reconciliation-inconclusive";
      readonly retryable: false;
    };

export type RuntimeLifecycleState =
  | "unknown"
  | "starting"
  | "ready"
  | "stopping"
  | "terminated"
  | "failed";

export interface RuntimeLifecycleSnapshot {
  readonly requestId?: string;
  readonly session?: RuntimeSessionRef;
  readonly state: RuntimeLifecycleState;
  readonly observedAt: string;
  readonly revision?: string;
  readonly attributes: JsonObject;
}

export interface RuntimeLifecycleAdapter {
  readonly lifecycleCapabilities: RuntimeLifecycleCapabilities;
  spawn(request: RuntimeSpawnRequest, signal?: AbortSignal): Promise<RuntimeSpawnResult>;
  stop(request: RuntimeStopRequest, signal?: AbortSignal): Promise<RuntimeStopResult>;
  inspectLifecycle(
    target: { readonly requestId: string } | { readonly session: RuntimeSessionRef },
    signal?: AbortSignal,
  ): Promise<RuntimeLifecycleSnapshot>;
}
