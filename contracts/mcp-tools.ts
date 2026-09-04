/**
 * Normative model-visible ACS MCP tool contract v1.
 *
 * No mutating input contains a sender/from/agentId/threadId field. The bridge
 * derives caller identity from host invocation evidence.
 */

import type { JsonObject, JsonValue } from "./runtime-adapter";

export type McpAttachment =
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
      readonly name: string;
      readonly mediaType: string;
    };

export interface McpToolResult<T> {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly correlationId: string;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

/**
 * Host invocation context is supplied by the MCP host and is not part of the
 * tool's model-visible input schema.
 */
export interface McpHostInvocationContext {
  readonly harnessId: "codex";
  readonly metadata?: JsonObject;
  readonly bridgeInstanceId: string;
}

export interface AcsMcpToolMap {
  acs_identity: {
    readonly input: Record<string, never>;
    readonly output: McpToolResult<{
      readonly state: "bound" | "unbound" | "unattested";
      readonly agent?: {
        readonly id: string;
        readonly slug: string;
        readonly displayName: string;
      };
      readonly harness: "codex";
      readonly bindingEpoch?: number;
      readonly remediation?: string;
    }>;
  };

  acs_agents_list: {
    readonly input: {
      readonly status?: "any" | "available" | "unavailable";
      readonly skill?: string;
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly output: McpToolResult<{
      readonly agents: readonly {
        readonly id: string;
        readonly slug: string;
        readonly displayName: string;
        readonly description: string;
        readonly availability:
          | "unknown"
          | "offline"
          | "dormant"
          | "idle"
          | "busy"
          | "awaiting-local-input"
          | "degraded";
        readonly skills: readonly string[];
      }[];
      readonly nextCursor?: string;
    }>;
  };

  acs_agent_get: {
    readonly input: { readonly agent: string };
    readonly output: McpToolResult<{
      readonly id: string;
      readonly slug: string;
      readonly displayName: string;
      readonly description: string;
      readonly availability: string;
      readonly skills: readonly string[];
    }>;
  };

  acs_send: {
    readonly input: {
      readonly to: string;
      readonly text: string;
      readonly taskId?: string;
      readonly contextId?: string;
      readonly delivery?: "wake_when_idle" | "append_context";
      readonly priority?: "low" | "normal" | "high";
      readonly replyExpected?: boolean;
      readonly notifyOn?: readonly (
        | "working"
        | "input-required"
        | "completed"
        | "failed"
        | "canceled"
        | "rejected"
        | "terminal"
      )[];
      readonly attachments?: readonly McpAttachment[];
      readonly clientRequestId?: string;
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly contextId: string;
      readonly state: string;
      readonly deliveryId: string;
      readonly duplicate: boolean;
    }>;
  };

  acs_task_get: {
    readonly input: {
      readonly taskId: string;
      readonly historyLength?: number;
    };
    readonly output: McpToolResult<{
      readonly task: JsonObject;
    }>;
  };

  acs_task_reply: {
    readonly input: {
      readonly taskId: string;
      readonly text: string;
      readonly attachments?: readonly McpAttachment[];
      readonly clientRequestId?: string;
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly state: string;
      readonly deliveryId: string;
    }>;
  };

  acs_task_cancel: {
    readonly input: {
      readonly taskId: string;
      readonly reason?: string;
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly state: string;
      readonly cancellationRequested: boolean;
    }>;
  };

  acs_task_complete: {
    readonly input: {
      readonly taskId: string;
      readonly summary: string;
      readonly artifacts?: readonly McpAttachment[];
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly state: "completed";
      readonly eventSequence: number;
    }>;
  };

  acs_task_fail: {
    readonly input: {
      readonly taskId: string;
      readonly summary: string;
      readonly retryable?: boolean;
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly state: "failed";
      readonly eventSequence: number;
    }>;
  };

  acs_task_request_input: {
    readonly input: {
      readonly taskId: string;
      readonly question: string;
      readonly choices?: readonly string[];
      readonly blocking?: boolean;
    };
    readonly output: McpToolResult<{
      readonly taskId: string;
      readonly state: "input-required";
      readonly eventSequence: number;
    }>;
  };

  acs_inbox_list: {
    readonly input: {
      readonly states?: readonly ("submitted" | "working" | "input-required")[];
      readonly limit?: number;
      readonly cursor?: string;
    };
    readonly output: McpToolResult<{
      readonly tasks: readonly JsonObject[];
      readonly nextCursor?: string;
    }>;
  };
}

export type AcsMcpToolName = keyof AcsMcpToolMap;
export type AcsMcpToolInput<N extends AcsMcpToolName> = AcsMcpToolMap[N]["input"];
export type AcsMcpToolOutput<N extends AcsMcpToolName> = AcsMcpToolMap[N]["output"];
