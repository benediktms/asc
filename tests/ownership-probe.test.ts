import { describe, expect, test } from "bun:test";
import { ownershipProbeEvent, parseOwnershipProbeArgs } from "../scripts/probe-codex-ownership";

describe("Codex ownership probe", () => {
  test("records routing evidence without message content", () => {
    const event = ownershipProbeEvent("observer-a", "request", "item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ prompt: "sensitive prompt", answers: ["secret answer"] }],
    });
    expect(event).toMatchObject({
      client: "observer-a",
      direction: "request",
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(JSON.stringify(event)).not.toContain("sensitive prompt");
    expect(JSON.stringify(event)).not.toContain("secret answer");
    expect(event.shape).toContain("questions[].prompt:string");
  });

  test("records the exact runtime version without retaining the full user agent", () => {
    const event = ownershipProbeEvent("observer-a", "lifecycle", "connected", {
      userAgent: "codex_cli_rs/0.153.4 (Linux 6.8; x86_64)",
    });
    expect(event.runtimeVersion).toBe("0.153.4");
    expect(JSON.stringify(event)).not.toContain("Linux 6.8");
  });

  test("fingerprints visible configuration without retaining thread content", () => {
    const first = ownershipProbeEvent("observer-a", "snapshot", "before", {
        thread: { model: "model-a", preview: "private preview", turns: [{ text: "private" }] },
      }),
      second = ownershipProbeEvent("observer-a", "snapshot", "after", {
        thread: { model: "model-b", preview: "private preview", turns: [{ text: "private" }] },
      });
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("model-a");
  });

  test("requires explicit output and resume target", () => {
    expect(() => parseOwnershipProbeArgs(["--socket", "/tmp/app.sock"])).toThrow(
      "--output is required",
    );
    expect(() => parseOwnershipProbeArgs(["--unknown", "value"])).toThrow(
      "unknown option: --unknown",
    );
    expect(() =>
      parseOwnershipProbeArgs([
        "--socket",
        "/tmp/app.sock",
        "--output",
        "/tmp/evidence.ndjson",
        "--scenario",
        "resume",
      ]),
    ).toThrow("--thread is required for resume");
  });

  test("parses a bounded reconnect scenario", () => {
    expect(
      parseOwnershipProbeArgs([
        "--socket",
        "/tmp/app.sock",
        "--output",
        "/tmp/evidence.ndjson",
        "--scenario",
        "reconnect",
        "--duration-ms",
        "250",
        "--phase-ms",
        "10",
      ]),
    ).toEqual({
      socket: "/tmp/app.sock",
      output: "/tmp/evidence.ndjson",
      scenario: "reconnect",
      durationMs: 250,
      phaseMs: 10,
      threadId: undefined,
    });
  });
});
