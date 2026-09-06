import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { controlCall } from "../../protocol-control/src/index";
import { paths } from "../../config/src/index";
import { uuidV7 } from "../../domain/src/index";

const deliveryStatus = "urn:agent-communications:delivery-status:v1",
  cancellationStatus = "urn:agent-communications:cancellation:v1";
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
  attestationSchema = z.discriminatedUnion("kind", [
    z.looseObject({
      kind: z.literal("attested"),
      bindingId: z.string(),
      bindingEpoch: z.number(),
      session: z.object({ installationId: z.string(), opaqueId: z.string() }),
    }),
    z.looseObject({ kind: z.literal("unattested"), reason: z.string() }),
  ]),
  identitySchema = z.looseObject({
    attestation: attestationSchema,
    agent: agentSchema.optional(),
  }),
  bindingSchema = z.looseObject({
    id: z.string(),
    epoch: z.number(),
    status: z.literal("active"),
  }),
  claimResultSchema = z.looseObject({
    agent: agentSchema,
    binding: bindingSchema,
    idempotent: z.boolean(),
  }),
  agentResultSchema = z.looseObject({ agent: agentSchema }),
  agentPageSchema = z.looseObject({
    items: z.array(agentSchema),
    nextCursor: z.string().optional(),
  }),
  tokenSchema = z.looseObject({ token: z.string(), expiresAt: z.string() }),
  targetSchema = z.looseObject({ slug: z.string() }),
  taskSchema = z.looseObject({
    id: z.string(),
    contextId: z.string(),
    status: z.looseObject({ state: z.union([z.string(), z.number()]) }),
    metadata: z
      .looseObject({
        [deliveryStatus]: z
          .looseObject({ deliveryId: z.string(), duplicate: z.boolean().optional() })
          .optional(),
        [cancellationStatus]: z.looseObject({ requested: z.boolean() }).optional(),
      })
      .optional(),
  }),
  taskResultSchema = z.looseObject({ task: taskSchema }),
  executorResultSchema = z.looseObject({
    task: z.looseObject({ id: z.string(), state: z.string() }),
    eventSequence: z.number(),
  }),
  inboxResultSchema = z.looseObject({
    items: z.array(z.looseObject({ id: z.string(), state: z.string() })),
    nextCursor: z.string().optional(),
  }),
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
      data: z.json(),
      name: z.string(),
      mediaType: z.string(),
    }),
  ]);
type Attachment = z.infer<typeof attachment>;
const hostMetadataSchema = z.record(z.string(), z.unknown());
const hostMetadata = (extra: unknown) => {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return undefined;
  const parsed = hostMetadataSchema.safeParse(extra._meta);
  return parsed.success ? parsed.data : undefined;
};

