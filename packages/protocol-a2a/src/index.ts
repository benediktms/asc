import {
  AgentCard,
  type Part,
  Role,
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
import type {
  A2AApplicationPort,
  A2ATarget,
  AuthenticatedPrincipal,
  DeliveryPreference,
  TaskEventSubscription,
} from "../../../contracts/a2a-application-port";
import type { RuntimeTraceContext } from "../../../contracts/runtime-adapter";
import type { NeutralPart } from "../../../contracts/runtime-adapter";
import { A2AApplication, jsonObject, jsonValue } from "../../application/src/a2a";
import { canonical } from "../../domain/src/index";
import type { A2AStoragePort, AgentRow } from "../../ports/src/index";
import { telemetry } from "../../observability/src/index";

const extension = "urn:agent-communications:delivery:v1",
  deliveryStatus = "urn:agent-communications:delivery-status:v1";
class PrincipalUser {
  constructor(readonly userName: string) {}
  get isAuthenticated() {
    return true;
  }
}

function delivery(metadata: Record<string, unknown> | undefined): DeliveryPreference {
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
  if (!Array.isArray(notifyOn) || !notifyOn.every(isNotifyState))
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
    notifyOn,
    replyExpected: value.replyExpected ?? true,
    expiresAt: value.expiresAt,
  };
}

