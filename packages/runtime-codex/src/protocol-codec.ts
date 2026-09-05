import { createHash } from "node:crypto";
import type {
  CodexFunctionCallOutputDto,
  CodexJson,
} from "../../../contracts/codex-app-server-boundary";
import type { RuntimeDeliveryEnvelopeV1 } from "../../../contracts/runtime-adapter";
import { canonical } from "../../domain/src/index";
import testedVersion from "../../codex-protocol-generated/CODEX_VERSION" with { type: "text" };
import clientRequestSchema from "../../codex-protocol-generated/schema/ClientRequest.json" with { type: "text" };
import serverNotificationSchema from "../../codex-protocol-generated/schema/ServerNotification.json" with { type: "text" };
import serverRequestMethods from "../../codex-protocol-generated/schema/ServerRequestMethods.json";
import type { ResponseItem } from "../../codex-protocol-generated/src/ResponseItem";

export const TESTED_CODEX_VERSION = testedVersion.trim();
export const SUPPORTED_CODEX_VERSIONS = Object.freeze([TESTED_CODEX_VERSION, "0.153.4"]);
export const CODEX_PROTOCOL_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(clientRequestSchema))
  .update("\0")
  .update(JSON.stringify(serverNotificationSchema))
  .update("\0")
  .update(JSON.stringify(serverRequestMethods))
  .digest("hex");

export function supportsCodexVersion(version: string | undefined): boolean {
  return version !== undefined && SUPPORTED_CODEX_VERSIONS.includes(version);
}

export function responseItem(envelope: RuntimeDeliveryEnvelopeV1): CodexFunctionCallOutputDto {
  return {
    type: "function_call_output",
    name: "receive_agent_message",
    namespace: "acs",
    output: canonical(envelope),
  } satisfies ResponseItem;
}

export function jsonValue(json: string): CodexJson {
  const value: unknown = JSON.parse(json);
  if (!isJsonValue(value)) throw new Error("runtime envelope is not JSON");
  return value;
}

function isJsonValue(value: unknown): value is CodexJson {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.values(value).every((item) => item === undefined || isJsonValue(item))
  );
}
