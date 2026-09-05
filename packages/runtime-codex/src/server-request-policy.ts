import serverRequestMethods from "../../codex-protocol-generated/schema/ServerRequestMethods.json";

export const CODEX_SERVER_REQUEST_POLICY_VERSION = "codex-server-request-ownership-v1" as const;

export type CodexServerRequestAction =
  | "observe-only"
  | "owned-by-local-client"
  | "safe-to-answer"
  | "unsupported-fail-closed";

export type CodexServerRequestKind =
  | "approval"
  | "question"
  | "elicitation"
  | "authentication"
  | "unknown";

export interface CodexServerRequestPolicy {
  readonly action: CodexServerRequestAction;
  readonly kind: CodexServerRequestKind;
  readonly blocksExecution: boolean;
}

const localApproval = {
  action: "owned-by-local-client",
  kind: "approval",
  blocksExecution: true,
} as const;

/**
 * Exhaustive policy for the server-request schema generated from Codex 0.153.2.
 * Codex 0.153.4 has the same generated schema and uses this policy version too.
 * No entry grants ASC authority to answer a server request.
 */
export const CODEX_SERVER_REQUEST_POLICIES: Readonly<Record<string, CodexServerRequestPolicy>> =
  Object.freeze({
    "item/commandExecution/requestApproval": localApproval,
    "item/fileChange/requestApproval": localApproval,
    "item/tool/requestUserInput": {
      action: "observe-only",
      kind: "question",
      blocksExecution: true,
    },
    "mcpServer/elicitation/request": {
      action: "owned-by-local-client",
      kind: "elicitation",
      blocksExecution: true,
    },
    "item/permissions/requestApproval": localApproval,
    "item/tool/call": {
      action: "unsupported-fail-closed",
      kind: "unknown",
      blocksExecution: true,
    },
    "account/chatgptAuthTokens/refresh": {
      action: "owned-by-local-client",
      kind: "authentication",
      blocksExecution: true,
    },
    "attestation/generate": {
      action: "unsupported-fail-closed",
      kind: "authentication",
      blocksExecution: true,
    },
    "currentTime/read": {
      action: "unsupported-fail-closed",
      kind: "unknown",
      blocksExecution: true,
    },
    applyPatchApproval: localApproval,
    execCommandApproval: localApproval,
  });

export const CODEX_SERVER_REQUEST_METHODS = Object.freeze(
  serverRequestMethods satisfies readonly string[],
);

export function codexServerRequestPolicy(method: string): CodexServerRequestPolicy {
  return (
    CODEX_SERVER_REQUEST_POLICIES[method] ?? {
      action: "unsupported-fail-closed",
      kind: "unknown",
      blocksExecution: true,
    }
  );
}
