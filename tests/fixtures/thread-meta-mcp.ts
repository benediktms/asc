import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const output = process.env.ACS_META_OUTPUT;
if (!output) throw new Error("ACS_META_OUTPUT is required");

const server = new McpServer({ name: "acs-thread-meta-probe", version: "1" });
server.registerTool(
  "capture_thread_meta",
  { description: "Capture the host-owned Codex thread identifier for an ACS integration test" },
  async (extra) => {
    const metadata = extra._meta,
      threadId = metadata && typeof metadata.threadId === "string" ? metadata.threadId : "missing";
    appendFileSync(output, `${threadId}\n`);
    return { content: [{ type: "text", text: "captured" }] };
  },
);
await server.connect(new StdioServerTransport());