export function mcpMessageIdentity(
  hostRequestId: unknown,
  metadata?: Record<string, unknown>,
  clientRequestId?: string,
) {
  if (typeof hostRequestId === "string" || typeof hostRequestId === "number")
    return { messageId: String(hostRequestId) };
  if (
    typeof metadata?.threadId === "string" &&
    typeof metadata.turnId === "string" &&
    clientRequestId
  )
    return {
      messageId: createHash("sha256")
        .update(JSON.stringify([metadata.threadId, metadata.turnId, clientRequestId]))
        .digest("hex"),
    };
  return {
    messageId: uuidV7(),
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
      metadata: hostMetadata(extra),
      bridgeInstanceId: String(process.pid),
    }),
    attest = async (extra: unknown) => {
      const attestation = await typedCall(
        "bridge.attestCaller",
        { evidence: evidence(extra) },
        attestationSchema,
      );
      if (attestation.kind !== "attested")
        throw new Error(`UNATTESTED_CALLER: ${attestation.reason}`);
      return attestation;
    },
    issueA2AToken = (attestation: Awaited<ReturnType<typeof attest>>, extra: unknown) =>
      typedCall(
        "bridge.issueA2AToken",
        {
          evidence: evidence(extra),
          bindingId: attestation.bindingId,
          bindingEpoch: attestation.bindingEpoch,
          scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
        },
        tokenSchema,
      );
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
          agent: identity.agent
            ? {
                id: identity.agent.id,
                slug: identity.agent.slug,
                displayName: identity.agent.displayName,
              }
            : undefined,
          harness: "codex",
          bindingEpoch: identity.attestation.bindingEpoch,
          remediation:
            identity.agent?.availability === "dormant"
              ? "This thread is not loaded on ACS's connected app-server. Read messages with acs_inbox_list and acs_task_get, or resume through codex --remote unix:// for automatic delivery."
              : undefined,
        };
      }),
  );
  server.registerTool(
    "acs_claim",
    {
      description: "Bind this Codex thread using a one-time ACS claim code",
      inputSchema: {
        claimCode: z.string().min(1).max(64),
        continuityPolicy: z.enum(["follow-pending", "strict"]).optional(),
        revokeExisting: z.boolean().optional(),
      },
    },
    async ({ claimCode, continuityPolicy, revokeExisting }, extra) =>
      execute(async () => {
        const claimed = await typedCall(
          "bindings.claim",
          {
            claimCode,
            continuityPolicy,
            revokeExisting,
            evidence: evidence(extra),
          },
          claimResultSchema,
        );
        return {
          agent: {
            id: claimed.agent.id,
            slug: claimed.agent.slug,
            displayName: claimed.agent.displayName,
          },
          binding: claimed.binding,
          idempotent: claimed.idempotent,
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
        return { agents: page.items.map(agentView), nextCursor: page.nextCursor };
      }),
  );
  server.registerTool(
    "acs_agent_get",
    { description: "Get one logical ACS agent", inputSchema: { agent: z.string() } },
    async ({ agent }) =>
      execute(async () =>
        agentView((await typedCall("agents.get", { agent }, agentResultSchema)).agent),
      ),
  );
  server.registerTool(
    "acs_send",
    {
      description: "Durably send an A2A task to another logical agent",
      inputSchema: z.strictObject({
        to: z.string(),
        text: z.string().min(1).max(65536),
        taskId: z.string().optional(),
        contextId: z.string().optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        replyExpected: z.boolean().optional(),
        notifyOn: z
          .array(
            z.enum([
              "working",
              "input-required",
              "completed",
              "failed",
              "canceled",
              "rejected",
              "terminal",
            ]),
          )
          .optional(),
        attachments: z.array(attachment).optional(),
        clientRequestId: z.string().optional(),
      }),
    },
    async (args, extra) =>
      execute(async () => {
        const caller = await attest(extra),
          identity = mcpMessageIdentity(extra.requestId, hostMetadata(extra), args.clientRequestId),
          auth = await issueA2AToken(caller, extra),
          agent = await typedCall("agents.get", { agent: args.to }, agentResultSchema);
        const rpc = taskResultSchema.parse(
          await a2a(port, agent.agent.slug, auth.token, "SendMessage", {
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
                priority: args.priority,
                replyExpected: args.replyExpected,
                notifyOn: args.notifyOn,
              },
            },
          }),
        );
        return withWarning(acceptedTask(rpc.task), identity.warning);
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
        const caller = await attest(extra),
          auth = await issueA2AToken(caller, extra),
          target = await typedCall(
            "bridge.taskTarget",
            { evidence: evidence(extra), taskId: args.taskId },
            targetSchema,
          );
        const task = taskSchema.parse(
          await a2a(port, target.slug, auth.token, "GetTask", {
            id: args.taskId,
            historyLength: args.historyLength,
          }),
        );
        return { task, deliveryId: task.metadata?.[deliveryStatus]?.deliveryId };
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
        const caller = await attest(extra),
          identity = mcpMessageIdentity(extra.requestId, hostMetadata(extra), args.clientRequestId),
          auth = await issueA2AToken(caller, extra),
          target = await typedCall(
            "bridge.taskTarget",
            { evidence: evidence(extra), taskId: args.taskId },
            targetSchema,
          );
        const rpc = taskResultSchema.parse(
            await a2a(port, target.slug, auth.token, "SendMessage", {
              message: {
                messageId: identity.messageId,
                taskId: args.taskId,
                role: "ROLE_USER",
                parts: parts(args.text, args.attachments),
              },
              configuration: { returnImmediately: true },
            }),
          ),
          accepted = acceptedTask(rpc.task);
        return withWarning(
          { taskId: accepted.taskId, state: accepted.state, deliveryId: accepted.deliveryId },
          identity.warning,
        );
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
        const caller = await attest(extra),
          auth = await issueA2AToken(caller, extra),
          target = await typedCall(
            "bridge.taskTarget",
            { evidence: evidence(extra), taskId: args.taskId },
            targetSchema,
          );
        const task = taskSchema.parse(
            await a2a(port, target.slug, auth.token, "CancelTask", {
              id: args.taskId,
              metadata: args.reason ? { reason: args.reason } : undefined,
            }),
          ),
          state = taskState(task.status.state);
        return {
          taskId: task.id,
          state,
          cancellationRequested:
            state === "canceled" || task.metadata?.[cancellationStatus]?.requested === true,
        };
      }),
  );
  server.registerTool(
    "acs_task_acknowledge",
    {
      description: "Acknowledge an inbox task and start working on it",
      inputSchema: { taskId: z.string(), deliveryId: z.string() },
    },
    async (args, extra) =>
      execute(async () => {
        await attest(extra);
        const acknowledged = await typedCall(
          "executor.task.acknowledge",
          { ...args, evidence: evidence(extra) },
          executorResultSchema,
        );
        return {
          taskId: acknowledged.task.id,
          state: "working",
          eventSequence: acknowledged.eventSequence,
        };
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
      execute(async () => {
        await attest(extra);
        const completed = await typedCall(
          "executor.task.complete",
          { ...args, evidence: evidence(extra) },
          executorResultSchema,
        );
        return {
          taskId: completed.task.id,
          state: "completed",
          eventSequence: completed.eventSequence,
        };
      }),
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
      execute(async () => {
        await attest(extra);
        const failed = await typedCall(
          "executor.task.fail",
          { ...args, evidence: evidence(extra) },
          executorResultSchema,
        );
        return {
          taskId: failed.task.id,
          state: "failed",
          eventSequence: failed.eventSequence,
        };
      }),
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
      execute(async () => {
        await attest(extra);
        const requested = await typedCall(
          "executor.task.requestInput",
          { ...args, evidence: evidence(extra) },
          executorResultSchema,
        );
        return {
          taskId: requested.task.id,
          state: "input-required",
          eventSequence: requested.eventSequence,
        };
      }),
  );
  server.registerTool(
    "acs_inbox_list",
    {
      description: "List non-terminal tasks assigned to this logical agent",
      inputSchema: {
        states: z.array(z.enum(["submitted", "working", "input-required"])).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args, extra) =>
      execute(async () => {
        const page = await typedCall(
          "inbox.list",
          { ...args, evidence: evidence(extra) },
          inboxResultSchema,
        );
        return { tasks: page.items, nextCursor: page.nextCursor };
      }),
  );
  await server.connect(new StdioServerTransport());
}

function agentView(agent: z.infer<typeof agentSchema>) {
  return {
    id: agent.id,
    slug: agent.slug,
    displayName: agent.displayName,
    description: agent.description,
    availability: agent.availability,
    skills: agent.skills
      .map((skill) => skill.id ?? skill.name)
      .filter((skill): skill is string => typeof skill === "string"),
  };
}

function acceptedTask(task: z.infer<typeof taskSchema>) {
  const status = task.metadata?.[deliveryStatus];
  if (!status) throw new Error("Invalid A2A acceptance metadata");
  return {
    taskId: task.id,
    contextId: task.contextId,
    state: taskState(task.status.state),
    deliveryId: status.deliveryId,
    duplicate: status.duplicate ?? false,
  };
}

function taskState(state: string | number) {
  if (typeof state === "string")
    return state
      .replace(/^TASK_STATE_/, "")
      .toLowerCase()
      .replaceAll("_", "-");
  return (
    [
      "unspecified",
      "submitted",
      "working",
      "completed",
      "failed",
      "canceled",
      "input-required",
      "rejected",
      "auth-required",
    ][state] ?? "unknown"
  );
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
