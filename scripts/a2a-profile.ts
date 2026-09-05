import { readFileSync } from "node:fs";

export interface ExpectedFailure {
  readonly requirement: string;
  readonly level: "MUST" | "SHOULD" | "MAY";
  readonly classification:
    | "implementation-defect"
    | "intentional-optional-behavior"
    | "permitted-profile-choice"
    | "tck-defect"
    | "test-fixture-idempotency-collision";
  readonly spec: { readonly section: string; readonly url: string };
  readonly decision: string;
  readonly evidence: readonly string[];
  readonly upstreamIssue?: string;
  readonly review: { readonly condition: string };
}

export interface A2AProfileManifest {
  readonly profile: "asc-a2a-v1";
  readonly protocolVersion: "1.0";
  readonly tckRevision: string;
  readonly reviewedAt: string;
  readonly expectedFailures: readonly ExpectedFailure[];
}

export function loadA2AProfile(): A2AProfileManifest {
  return parseA2AProfile(
    JSON.parse(
      readFileSync(new URL("../conformance/a2a-profile-v1.json", import.meta.url), "utf8"),
    ),
  );
}

export function parseA2AProfile(value: unknown): A2AProfileManifest {
  const manifest = record(value, "profile manifest");
  if (manifest.profile !== "asc-a2a-v1") throw new Error("Invalid A2A profile name");
  if (manifest.protocolVersion !== "1.0") throw new Error("Invalid A2A protocol version");
  if (typeof manifest.tckRevision !== "string" || !/^[0-9a-f]{40}$/.test(manifest.tckRevision))
    throw new Error("Invalid A2A TCK revision");
  if (typeof manifest.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.reviewedAt))
    throw new Error("Invalid A2A profile review date");
  if (!Array.isArray(manifest.expectedFailures))
    throw new Error("Invalid A2A expected-failure list");
  const expectedFailures = manifest.expectedFailures.map(expectedFailure),
    requirements = expectedFailures.map((entry) => entry.requirement);
  if (new Set(requirements).size !== requirements.length)
    throw new Error("Duplicate A2A expected-failure requirement");
  return {
    profile: manifest.profile,
    protocolVersion: manifest.protocolVersion,
    tckRevision: manifest.tckRevision,
    reviewedAt: manifest.reviewedAt,
    expectedFailures,
  };
}

function expectedFailure(value: unknown): ExpectedFailure {
  const entry = record(value, "expected failure"),
    spec = record(entry.spec, "expected-failure spec"),
    review = record(entry.review, "expected-failure review");
  if (typeof entry.requirement !== "string" || !entry.requirement)
    throw new Error("Invalid expected-failure requirement");
  if (entry.level !== "MUST" && entry.level !== "SHOULD" && entry.level !== "MAY")
    throw new Error(`Invalid requirement level for ${entry.requirement}`);
  if (
    entry.classification !== "implementation-defect" &&
    entry.classification !== "intentional-optional-behavior" &&
    entry.classification !== "permitted-profile-choice" &&
    entry.classification !== "tck-defect" &&
    entry.classification !== "test-fixture-idempotency-collision"
  )
    throw new Error(`Invalid classification for ${entry.requirement}`);
  if (
    typeof spec.section !== "string" ||
    !spec.section ||
    typeof spec.url !== "string" ||
    !spec.url.startsWith("https://")
  )
    throw new Error(`Invalid spec citation for ${entry.requirement}`);
  if (typeof entry.decision !== "string" || !entry.decision)
    throw new Error(`Missing decision for ${entry.requirement}`);
  if (
    !Array.isArray(entry.evidence) ||
    !entry.evidence.length ||
    !entry.evidence.every((item) => typeof item === "string" && item.startsWith("https://"))
  )
    throw new Error(`Invalid evidence for ${entry.requirement}`);
  if (
    entry.upstreamIssue !== undefined &&
    (typeof entry.upstreamIssue !== "string" || !entry.upstreamIssue.startsWith("https://"))
  )
    throw new Error(`Invalid upstream issue for ${entry.requirement}`);
  if (typeof review.condition !== "string" || !review.condition)
    throw new Error(`Missing review condition for ${entry.requirement}`);
  return {
    requirement: entry.requirement,
    level: entry.level,
    classification: entry.classification,
    spec: { section: spec.section, url: spec.url },
    decision: entry.decision,
    evidence: entry.evidence,
    upstreamIssue: entry.upstreamIssue,
    review: { condition: review.condition },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return Object.fromEntries(Object.entries(value));
}

if (import.meta.main) {
  const profile = loadA2AProfile();
  if (process.argv.includes("--revision")) console.log(profile.tckRevision);
  else
    console.log(
      `${profile.profile}: ${profile.expectedFailures.length} reviewed exceptions at TCK ${profile.tckRevision}`,
    );
}
