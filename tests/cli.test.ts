import { expect, test } from "bun:test";
import { pickSession } from "../apps/acs/src/session-picker";

const sessions = [
  {
    session: { installationId: "ins_codex", opaqueId: "thread-one" },
    availability: "idle",
    title: "Architect",
    cwd: "/workspace/architect",
  },
  {
    session: { installationId: "ins_codex", opaqueId: "thread-two" },
    availability: "dormant",
    title: "Backend",
  },
];

test("interactive Codex binding selects a discovered session without copying its ID", async () => {
  let prompt = "";
  expect(
    await pickSession(sessions, async (value) => {
      prompt = value;
      return "2";
    }),
  ).toEqual({ installationId: "ins_codex", opaqueId: "thread-two" });
  expect(prompt).toContain("Architect [idle] /workspace/architect");
  expect(prompt).toContain("Backend [dormant]");
  expect(prompt).not.toContain("thread-two");
});

test("interactive Codex binding rejects missing, malformed, and out-of-range choices", async () => {
  expect(pickSession([], async () => "1")).rejects.toThrow("No Codex sessions found");
  for (const answer of ["", "backend", "0", "3", "1.5"])
    expect(pickSession(sessions, async () => answer)).rejects.toThrow("Invalid session selection");
});
