import { describe, expect, test } from "bun:test";
import { mcpMessageIdentity } from "../packages/bridge-mcp-codex/src/index";

describe("Codex MCP bridge", () => {
  test("prefers host call identity and warns only for a fresh fallback", () => {
    expect(mcpMessageIdentity(42, "thread-secret", "model-key")).toEqual({ messageId: "42" });
    const explicit = mcpMessageIdentity(undefined, "thread-secret", "model-key");
    expect(explicit).toEqual(mcpMessageIdentity(undefined, "thread-secret", "model-key"));
    expect(explicit.messageId).not.toContain("thread-secret");
    expect(explicit.messageId).not.toContain("model-key");
    expect(explicit.warning).toBeUndefined();
    const fresh = mcpMessageIdentity(undefined, "thread-secret");
    expect(fresh.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.warning).toContain("may duplicate");
  });
});
