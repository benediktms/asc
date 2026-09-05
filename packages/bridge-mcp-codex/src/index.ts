import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { controlCall } from "../../protocol-control/src/index";
import { paths } from "../../storage-sqlite/src/index";

const result = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: {
    schemaVersion: 1,
    ok: true,
    correlationId: crypto.randomUUID(),
    data,
  },
});
const execute = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
  try {
    return result(await operation());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error),
      code = message.split(":").at(0) ?? "UNKNOWN";
    return {
      isError: true,
      content: [{ type: "text", text: `${code}: ${message}` }],
      structuredContent: {
        schemaVersion: 1,
        ok: false,
        correlationId: crypto.randomUUID(),
        error: {
          code,
          message,
          retryable: ["ACS_OVERLOADED", "RUNTIME_UNAVAILABLE"].includes(code),
        },
      },
    };
  }
};
const agentSchema = z.looseObject({
    id: z.string(),
    slug: z.string(),
    displayName: z.string(),
    description: z.string(),
    availability: z.string(),
    skills: z.array(
      z.looseObject({
        id: z.string().optional(),
        name: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    ),
  }),
  identitySchema = z.looseObject({
    attestation: z.looseObject({
      kind: z.string(),
      reason: z.string().optional(),
      bindingEpoch: z.number().optional(),
    }),
    agent: agentSchema.optional(),
  }),
  agentResultSchema = z.looseObject({ agent: agentSchema }),
  agentPageSchema = z.looseObject({
    items: z.array(agentSchema),
    nextCursor: z.string().optional(),
  }),
  tokenSchema = z.looseObject({ token: z.string() }),
  targetSchema = z.looseObject({ slug: z.string() }),
  attachment = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("uri"),
      uri: z.string(),
      name: z.string().optional(),
      mediaType: z.string().optional(),
      description: z.string().optional(),
    }),
    z.object({
      kind: z.literal("data"),
      data: z.unknown(),
      name: z.string(),
      mediaType: z.string(),
    }),
  ]);
type Attachment = z.infer<typeof attachment>;
const threadId = (extra: unknown) => {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return undefined;
  const metadata = extra._meta;
  if (typeof metadata !== "object" || metadata === null || !("threadId" in metadata))
    return undefined;
  return typeof metadata.threadId === "string" ? metadata.threadId : undefined;
};

export function mcpMessageIdentity(
  hostRequestId: unknown,
  callerThreadId: string,
  clientRequestId?: string,
) {
  if (typeof hostRequestId === "string" || typeof hostRequestId === "number")
    return { messageId: String(hostRequestId) };
  if (clientRequestId)
    return {
      messageId: `mcp_${createHash("sha256")
        .update(`${callerThreadId}\0${clientRequestId}`)
        .digest("base64url")}`,
    };
  return {
    messageId: crypto.randomUUID(),
    warning: "Host-level retry may duplicate this request because no stable call ID was available.",
  };
}

