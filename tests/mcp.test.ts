import { describe, expect, test } from "bun:test";
import { mcpMessageIdentity } from "../packages/bridge-mcp-codex/src/index";

describe("Codex MCP bridge", () => {
  test("prefers host call identity and warns for a fresh fallback", () => {
    expect(mcpMessageIdentity(42)).toEqual({ messageId: "42" });
    const explicit = mcpMessageIdentity(
      undefined,
      { threadId: "thread-1", turnId: "turn-1" },
      "request-1",
    );
    expect(explicit).toEqual(
      mcpMessageIdentity(undefined, { threadId: "thread-1", turnId: "turn-1" }, "request-1"),
    );
    expect(explicit.warning).toBeUndefined();
    const fresh = mcpMessageIdentity(undefined);
    expect(fresh.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fresh.warning).toContain("may duplicate");
  });
});
