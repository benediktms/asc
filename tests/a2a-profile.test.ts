import { describe, expect, test } from "bun:test";
import { loadA2AProfile, parseA2AProfile } from "../scripts/a2a-profile";

describe("A2A profile manifest", () => {
  test("keeps every expected failure reviewable and uniquely classified", () => {
    const profile = loadA2AProfile();
    expect(profile.profile).toBe("asc-a2a-v1");
    expect(profile.protocolVersion).toBe("1.0");
    expect(profile.expectedFailures.length).toBeGreaterThan(0);
    expect(new Set(profile.expectedFailures.map((entry) => entry.requirement)).size).toBe(
      profile.expectedFailures.length,
    );
    for (const entry of profile.expectedFailures) {
      expect(entry.level).toBe("MUST");
      expect(entry.spec.url).toStartWith("https://");
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.review.condition.length).toBeGreaterThan(0);
    }
  });

  test("rejects duplicate and incomplete exceptions", () => {
    const profile = loadA2AProfile(),
      duplicate = {
        ...profile,
        expectedFailures: [profile.expectedFailures[0], profile.expectedFailures[0]],
      },
      incomplete = {
        ...profile,
        expectedFailures: [{ ...profile.expectedFailures[0], review: {} }],
      };
    expect(() => parseA2AProfile(duplicate)).toThrow("Duplicate");
    expect(() => parseA2AProfile(incomplete)).toThrow("review condition");
  });
});