export async function runMcp(port = 7432) {
  const config = paths(),
    call = (method: string, params: unknown = {}) =>
      controlCall(config.runtime, config.bridgeToken, method, params),
    typedCall = async <Output>(method: string, params: unknown, schema: z.ZodType<Output>) =>
      schema.parse(await call(method, params));
  await call("system.initialize", {
    protocolVersion: "1.0",
    client: { name: "acs-mcp-codex", version: "0.1.0", instanceId: String(process.pid) },
    capabilities: {},
  });
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
    async (extra) =>
      execute(async () => {
        const identity = await typedCall(
          "bridge.identity",
          { evidence: evidence(extra) },
          identitySchema,
        );
        return {
          state:
            identity.attestation.kind === "attested"
              ? "bound"
              : identity.attestation.reason === "unbound-session"
                ? "unbound"
                : "unattested",
          agent: identity.agent,
          harness: "codex",
          bindingEpoch: identity.attestation.bindingEpoch,
        };
      }),
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
    async (args) =>
      execute(async () => {
        const page = await typedCall(
          "agents.list",
          {
            availability:
              args.status === "available"
                ? ["idle"]
                : args.status === "unavailable"
                  ? ["unknown", "offline", "dormant", "busy", "awaiting-local-input", "degraded"]
                  : undefined,
            skill: args.skill,
            limit: args.limit,
            cursor: args.cursor,
          },
          agentPageSchema,
        );
        return { agents: page.items, nextCursor: page.nextCursor };
      }),
  );
  server.registerTool(
    "acs_agent_get",
    { description: "Get one logical ACS agent", inputSchema: { agent: z.string() } },
    async ({ agent }) =>
      execute(async () => (await typedCall("agents.get", { agent }, agentResultSchema)).agent),
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
    async (args, extra) =>
      execute(async () => {
        const tid = threadId(extra);
        if (!tid) throw new Error("UNATTESTED_CALLER");
        const identity = mcpMessageIdentity(extra.requestId, tid, args.clientRequestId),
          auth = await typedCall("bridge.issueA2AToken", { threadId: tid }, tokenSchema),
          agent = await typedCall("agents.get", { agent: args.to }, agentResultSchema);
        const rpc = await a2a(port, agent.agent.slug, auth.token, "SendMessage", {
          message: {
            messageId: identity.messageId,
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
        return withWarning(rpc, identity.warning);
      }),
  );
  server.registerTool(
    "acs_task_get",
    {
      description: "Get an A2A task requested by this agent",
      inputSchema: { taskId: z.string(), historyLength: z.number().int().min(0).optional() },
    },
    async (args, extra) =>
      execute(async () => {
        const tid = threadId(extra);
        if (!tid) throw new Error("UNATTESTED_CALLER");
        const auth = await typedCall("bridge.issueA2AToken", { threadId: tid }, tokenSchema),
          target = await typedCall(
            "bridge.taskTarget",
            { threadId: tid, taskId: args.taskId },
            targetSchema,
          );
        return await a2a(port, target.slug, auth.token, "GetTask", {
          id: args.taskId,
          historyLength: args.historyLength,
        });
      }),
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
    async (args, extra) =>
      execute(async () => {
        const tid = threadId(extra);
        if (!tid) throw new Error("UNATTESTED_CALLER");
        const identity = mcpMessageIdentity(extra.requestId, tid, args.clientRequestId),
          auth = await typedCall("bridge.issueA2AToken", { threadId: tid }, tokenSchema),
          target = await typedCall(
            "bridge.taskTarget",
            { threadId: tid, taskId: args.taskId },
            targetSchema,
          );
        const rpc = await a2a(port, target.slug, auth.token, "SendMessage", {
          message: {
            messageId: identity.messageId,
            taskId: args.taskId,
            role: "ROLE_USER",
            parts: parts(args.text, args.attachments),
          },
          configuration: { returnImmediately: true },
        });
        return withWarning(rpc, identity.warning);
      }),
  );
  server.registerTool(
    "acs_task_cancel",
    {
      description: "Cancel a task requested by this agent",
      inputSchema: { taskId: z.string(), reason: z.string().optional() },
    },
    async (args, extra) =>
      execute(async () => {
        const tid = threadId(extra);
        if (!tid) throw new Error("UNATTESTED_CALLER");
        const auth = await typedCall("bridge.issueA2AToken", { threadId: tid }, tokenSchema),
          target = await typedCall(
            "bridge.taskTarget",
            { threadId: tid, taskId: args.taskId },
            targetSchema,
          );
        return await a2a(port, target.slug, auth.token, "CancelTask", {
          id: args.taskId,
          metadata: args.reason ? { reason: args.reason } : undefined,
        });
      }),
  );
  server.registerTool(
    "acs_task_complete",
    {
      description: "Complete an assigned ACS task",
      inputSchema: {
        taskId: z.string(),
        summary: z.string().min(1),
        artifacts: z.array(attachment).optional(),
      },
    },
    async (args, extra) =>
      execute(() => call("executor.task.complete", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_task_fail",
    {
      description: "Fail an assigned ACS task",
      inputSchema: {
        taskId: z.string(),
        summary: z.string().min(1),
        retryable: z.boolean().optional(),
      },
    },
    async (args, extra) =>
      execute(() => call("executor.task.fail", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_task_request_input",
    {
      description: "Request input on an assigned ACS task",
      inputSchema: {
        taskId: z.string(),
        question: z.string().min(1),
        choices: z.array(z.string()).optional(),
        blocking: z.boolean().optional(),
      },
    },
    async (args, extra) =>
      execute(() => call("executor.task.requestInput", { ...args, threadId: threadId(extra) })),
  );
  server.registerTool(
    "acs_inbox_list",
    {
      description: "List non-terminal tasks assigned to this logical agent",
      inputSchema: {
        states: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args, extra) =>
      execute(() => call("inbox.list", { ...args, threadId: threadId(extra) })),
  );
  await server.connect(new StdioServerTransport());
}

function withWarning(value: unknown, warning?: string) {
  if (!warning) return value;
  if (!isRecord(value)) throw new Error("Invalid A2A task response");
  return { ...value, warning };
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
  const rpc: unknown = await response.json();
  if (!isRecord(rpc)) throw new Error("Invalid A2A response");
  const error =
    isRecord(rpc.error) && typeof rpc.error.message === "string" ? rpc.error.message : undefined;
  if (!response.ok || error) throw new Error(error ?? `${response.status} ${response.statusText}`);
  return rpc.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