export function card(row: AgentRow, port: number, hostname = "127.0.0.1"): AgentCard {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return AgentCard.fromJSON({
    name: row.display_name,
    description: row.description,
    version: String(row.profile_revision),
    supportedInterfaces: [
      {
        url: `http://${host}:${port}/agents/${row.slug}/a2a`,
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
    private application: A2AApplicationPort,
    private principal: AuthenticatedPrincipal,
    private agent: AgentRow,
    private port: number,
    private signalDelivery: () => void,
    private hostname: string,
    private traceContext?: RuntimeTraceContext,
  ) {}
  async getAgentCard() {
    return card(this.agent, this.port, this.hostname);
  }
  async getAuthenticatedExtendedAgentCard(
    _params: GetExtendedAgentCardRequest,
    _context: ServerCallContext,
  ): Promise<AgentCard> {
    return this.getAgentCard();
  }
  async sendMessage(params: SendMessageRequest, _context: ServerCallContext): Promise<Task> {
    try {
      const message = params.message;
      if (!message) throw new Error("VALIDATION_FAILED: message is required");
      const preference = delivery(params.metadata),
        parts = message.parts.map(neutralPart),
        role = message.role === Role.ROLE_AGENT ? "agent" : "user",
        requestMetadata = jsonObject(params.metadata ?? {}),
        messageMetadata = jsonObject(message.metadata ?? {}),
        accepted = await this.application.acceptMessage({
          principal: this.principal,
          target: target(this.agent),
          requestCorrelationId: crypto.randomUUID(),
          externalMessageId: message.messageId,
          taskId: message.taskId || undefined,
          contextId: message.contextId || undefined,
          role,
          parts,
          requestMetadata,
          messageMetadata,
          delivery: preference,
          canonicalRequestHash: await hash({
            externalMessageId: message.messageId,
            taskId: message.taskId || null,
            contextId: message.contextId || null,
            role,
            parts,
            requestMetadata,
            messageMetadata,
            delivery: preference,
          }),
          traceContext: this.traceContext,
        }),
        metadata = accepted.a2aSnapshot.metadata,
        status = isRecord(metadata) ? metadata[deliveryStatus] : undefined;
      if (!accepted.duplicate) this.signalDelivery();
      return Task.fromJSON({
        ...accepted.a2aSnapshot,
        metadata: {
          ...(isRecord(metadata) ? metadata : {}),
          [deliveryStatus]: {
            ...(isRecord(status) ? status : {}),
            deliveryId: accepted.deliveryId,
            duplicate: accepted.duplicate,
          },
        },
      });
    } catch (error) {
      throw applicationError(error);
    }
  }
  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse> {
    const accepted = await this.sendMessage(params, context),
      subscription = await this.application.subscribeTask(this.query(accepted.id));
    yield { payload: { $case: "task", value: Task.fromJSON(subscription.currentTask) } };
    yield* this.updates(subscription);
  }
  async getTask(params: GetTaskRequest, _context: ServerCallContext) {
    try {
      return Task.fromJSON(
        await this.application.getTask(this.query(params.id, params.historyLength)),
      );
    } catch (error) {
      throw applicationError(error);
    }
  }
  async listTasks(params: ListTasksRequest, _context: ServerCallContext) {
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100),
      state = taskState(params.status),
      query = {
        principal: this.principal,
        target: target(this.agent),
        contextId: params.contextId || undefined,
        states: state ? [state] : undefined,
        updatedAfter: params.statusTimestampAfter || undefined,
        historyLength: params.historyLength,
        includeArtifacts: params.includeArtifacts,
        cursor: params.pageToken || undefined,
        pageSize,
      };
    try {
      const page = await this.application.listTasks(query);
      return {
        tasks: page.tasks.map((task) => Task.fromJSON(task)),
        nextPageToken: page.nextCursor ?? "",
        pageSize,
        totalSize: page.totalSize,
      };
    } catch (error) {
      throw applicationError(error);
    }
  }
  async cancelTask(params: CancelTaskRequest, _context: ServerCallContext) {
    try {
      const task = Task.fromJSON(await this.application.getTask(this.query(params.id)));
      if (
        task.status &&
        [
          TaskState.TASK_STATE_COMPLETED,
          TaskState.TASK_STATE_FAILED,
          TaskState.TASK_STATE_REJECTED,
        ].includes(task.status.state)
      )
        throw new JsonRpcTaskNotCancelableError({ message: "ACS_TASK_STATE_CONFLICT" });
      return Task.fromJSON(
        await this.application.cancelTask({
          principal: this.principal,
          target: target(this.agent),
          taskId: params.id,
          reason:
            isRecord(params.metadata) && typeof params.metadata.reason === "string"
              ? params.metadata.reason
              : undefined,
          requestCorrelationId: crypto.randomUUID(),
        }),
      );
    } catch (error) {
      throw applicationError(error);
    }
  }
  async *resubscribe(
    params: SubscribeToTaskRequest,
    _context: ServerCallContext,
  ): AsyncGenerator<StreamResponse> {
    const subscription = await this.application.subscribeTask(this.query(params.id));
    yield { payload: { $case: "task", value: Task.fromJSON(subscription.currentTask) } };
    yield* this.updates(subscription);
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
  private query(taskId: string, historyLength?: number) {
    return {
      principal: this.principal,
      target: target(this.agent),
      taskId,
      historyLength,
    };
  }
  private async *updates(subscription: TaskEventSubscription): AsyncGenerator<StreamResponse> {
    try {
      for await (const event of subscriptionEvents(subscription)) {
        const task = Task.fromJSON(event.a2aEvent);
        yield {
          payload: {
            $case: "statusUpdate",
            value: {
              taskId: task.id,
              contextId: task.contextId,
              status: task.status,
              metadata: { sequence: event.sequence },
            },
          },
        };
        if (terminal(task.status?.state)) return;
      }
    } finally {
      await subscription.close();
    }
  }
}

async function* subscriptionEvents(subscription: TaskEventSubscription) {
  yield* subscription.replay;
  yield* subscription.live;
}
function target(agent: AgentRow): A2ATarget {
  return {
    agentId: agent.id,
    slug: agent.slug,
    profileRevision: agent.profile_revision,
  };
}
function neutralPart(part: Part): NeutralPart {
  if (part.content?.$case === "text")
    return {
      kind: "text",
      text: part.content.value,
      mediaType: part.mediaType === "text/markdown" ? "text/markdown" : "text/plain",
    };
  if (part.content?.$case === "url")
    return {
      kind: "uri",
      uri: part.content.value,
      name: part.filename || undefined,
      mediaType: part.mediaType || undefined,
    };
  if (part.content?.$case === "data")
    return {
      kind: "data",
      data: jsonValue(part.content.value),
      name: part.filename || undefined,
      mediaType: part.mediaType || "application/json",
    };
  throw new Error("ACS_UNSUPPORTED_CONTENT");
}
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isNotifyState(value: unknown): value is DeliveryPreference["notifyOn"][number] {
  return (
    typeof value === "string" &&
    [
      "working",
      "input-required",
      "completed",
      "failed",
      "canceled",
      "rejected",
      "terminal",
    ].includes(value)
  );
}
function applicationError(error: unknown) {
  if (error instanceof JsonRpcTransportError) return error;
  const message = error instanceof Error ? error.message : String(error),
    raw = message.split(":").at(0) ?? "UNKNOWN";
  if (raw === "ACS_TASK_NOT_VISIBLE") return new JsonRpcTaskNotFoundError({ message });
  if (raw === "ACS_UNSUPPORTED_CONTENT")
    return new JsonRpcContentTypeNotSupportedError({ message });
  if (raw === "ACS_TASK_STATE_CONFLICT") return new JsonRpcUnsupportedOperationError({ message });
  const code = raw.startsWith("ACS_")
    ? raw
    : raw === "TASK_STATE_CONFLICT"
      ? "ACS_TASK_STATE_CONFLICT"
      : raw === "VALIDATION_FAILED"
        ? "ACS_VALIDATION_FAILED"
        : "ACS_STORAGE_UNAVAILABLE";
  const publicMessage = code === "ACS_STORAGE_UNAVAILABLE" ? code : message;
  return new JsonRpcTransportError({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32010,
      message: publicMessage,
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
  store: A2AStoragePort,
  request: Request,
  port: number,
  maxRequestBytes = 524288,
  signalDelivery: () => void = () => {},
  hostname = "127.0.0.1",
): Promise<Response> {
  const started = performance.now();
  telemetry.increment("acs_a2a_requests_total");
  try {
    return await telemetry.trace("a2a.receive", () =>
      handleA2ARoute(store, request, port, maxRequestBytes, signalDelivery, hostname),
    );
  } finally {
    telemetry.observe("acs_a2a_request_duration_ms", performance.now() - started);
  }
}

async function handleA2ARoute(
  store: A2AStoragePort,
  request: Request,
  port: number,
  maxRequestBytes: number,
  signalDelivery: () => void,
  hostname: string,
): Promise<Response> {
  const url = new URL(request.url),
    match = url.pathname.match(/^\/agents\/([^/]+)\/(?:\.well-known\/agent-card\.json|a2a)$/);
  if (!match) return new Response("Not found", { status: 404 });
  const slug = match.at(1);
  if (!slug) return new Response("Not found", { status: 404 });
  if (url.pathname.endsWith("agent-card.json")) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const agent = store.agent(slug);
    if (!agent) return new Response("Not found", { status: 404 });
    if (!agent.enabled) return new Response("Not found", { status: 404 });
    const json = AgentCard.toJSON(card(agent, port, hostname));
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
  const agent = store.agent(slug);
  if (!agent) return new Response("Not found", { status: 404 });
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1],
    principal = token ? store.authenticate(token) : null;
  if (!principal) {
    store.audit(null, "security.reject", "a2a", agent.id, { reason: "unauthenticated" });
    return new Response("Unauthorized", { status: 401 });
  }
  if (!a2aPrincipalKind(principal.kind)) {
    store.audit(principal.id, "security.reject", "a2a", agent.id, {
      reason: "principal-kind-not-authorized",
    });
    return new Response("Forbidden", { status: 403 });
  }
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
    return errorResponse(rpcId, new JsonRpcVersionNotSupportedError());
  if (method === "SubscribeToTask") {
    const params = payload && isRecord(payload.params) ? payload.params : undefined,
      taskId = params?.id;
    if (typeof taskId === "string" && !store.task(taskId, principal.id, agent.id))
      return errorResponse(
        rpcId,
        new JsonRpcTaskNotFoundError({ message: "ACS_TASK_NOT_VISIBLE" }),
      );
  }
  const requiredScope =
    method === "SendMessage" || method === "SendStreamingMessage"
      ? "a2a:send"
      : method === "CancelTask"
        ? "a2a:cancel"
        : "a2a:read";
  if (!principal.scopes.includes("*") && !principal.scopes.includes(requiredScope)) {
    store.audit(principal.id, "security.reject", "a2a", agent.id, {
      reason: "insufficient-scope",
      method: typeof method === "string" ? method : "unknown",
    });
    return new Response("Forbidden", { status: 403 });
  }
  const context = new ServerCallContext({
      user: new PrincipalUser(principal.id),
      requestedVersion: requestedVersion ?? "1.0",
    }),
    result = await new JsonRpcTransportHandler(
      new Handler(
        new A2AApplication(store),
        authenticatedPrincipal(principal),
        agent,
        port,
        signalDelivery,
        hostname,
        incomingTraceContext(request.headers),
      ),
    ).handle(body, context);
  addErrorContext(result);
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
  return Response.json(result, { status: hasErrorCode(result, "ACS_OVERLOADED") ? 429 : 200 });
}

function incomingTraceContext(headers: Headers): RuntimeTraceContext | undefined {
  const traceparent = headers.get("traceparent"),
    match = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  if (!traceparent || !match || /^0+$/.test(match[1] ?? "") || /^0+$/.test(match[2] ?? ""))
    return undefined;
  const tracestate = headers.get("tracestate");
  return tracestate && validTracestate(tracestate) ? { traceparent, tracestate } : { traceparent };
}

function validTracestate(value: string) {
  if (new TextEncoder().encode(value).byteLength > 512) return false;
  const members = value.split(",").map((member) => member.trim());
  if (!members.length || members.length > 32) return false;
  const keys = new Set<string>();
  for (const member of members) {
    const separator = member.indexOf("="),
      key = member.slice(0, separator),
      item = member.slice(separator + 1);
    if (
      separator < 1 ||
      !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(
        key,
      ) ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/.test(item) ||
      item.endsWith(" ") ||
      keys.has(key)
    )
      return false;
    keys.add(key);
  }
  return true;
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
function authenticatedPrincipal(
  principal: ReturnType<A2AStoragePort["authenticate"]>,
): AuthenticatedPrincipal {
  if (!principal) throw new Error("NOT_AUTHENTICATED");
  if (!a2aPrincipalKind(principal.kind)) throw new Error("NOT_AUTHENTICATED");
  return {
    id: principal.id,
    kind: principal.kind,
    agentId: principal.agent_id ?? undefined,
    bindingId: principal.binding_id ?? undefined,
    scopes: principal.scopes,
  };
}
function a2aPrincipalKind(value: string): value is AuthenticatedPrincipal["kind"] {
  return value === "bound-agent" || value === "external-a2a-client" || value === "service";
}
function isAsyncIterable(value: unknown): value is AsyncIterable<StreamResponse> {
  return isRecord(value) && Symbol.asyncIterator in value;
}
function isJsonRpcErrorResponse(
  value: unknown,
): value is { error: { message: string; data?: unknown } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string"
  );
}
function hasErrorCode(value: unknown, code: string) {
  if (!isJsonRpcErrorResponse(value) || !Array.isArray(value.error.data)) return false;
  return value.error.data.some((item) => isRecord(item) && item.code === code);
}
function errorResponse(id: string | number | null, error: Error) {
  const result: {
    jsonrpc: "2.0";
    id: string | number | null;
    error: { code: number; message: string; data?: unknown };
  } = { jsonrpc: "2.0", id, error: toJsonRpcError(error) };
  addErrorContext(result);
  return Response.json(result);
}
function addErrorContext(value: unknown) {
  if (!isJsonRpcErrorResponse(value)) return;
  const existing = value.error.data;
  if (
    isRecord(existing) &&
    typeof existing.retryable === "boolean" &&
    typeof existing.correlationId === "string"
  ) {
    value.error.data = [existing];
    return;
  }
  const rawCode = value.error.message.split(":").at(0) ?? "UNKNOWN",
    code = rawCode.startsWith("ACS_") ? rawCode : "ACS_PROTOCOL_ERROR",
    context = {
      code,
      retryable: code === "ACS_STORAGE_UNAVAILABLE" || code === "ACS_OVERLOADED",
      correlationId: crypto.randomUUID(),
    };
  value.error.data = Array.isArray(existing)
    ? [...existing, context]
    : existing === undefined
      ? [context]
      : [existing, context];
}
