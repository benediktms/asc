import {
  AgentCard,
  TaskState,
  type CancelTaskRequest,
  type GetExtendedAgentCardRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  Task,
  type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import {
  JsonRpcContentTypeNotSupportedError,
  JsonRpcPushNotificationNotSupportedError,
  JsonRpcTaskNotCancelableError,
  JsonRpcTaskNotFoundError,
  JsonRpcTransportError,
  JsonRpcUnsupportedOperationError,
  JsonRpcVersionNotSupportedError,
  toJsonRpcError,
} from "@a2a-js/sdk/errors";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import type { AgentRow, Store, StoredTask } from "../../storage-sqlite/src/index";
import { telemetry } from "../../observability/src/index";

const extension = "urn:agent-communications:delivery:v1";
class PrincipalUser {
  constructor(readonly userName: string) {}
  get isAuthenticated() {
    return true;
  }
}

function delivery(metadata: Record<string, unknown> | undefined): {
  mode: "wake_when_idle" | "append_context";
  priority: "low" | "normal" | "high";
  notifyOn: string[];
  replyExpected: boolean;
  expiresAt?: string;
} {
  const raw = metadata?.[extension],
    value = raw === undefined ? {} : raw;
  if (!isRecord(value)) throw new Error("VALIDATION_FAILED: delivery extension must be an object");
  const allowed = new Set(["mode", "priority", "notifyOn", "replyExpected", "expiresAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("VALIDATION_FAILED: unknown delivery option");
  const mode = value.mode ?? "wake_when_idle",
    priority = value.priority ?? "normal",
    notifyOn = value.notifyOn ?? ["input-required", "terminal"];
  if (mode !== "wake_when_idle" && mode !== "append_context")
    throw new Error("ACS_UNSUPPORTED_DELIVERY_MODE");
  if (priority !== "low" && priority !== "normal" && priority !== "high")
    throw new Error("VALIDATION_FAILED: invalid priority");
  if (
    !Array.isArray(notifyOn) ||
    notifyOn.some(
      (state) =>
        !new Set([
          "working",
          "input-required",
          "completed",
          "failed",
          "canceled",
          "rejected",
          "terminal",
        ]).has(String(state)),
    )
  )
    throw new Error("VALIDATION_FAILED: invalid notifyOn");
  if (value.replyExpected !== undefined && typeof value.replyExpected !== "boolean")
    throw new Error("VALIDATION_FAILED: invalid replyExpected");
  if (
    value.expiresAt !== undefined &&
    (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))
  )
    throw new Error("VALIDATION_FAILED: invalid expiresAt");
  return {
    mode,
    priority,
    notifyOn: notifyOn.map(String),
    replyExpected: value.replyExpected ?? true,
    expiresAt: value.expiresAt,
  };
}

export function card(row: AgentRow, port: number): AgentCard {
  return AgentCard.fromJSON({
    name: row.display_name,
    description: row.description,
    version: String(row.profile_revision),
    supportedInterfaces: [
      {
        url: `http://127.0.0.1:${port}/agents/${row.slug}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: true,
      extensions: [{ uri: extension, description: "ACS delivery preferences", required: false }],
    },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "opaque",
          description: "ACS local token",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: JSON.parse(row.skills_json),
    signatures: [],
  });
}

class Handler implements A2ARequestHandler {
  constructor(
    private store: Store,
    private agent: AgentRow,
    private port: number,
  ) {}
  async getAgentCard() {
    return card(this.agent, this.port);
  }
  async getAuthenticatedExtendedAgentCard(
    _params: GetExtendedAgentCardRequest,
    _context: ServerCallContext,
  ) {
    return this.getAgentCard();
  }
  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    try {
      const message = params.message;
      if (!message) throw new Error("VALIDATION_FAILED: message is required");
      return asTask(
        this.store.accept(this.agent.id, principalName(context), message, delivery(params.metadata))
          .task,
      );
    } catch (error) {
      throw applicationError(error);
    }
  }
  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse> {
    const accepted = await this.sendMessage(params, context),
      principal = principalName(context),
      state = this.streamState(accepted.id, principal);
    yield { payload: { $case: "task", value: state.task } };
    yield* this.updates(state.task, state.sequence);
  }
  async getTask(params: GetTaskRequest, context: ServerCallContext) {
    const task = this.store.task(params.id, principalName(context), this.agent.id);
    if (!task) throw new JsonRpcTaskNotFoundError();
    return trim(asTask(task), params.historyLength);
  }
  async listTasks(params: ListTasksRequest, context: ServerCallContext) {
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100),
      page = this.store.listTasks(this.agent.id, principalName(context), {
        contextId: params.contextId,
        state: taskState(params.status),
        cursor: params.pageToken,
        limit: pageSize,
      });
    return {
      tasks: page.tasks.map((task) => trim(asTask(task), params.historyLength)),
      nextPageToken: page.nextCursor ?? "",
      pageSize,
      totalSize: page.total,
    };
  }
  async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    const task = this.store.task(params.id, principalName(context), this.agent.id);
    if (!task) throw new JsonRpcTaskNotFoundError();
    if (
      task.status &&
      [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED,
      ].includes(task.status.state)
    )
      throw new JsonRpcTaskNotCancelableError();
    return asTask(this.store.requestCancellation(params.id, principalName(context)));
  }
  async *resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse> {
    const principal = principalName(context),
      state = this.streamState(params.id, principal);
    yield { payload: { $case: "task", value: state.task } };
    yield* this.updates(state.task, state.sequence);
  }
  async createTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw new JsonRpcPushNotificationNotSupportedError();
  }
  async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new JsonRpcPushNotificationNotSupportedError();
  }
  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigsRequest,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new JsonRpcPushNotificationNotSupportedError();
  }
  async deleteTaskPushNotificationConfig(): Promise<void> {
    throw new JsonRpcPushNotificationNotSupportedError();
  }
  private streamState(taskId: string, principalId: string) {
    const state = this.store.taskStreamState(taskId, principalId, this.agent.id);
    if (!state) throw new JsonRpcTaskNotFoundError();
    return { task: asTask(state.task), sequence: state.sequence };
  }
  private async *updates(task: Task, sequence: number): AsyncGenerator<StreamResponse> {
    while (!terminal(task.status?.state)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const events = this.store.eventsAfter(task.id, sequence);
      for (const event of events) {
        sequence = event.sequence;
        task = asTask(event.task);
        yield {
          payload: {
            $case: "statusUpdate",
            value: {
              taskId: task.id,
              contextId: task.contextId,
              status: task.status,
              metadata: { sequence },
            },
          },
        };
      }
    }
  }
}

function trim(task: Task, length?: number): Task {
  return length === undefined
    ? task
    : { ...task, history: length === 0 ? [] : task.history.slice(-length) };
}
function asTask(task: StoredTask): Task {
  return Task.fromJSON(task);
}
function applicationError(error: unknown) {
  if (error instanceof JsonRpcTransportError) return error;
  const message = error instanceof Error ? error.message : String(error),
    raw = message.split(":").at(0) ?? "UNKNOWN";
  if (raw === "ACS_TASK_NOT_VISIBLE") return new JsonRpcTaskNotFoundError();
  if (raw === "ACS_UNSUPPORTED_CONTENT") return new JsonRpcContentTypeNotSupportedError();
  if (raw === "ACS_TASK_STATE_CONFLICT") return new JsonRpcUnsupportedOperationError();
  const code = raw.startsWith("ACS_")
    ? raw
    : raw === "TASK_STATE_CONFLICT"
      ? "ACS_TASK_STATE_CONFLICT"
      : raw === "VALIDATION_FAILED"
        ? "ACS_VALIDATION_FAILED"
        : "ACS_STORAGE_UNAVAILABLE";
  return new JsonRpcTransportError({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32010,
      message,
      data: {
        code,
        retryable: code === "ACS_STORAGE_UNAVAILABLE" || code === "ACS_OVERLOADED",
        correlationId: crypto.randomUUID(),
      },
    },
  });
}
function terminal(state?: TaskState) {
  return (
    state !== undefined &&
    [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_REJECTED,
    ].includes(state)
  );
}

function taskState(state: TaskState | undefined) {
  switch (state) {
    case undefined:
    case TaskState.TASK_STATE_UNSPECIFIED:
      return undefined;
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    default:
      throw new Error("VALIDATION_FAILED: invalid task status");
  }
}

export async function handleA2A(
  store: Store,
  request: Request,
  port: number,
  maxRequestBytes = 524288,
): Promise<Response> {
  const started = performance.now();
  telemetry.increment("acs_a2a_requests_total");
  try {
    return await telemetry.trace("a2a.receive", () =>
      handleA2ARoute(store, request, port, maxRequestBytes),
    );
  } finally {
    telemetry.observe("acs_a2a_request_duration_ms", performance.now() - started);
  }
}

async function handleA2ARoute(
  store: Store,
  request: Request,
  port: number,
  maxRequestBytes: number,
): Promise<Response> {
  const url = new URL(request.url),
    match = url.pathname.match(/^\/agents\/([^/]+)\/(?:\.well-known\/agent-card\.json|a2a)$/);
  if (!match) return new Response("Not found", { status: 404 });
  const slug = match.at(1);
  if (!slug) return new Response("Not found", { status: 404 });
  const agent = store.agent(slug);
  if (!agent || !agent.enabled) return new Response("Not found", { status: 404 });
  if (request.method === "GET" && url.pathname.endsWith("agent-card.json")) {
    const json = AgentCard.toJSON(card(agent, port));
    if (!isRecord(json)) throw new Error("Agent Card serialization failed");
    return Response.json({
      ...json,
      description: agent.description,
      skills: JSON.parse(agent.skills_json),
    });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json"))
    return new Response("Unsupported media type", { status: 415 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxRequestBytes) return new Response("Request too large", { status: 413 });
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1],
    principal = token ? store.authenticate(token) : null;
  if (!principal) return new Response("Unauthorized", { status: 401 });
  const body = await readBody(request, maxRequestBytes);
  if (body === null) return new Response("Request too large", { status: 413 });
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(body);
    payload = isRecord(parsed) ? parsed : undefined;
  } catch {
    payload = undefined;
  }
  const method = payload?.method,
    rpcId = typeof payload?.id === "string" || typeof payload?.id === "number" ? payload.id : null,
    requestedVersion = request.headers.get("A2A-Version");
  if (requestedVersion && requestedVersion !== "1.0")
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      error: toJsonRpcError(new JsonRpcVersionNotSupportedError()),
    });
  if (method === "SubscribeToTask") {
    const params = payload && isRecord(payload.params) ? payload.params : undefined,
      taskId = params?.id;
    if (typeof taskId === "string" && !store.task(taskId, principal.id, agent.id))
      return Response.json({
        jsonrpc: "2.0",
        id: rpcId,
        error: toJsonRpcError(new JsonRpcTaskNotFoundError()),
      });
  }
  const requiredScope =
    method === "SendMessage" || method === "SendStreamingMessage"
      ? "a2a:send"
      : method === "CancelTask"
        ? "a2a:cancel"
        : "a2a:read";
  if (!principal.scopes.includes("*") && !principal.scopes.includes(requiredScope))
    return new Response("Forbidden", { status: 403 });
  const context = new ServerCallContext({
    user: new PrincipalUser(principal.id),
    requestedVersion: requestedVersion ?? "1.0",
  });
  const result = await new JsonRpcTransportHandler(new Handler(store, agent, port)).handle(
    body,
    context,
  );
  if (isAcsErrorResponse(result)) {
    const code = result.error.message.split(":").at(0) ?? "UNKNOWN";
    result.error.data = {
      code,
      retryable: code === "ACS_STORAGE_UNAVAILABLE" || code === "ACS_OVERLOADED",
      correlationId: crypto.randomUUID(),
    };
  }
  if (isAsyncIterable(result)) {
    const iterator = result[Symbol.asyncIterator](),
      encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  return Response.json(result);
}
async function readBody(request: Request, maxBytes: number) {
  if (!request.body) return "";
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, size).toString();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function principalName(context: ServerCallContext) {
  const name = context.user?.userName;
  if (!name) throw new Error("NOT_AUTHENTICATED");
  return name;
}
function isAsyncIterable(value: unknown): value is AsyncIterable<StreamResponse> {
  return isRecord(value) && Symbol.asyncIterator in value;
}
function isAcsErrorResponse(
  value: unknown,
): value is { error: { message: string; data?: Record<string, unknown> } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string" &&
    value.error.message.startsWith("ACS_")
  );
}
