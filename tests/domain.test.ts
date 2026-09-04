import { describe, expect, test } from "bun:test";
import { agentSlug, canonical, id, transition } from "../packages/domain/src/index";

describe("domain", () => {
  test("UUIDv7 IDs are prefixed and time-sortable", () => {
    const first = id("tsk", 1_000),
      second = id("tsk", 2_000),
      current = id("tsk", 1_788_533_373_305);
    expect(first).toMatch(
      /^tsk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first < second).toBe(true);
    expect(current.slice(4, 17)).toBe("01a06ce5-7979");
  });
  test("state transitions reject illegal and terminal changes", () => {
    expect(transition("submitted", "working")).toBe("working");
    expect(transition("completed", "completed")).toBe("completed");
    expect(() => transition("completed", "working")).toThrow("TASK_STATE_CONFLICT");
  });
  test("normalization is deterministic", () => {
    expect(agentSlug("@backend")).toBe("backend");
    expect(canonical({ b: 1, a: [2] })).toBe('{"a":[2],"b":1}');
  });
});
