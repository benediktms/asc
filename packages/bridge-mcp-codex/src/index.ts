import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { controlCall } from "../../protocol-control/src/index";
import { paths } from "../../storage-sqlite/src/index";

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: {
    schemaVersion: 1 as const,
    ok: true as const,
    correlationId: crypto.randomUUID(),
    data,
  },
});
const attachment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("uri"),
    uri: z.string(),
    name: z.string().optional(),
    mediaType: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal("data"), data: z.unknown(), name: z.string(), mediaType: z.string() }),
]);
type Attachment = z.infer<typeof attachment>;
const threadId = (extra: unknown) => {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return undefined;
  const metadata = extra._meta;
  if (typeof metadata !== "object" || metadata === null || !("threadId" in metadata))
    return undefined;
  return typeof metadata.threadId === "string" ? metadata.threadId : undefined;
};

export async function runMcp(port = 7432) {
  const config = paths(),
    call = <T>(method: string, params: unknown = {}) =>
      controlCall<T>(config.runtime, config.bridgeToken, method, params);
  const server = new McpServer({ name: "acs", version: "0.1.0" });
  const evidence = (extra: unknown) => ({
    harnessId: "codex",
    bridge: "mcp",
    metadata: { threadId: threadId(extra) },
    bridgeInstanceId: String(process.pid),
  });
  server.registerTool(
    "acs_identity",
    { description: "Show the calling Codex thread's ACS identity" },
    async (extra) => result(await call("bridge.identity", { evidence: evidence(extra) })),
  );
  server.registerTool(
    "acs_agents_list",
    {
      description: "List logical ACS agents",
      inputSchema: {
        status: z.enum(["any", "available", "unavailable"]).optional(),
        skill: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async () => result(await call("agents.list")),
  );
  server.registerTool(
    "acs_agent_get",
    { description: "Get one logical ACS agent", inputSchema: { agent: z.string() } },
    async ({ agent }) => result(await call("agents.get", { agent })),
  );
  server.registerTool(
    "acs_send",
    {
      description: "Durably send an A2A task to another logical agent",
      inputSchema: {
        to: z.string(),
        text: z.string().min(1).max(65536),
        taskId: z.string().optional(),
        contextId: z.string().optional(),
        delivery: z.enum(["wake_when_idle", "append_context"]).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        replyExpected: z.boolean().optional(),
        notifyOn: z.array(z.string()).optional(),
        attachments: z.array(attachment).optional(),
        clientRequestId: z.string().optional(),
      },
    },
    async (args, extra) => {
      const tid = threadId(extra);
      if (!tid) throw new Error("UNATTESTED_CALLER");
      const auth = await call<{ token: string }>("bridge.issueA2AToken", { threadId: tid }),
        agent = await call<{ agent: { slug: string } }>("agents.get", { agent: args.to });
      const rpc = await a2a(port, agent.agent.slug, auth.token, "SendMessage", {
        message: {
          messageId: args.clientRequestId ?? String(extra.requestId),
          contextId: args.contextId,
          taskId: args.taskId,
          role: "ROLE_USER",
          parts: parts(args.text, args.attachments),
        },
        configuration: { returnImmediately: true },
        metadata: {
          "urn:agent-communications:delivery:v1": {
            mode: args.delivery,
            priority: args.priority,
            replyExpected: args.replyExpected,
            notifyOn: args.notifyOn,
          },
        },
      });
      return result(rpc);
    },
  );
  server.registerTool(
    "acs_task_get",
    {
      description: "Get an A2A task requested by this agent",
      inputSchema: { taskId: z.string(), historyLength: z.number().int().min(0).optional() },
    },
    async (args, extra) => {
      const tid = threadId(extra);
      if (!tid) throw new Error("UNATTESTED_CALLER");
      const auth = await call<{ token: string }>("bridge.issueA2AToken", { threadId: tid }),
        target = await call<{ slug: string }>("bridge.taskTarget", {
          threadId: tid,
          taskId: args.taskId,
        });
      return result(
        await a2a(port, target.slug, auth.token, "GetTask", {
          id: args.taskId,
          historyLength: args.historyLength,
        }),
      );
    },
  );
  server.registerTool(
    "acs_task_reply",
    {
      description: "Reply to a task that requested input",
      inputSchema: {
        taskId: z.string(),
        text: z.string().min(1).max(65536),
        attachments: z.array(attachment).optional(),
        clientRequestId: z.string().optional(),
      },
    },
    async (args, extra) => {
      const tid = threadId(extra);
      if (!tid) throw new Error("UNATTESTED_CALLER");
      const auth = await call<{ token: string }>("bridge.issueA2AToken", { threadId: tid }),
        target = await call<{ slug: string }>("bridge.taskTarget", {
          threadId: tid,
          taskId: args.taskId,
        });
      return result(
        await a2a(port, target.slug, auth.token, "SendMessage", {
          message: {
            messageId: args.clientRequestId ?? String(extra.requestId),
            taskId: args.taskId,
            role: "ROLE_USER",
            parts: parts(args.text, args.attachments),
          },
          configuration: { returnImmediately: true },
        }),
      );
    },
  );
  server.registerTool(
    "acs_task_cancel",
    {
      description: "Cancel a task requested by this agent",
      inputSchema: { taskId: z.string(), reason: z.string().optional() },
    },
    async (args, extra) => {
      const tid = threadId(extra);
      if (!tid) throw new Error("UNATTESTED_CALLER");
      const auth = await call<{ token: string }>("bridge.issueA2AToken", { threadId: tid }),
        target = await call<{ slug: string }>("bridge.taskTarget", {
          threadId: tid,
          taskId: args.taskId,
        });
      return result(
        await a2a(port, target.slug, auth.token, "CancelTask", {
          id: args.taskId,
          metadata: args.reason ? { reason: args.reason } : undefined,
        }),
      );
    },
  );
  server.registerTool(
    "acs_task_complete",
    {
      description: "Complete an assigned ACS task",
      inputSchema: { taskId: z.string(), summary: z.string().min(1) },
    },
    async (args, extra) =>
      result(await call("executor.task.complete", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_task_fail",
    {
      description: "Fail an assigned ACS task",
      inputSchema: { taskId: z.string(), summary: z.string().min(1) },
    },
    async (args, extra) =>
      result(await call("executor.task.fail", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_task_request_input",
    {
      description: "Request input on an assigned ACS task",
      inputSchema: { taskId: z.string(), question: z.string().min(1) },
    },
    async (args, extra) =>
      result(await call("executor.task.requestInput", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_inbox_list",
    {
      description: "List non-terminal tasks assigned to this logical agent",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async (_args, extra) => result(await call("inbox.list", { threadId: threadId(extra) })),
  );
  await server.connect(new StdioServerTransport());
}

function parts(text: string, attachments: Attachment[] = []) {
  return [
    { text },
    ...attachments.map((item) =>
      item.kind === "uri"
        ? {
            url: item.uri,
            filename: item.name,
            mediaType: item.mediaType,
            metadata: item.description ? { description: item.description } : undefined,
          }
        : { data: item.data, filename: item.name, mediaType: item.mediaType },
    ),
  ];
}

async function a2a(port: number, slug: string, token: string, method: string, params: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/agents/${slug}/a2a`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "A2A-Version": "1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const rpc = (await response.json()) as {
    error?: { message: string };
    result?: unknown;
  };
  if (!response.ok || rpc.error)
    throw new Error(rpc.error?.message ?? `${response.status} ${response.statusText}`);
  return rpc.result;
}
