import {
  CodexAppServerError,
  type CodexAppServerFailureDto,
  type CodexFunctionCallOutputDto,
  type CodexJson,
} from "../../../contracts/codex-app-server-boundary";
import type {
  RuntimeAvailability,
  RuntimeDeliveryEnvelopeV1,
} from "../../../contracts/runtime-adapter";
import { canonical } from "../../domain/src/index";
import type { ResponseItem } from "../profiles/codex-app-server-v1/generated/src/ResponseItem";
import { CODEX_PROTOCOL_FINGERPRINT, type CodexCompatibilityProfile } from "./compatibility";

export interface CodexProtocolCodec {
  readonly profileId: string;
  readonly schemaDigest: string;
  validateRequest(method: string, params: unknown): boolean;
  validateResponse(method: string, result: unknown): boolean;
  normalizeStatus(status: { readonly type: string }): RuntimeAvailability;
  renderDeliveryEnvelope(envelope: RuntimeDeliveryEnvelopeV1): CodexFunctionCallOutputDto;
  parseHistoryMarker(value: unknown, deliveryId: string): boolean;
  translateError(error: unknown): CodexAppServerFailureDto | undefined;
}

export function createCodexProtocolCodec(profile: CodexCompatibilityProfile): CodexProtocolCodec {
  return {
    profileId: profile.profileId,
    schemaDigest: CODEX_PROTOCOL_FINGERPRINT,
    validateRequest: (method, params) =>
      typeof method === "string" && method.length > 0 && isRecord(params),
    validateResponse: (method, result) =>
      typeof method === "string" && method.length > 0 && isRecord(result),
    normalizeStatus,
    renderDeliveryEnvelope: responseItem,
    parseHistoryMarker(value, deliveryId) {
      if (typeof value !== "string") return false;
      try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) && parsed.deliveryId === deliveryId;
      } catch {
        return false;
      }
    },
    translateError(error) {
      return error instanceof CodexAppServerError ? error.failure : undefined;
    },
  };
}

export function responseItem(envelope: RuntimeDeliveryEnvelopeV1): CodexFunctionCallOutputDto {
  return {
    type: "function_call_output",
    name: "receive_agent_message",
    namespace: "acs",
    output: canonical(envelope),
  } satisfies ResponseItem;
}

function normalizeStatus(value: { readonly type: string }): RuntimeAvailability {
  switch (value.type) {
    case "idle":
      return "idle";
    case "active":
      return "busy";
    case "notLoaded":
      return "dormant";
    case "systemError":
      return "degraded";
    default:
      return "unknown";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
