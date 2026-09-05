import { describe, expect, test } from "bun:test";
import {
  CODEX_COMPATIBILITY_PROFILES,
  CODEX_PROTOCOL_FINGERPRINT,
  CodexCallerAttestor,
  selectCodexCompatibility,
} from "../packages/runtime-codex/src/index";
import { createCodexProtocolCodec } from "../packages/runtime-codex/src/protocol-codec";

const callerEvidence = (metadata?: Readonly<Record<string, unknown>>) => ({
  harnessId: "codex",
  bridge: "mcp" as const,
  bridgeInstanceId: "bridge-1",
  metadata,
});

describe("Codex compatibility profiles", () => {
  test("selects both reviewed builds through an exact profile", () => {
    for (const version of ["0.153.2", "0.153.4"])
      expect(selectCodexCompatibility(version)).toMatchObject({
        state: "tested",
        profile: { profileId: "codex-app-server-v1" },
      });
  });

  test("does not authorize an unreviewed build with the same schema", () => {
    expect(selectCodexCompatibility("0.154.0")).toMatchObject({
      state: "candidate-compatible",
      reason: "unreviewed-version",
    });
    expect(selectCodexCompatibility(undefined)).toMatchObject({ state: "incompatible" });
  });

  test("rejects a known build when its schema digest differs", () => {
    expect(selectCodexCompatibility("0.153.2", "0".repeat(64))).toMatchObject({
      state: "incompatible",
      reason: "schema-digest-mismatch",
    });
    expect(CODEX_PROTOCOL_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
  });

  test("codec normalizes profile-specific wire values", () => {
    const profile = CODEX_COMPATIBILITY_PROFILES[0];
    if (!profile) throw new Error("missing test profile");
    const codec = createCodexProtocolCodec(profile);
    expect(codec.normalizeStatus({ type: "active" })).toBe("busy");
    expect(codec.normalizeStatus({ type: "future-state" })).toBe("unknown");
    expect(codec.parseHistoryMarker('{"deliveryId":"int_1"}', "int_1")).toBe(true);
    expect(codec.parseHistoryMarker("not-json", "int_1")).toBe(false);
    expect(codec.validateRequest("thread/read", { threadId: "thread-1" })).toBe(true);
    expect(codec.validateRequest("thread/read", null)).toBe(false);
  });
});

describe("Codex caller attestation decoder", () => {
  test("decodes host-owned metadata for root, resumed, and emulated fork calls", async () => {
    const attestor = new CodexCallerAttestor("ins_test", () => selectCodexCompatibility("0.153.2"));
    for (const threadId of ["root-thread", "resumed-thread", "emulated-fork-thread"])
      expect(await attestor.attest(callerEvidence({ threadId }))).toMatchObject({
        kind: "attested",
        scheme: "codex-mcp-thread-meta-v1",
        session: { opaqueId: threadId },
        attributes: { compatibilityProfile: "codex-app-server-v1" },
      });
  });

  test("fails closed for unsupported, missing, and malformed evidence", async () => {
    const unsupported = new CodexCallerAttestor("ins_test", () =>
        selectCodexCompatibility("99.0.0"),
      ),
      supported = new CodexCallerAttestor("ins_test", () => selectCodexCompatibility("0.153.4"));
    expect(await unsupported.attest(callerEvidence({ threadId: "thread-1" }))).toEqual({
      kind: "unattested",
      reason: "unsupported-runtime-version",
    });
    expect(await supported.attest(callerEvidence({}))).toEqual({
      kind: "unattested",
      reason: "missing-session-id",
    });
    expect(await supported.attest(callerEvidence({ threadId: ["one", "two"] }))).toEqual({
      kind: "unattested",
      reason: "invalid-session-id",
    });
  });

  test("ignores model-like arguments and non-identity metadata", async () => {
    const attestor = new CodexCallerAttestor("ins_test", () => selectCodexCompatibility("0.153.2"));
    expect(
      await attestor.attest(
        callerEvidence({
          threadId: "host-thread",
          arguments: { threadId: "forged-thread", bindingEpoch: 999 },
          sender: "forged-agent",
        }),
      ),
    ).toMatchObject({ session: { opaqueId: "host-thread" } });
  });
});
