import { createHash } from "node:crypto";
import type { RuntimeCapabilities } from "../../../contracts/runtime-adapter";
import manifestJson from "../profiles/compatibility-manifest.json" with { type: "json" };
import clientRequestSchema from "../profiles/codex-app-server-v1/generated/schema/ClientRequest.json" with { type: "json" };
import serverNotificationSchema from "../profiles/codex-app-server-v1/generated/schema/ServerNotification.json" with { type: "json" };
import serverRequestSchema from "../profiles/codex-app-server-v1/generated/schema/ServerRequest.json" with { type: "json" };

type CapabilityEvidence = { readonly supported: boolean; readonly evidence: readonly string[] };

export interface CodexCompatibilityManifest {
  readonly schemaVersion: number;
  readonly evidence: Readonly<Record<string, { readonly kind: string; readonly source: string }>>;
  readonly profiles: readonly CodexCompatibilityProfile[];
}

export interface CodexCompatibilityProfile {
  readonly profileId: string;
  readonly versions: readonly string[];
  readonly generatedTypesDirectory: string;
  readonly generation: {
    readonly command: string;
    readonly generatorVersion: string;
    readonly schemaDigest: string;
    readonly sourcePackage: string;
    readonly sourcePackageDigest: string;
  };
  readonly callerAttestation: {
    readonly decoderId: string;
    readonly requiredKeys: readonly string[];
    readonly optionalKeys: readonly string[];
    readonly ignoredKeys: readonly string[];
  };
  readonly capabilities: Readonly<Record<string, CapabilityEvidence>>;
  readonly versionEvidence: Readonly<Record<string, readonly string[]>>;
  readonly scenarioEvidence: Readonly<Record<string, string>>;
}

export type CodexCompatibilitySelection =
  | { readonly state: "tested"; readonly profile: CodexCompatibilityProfile }
  | {
      readonly state: "candidate-compatible";
      readonly profile: CodexCompatibilityProfile;
      readonly reason: "unreviewed-version";
    }
  | {
      readonly state: "incompatible";
      readonly profile?: CodexCompatibilityProfile;
      readonly reason: "schema-digest-mismatch" | "unknown-schema";
    };

export const CODEX_PROTOCOL_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(clientRequestSchema))
  .update("\0")
  .update(JSON.stringify(serverNotificationSchema))
  .update("\0")
  .update(JSON.stringify(serverRequestSchema))
  .digest("hex");

const compatibilityManifest: CodexCompatibilityManifest = manifestJson,
  manifestErrors = validateCodexCompatibilityManifest(compatibilityManifest);
if (manifestErrors.length)
  throw new Error(`Invalid Codex compatibility manifest: ${manifestErrors.join("; ")}`);
const manifestProfiles: readonly CodexCompatibilityProfile[] = compatibilityManifest.profiles;
export const CODEX_COMPATIBILITY_PROFILES = Object.freeze(manifestProfiles);
export const SUPPORTED_CODEX_VERSIONS = Object.freeze(
  CODEX_COMPATIBILITY_PROFILES.flatMap((profile) => profile.versions),
);
export const TESTED_CODEX_VERSION = CODEX_COMPATIBILITY_PROFILES.at(0)?.generation.generatorVersion;
if (!TESTED_CODEX_VERSION) throw new Error("Codex compatibility manifest has no profiles");

export function selectCodexCompatibility(
  version: string | undefined,
  observedSchemaDigest?: string,
): CodexCompatibilitySelection {
  const exact = CODEX_COMPATIBILITY_PROFILES.find((profile) =>
    profile.versions.includes(version ?? ""),
  );
  if (exact)
    return !observedSchemaDigest ||
      exact.generation.schemaDigest === normalizeDigest(observedSchemaDigest)
      ? { state: "tested", profile: exact }
      : { state: "incompatible", profile: exact, reason: "schema-digest-mismatch" };
  if (!version || !observedSchemaDigest) return { state: "incompatible", reason: "unknown-schema" };
  const normalizedDigest = normalizeDigest(observedSchemaDigest);
  const matchingSchema = CODEX_COMPATIBILITY_PROFILES.find(
    (profile) => profile.generation.schemaDigest === normalizedDigest,
  );
  return matchingSchema
    ? {
        state: "candidate-compatible",
        profile: matchingSchema,
        reason: "unreviewed-version",
      }
    : { state: "incompatible", reason: "unknown-schema" };
}

export function validateCodexCompatibilityManifest(manifest: CodexCompatibilityManifest): string[] {
  const errors: string[] = [],
    evidenceIds = new Set(Object.keys(manifest.evidence));
  if (manifest.schemaVersion !== 1)
    errors.push(`unsupported schemaVersion ${manifest.schemaVersion}`);
  for (const profile of manifest.profiles) {
    for (const [name, capability] of Object.entries(profile.capabilities)) {
      if (capability.supported && capability.evidence.length === 0)
        errors.push(`${profile.profileId}.${name} has no evidence`);
      validateEvidenceIds(errors, evidenceIds, profile.profileId, capability.evidence);
    }
    for (const version of profile.versions) {
      const evidence = profile.versionEvidence[version];
      if (!evidence?.length)
        errors.push(`${profile.profileId} version ${version} has no version evidence`);
      else validateEvidenceIds(errors, evidenceIds, `${profile.profileId}.${version}`, evidence);
    }
    for (const version of Object.keys(profile.versionEvidence))
      if (!profile.versions.includes(version))
        errors.push(`${profile.profileId} has evidence for undeclared version ${version}`);
    for (const [scenario, level] of Object.entries(profile.scenarioEvidence))
      if (!["real", "emulated", "unverified"].includes(level))
        errors.push(`${profile.profileId}.${scenario} has invalid evidence level ${level}`);
  }
  return errors;
}

function validateEvidenceIds(
  errors: string[],
  known: ReadonlySet<string>,
  owner: string,
  referenced: readonly string[],
) {
  for (const id of referenced)
    if (!known.has(id)) errors.push(`${owner} references missing evidence ${id}`);
}

function normalizeDigest(value: string) {
  return `sha256:${value.replace(/^sha256:/, "")}`;
}

export function supportsCodexVersion(version: string | undefined): boolean {
  return selectCodexCompatibility(version).state === "tested";
}

export function profileCapabilities(profile?: CodexCompatibilityProfile): RuntimeCapabilities {
  const enabled = (name: string) => profile?.capabilities[name]?.supported === true;
  return {
    listSessions: enabled("listSessions"),
    observeSessionState: enabled("observeSessionState"),
    observeExecutions: enabled("observeExecutions"),
    appendContext: enabled("appendContext"),
    wakeWhenIdle: enabled("wakeWhenIdle"),
    atomicDeferredWake: enabled("atomicDeferredWake"),
    steerActiveExecution: enabled("steerActiveExecution"),
    cancelOwnedExecution: enabled("cancelOwnedExecution"),
    reconcileDelivery: enabled("reconcileDelivery"),
    callerAttestationSchemes: enabled("callerAttestation")
      ? [profile?.callerAttestation.decoderId ?? ""]
      : [],
    supportedPartKinds: enabled("appendContext") ? ["text", "uri", "data"] : [],
  };
}
