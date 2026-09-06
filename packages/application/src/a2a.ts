import type {
  A2AApplicationPort,
  A2ATaskListQuery,
  A2ATaskQuery,
  AcceptA2AMessageCommand,
  AcceptedTaskSnapshot,
  CancelA2ATaskCommand,
  TaskEventRecord,
  TaskEventSubscription,
} from "../../../contracts/a2a-application-port";
import type { JsonObject, JsonValue, NeutralPart } from "../../../contracts/runtime-adapter";
import { TaskState } from "../../domain/src/index";
import type { A2AStoragePort, StoredMessage, StoredPart, StoredTask } from "../../ports/src/index";

export class A2AApplication implements A2AApplicationPort {
  constructor(private storage: A2AStoragePort) {}

  async acceptMessage(command: AcceptA2AMessageCommand): Promise<AcceptedTaskSnapshot> {
    const accepted = this.storage.accept(
      command.target.agentId,
      command.principal.id,
      message(command),
      {
        mode: command.delivery.mode,
        priority: command.delivery.priority,
        notifyOn: [...command.delivery.notifyOn],
        replyExpected: command.delivery.replyExpected,
        expiresAt: command.delivery.expiresAt,
        traceContext: command.traceContext,
      },
      command.canonicalRequestHash,
    );
    return {
      taskId: accepted.task.id,
      contextId: accepted.task.contextId,
      targetAgentId: command.target.agentId,
      requesterPrincipalId: command.principal.id,
      state: taskState(accepted.task),
      stateVersion: accepted.stateVersion ?? this.storage.taskVersion(accepted.task.id),
      a2aSnapshot: taskSnapshot(accepted.task),
      deliveryId: accepted.deliveryId,
      duplicate: accepted.duplicate,
    };
  }

  async getTask(query: A2ATaskQuery): Promise<JsonObject> {
    const task = this.storage.task(query.taskId, query.principal.id, query.target.agentId);
    if (!task) throw new Error("ACS_TASK_NOT_VISIBLE");
    return taskSnapshot(trim(task, query.historyLength));
  }

  async listTasks(query: A2ATaskListQuery) {
    const updatedAfterMs = query.updatedAfter ? Date.parse(query.updatedAfter) : undefined;
    if (updatedAfterMs !== undefined && !Number.isFinite(updatedAfterMs))
      throw new Error("VALIDATION_FAILED: invalid statusTimestampAfter");
    const page = this.storage.listTasks(query.target.agentId, query.principal.id, {
      contextId: query.contextId,
      states: query.states,
      updatedAfterMs,
      cursor: query.cursor,
      limit: Math.min(Math.max(query.pageSize ?? 50, 1), 100),
    });
    return {
      tasks: page.tasks.map((task) =>
        taskSnapshot({
          ...trim(task, query.historyLength),
          artifacts: query.includeArtifacts ? task.artifacts : [],
        }),
      ),
      nextCursor: page.nextCursor,
      totalSize: page.total,
    };
  }

  async cancelTask(command: CancelA2ATaskCommand): Promise<JsonObject> {
    const task = this.storage.task(command.taskId, command.principal.id, command.target.agentId);
    if (!task) throw new Error("ACS_TASK_NOT_VISIBLE");
    return taskSnapshot(
      this.storage.requestCancellation(command.taskId, command.principal.id, command.reason),
    );
  }

  async subscribeTask(
    query: A2ATaskQuery & { readonly afterSequence?: number },
    signal?: AbortSignal,
  ): Promise<TaskEventSubscription> {
    const state = this.storage.taskStreamState(
      query.taskId,
      query.principal.id,
      query.target.agentId,
    );
    if (!state) throw new Error("ACS_TASK_NOT_VISIBLE");
    let closed = false;
    const replay =
        query.afterSequence === undefined
          ? []
          : this.storage.eventsAfter(query.taskId, query.afterSequence).map(eventRecord),
      storage = this.storage;
    let sequence = Math.max(
      query.afterSequence ?? state.sequence,
      replay.at(-1)?.sequence ?? state.sequence,
    );
    return {
      currentTask: taskSnapshot(state.task),
      replay,
      live: {
        async *[Symbol.asyncIterator]() {
          if (terminal(state.task)) return;
          for (;;) {
            if (closed || signal?.aborted) return;
            const events = storage.eventsAfter(query.taskId, sequence);
            for (const event of events) {
              sequence = event.sequence;
              yield eventRecord(event);
              if (terminal(event.task)) return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        },
      },
      async close() {
        closed = true;
      },
    };
  }
}

export function jsonObject(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(parsed)) throw new Error("INVALID_JSON_OBJECT");
  return parsed;
}

export function jsonValue(value: unknown): JsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonValue(parsed)) throw new Error("INVALID_JSON_VALUE");
  return parsed;
}

function message(command: AcceptA2AMessageCommand): StoredMessage {
  return {
    messageId: command.externalMessageId,
    contextId: command.contextId ?? "",
    taskId: command.taskId ?? "",
    role: command.role === "user" ? 1 : 2,
    parts: command.parts.map(storedPart),
    metadata: command.messageMetadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

function storedPart(part: NeutralPart): StoredPart {
  if (part.kind === "text")
    return {
      content: { $case: "text", value: part.text },
      filename: "",
      mediaType: part.mediaType ?? "text/plain",
    };
  if (part.kind === "uri")
    return {
      content: { $case: "url", value: part.uri },
      metadata: part.description ? { description: part.description } : undefined,
      filename: part.name ?? "",
      mediaType: part.mediaType ?? "application/octet-stream",
    };
  return {
    content: { $case: "data", value: part.data },
    filename: part.name ?? "",
    mediaType: part.mediaType,
  };
}

function trim(task: StoredTask, length?: number): StoredTask {
  return length === undefined
    ? task
    : { ...task, history: length === 0 ? [] : task.history.slice(-length) };
}

function taskState(task: StoredTask): TaskState {
  switch (task.status?.state) {
    case 1:
      return TaskState.Submitted;
    case 2:
      return TaskState.Working;
    case 3:
      return TaskState.Completed;
    case 4:
      return TaskState.Failed;
    case 5:
      return TaskState.Canceled;
    case 6:
      return TaskState.InputRequired;
    case 7:
      return TaskState.Rejected;
    case 8:
      return TaskState.AuthRequired;
    default:
      throw new Error("STORAGE_CORRUPT: invalid task state");
  }
}

function terminal(task: StoredTask) {
  const state = taskState(task);
  return [TaskState.Completed, TaskState.Failed, TaskState.Canceled, TaskState.Rejected].includes(
    state,
  );
}

function eventRecord(event: {
  sequence: number;
  eventType: string;
  task: StoredTask;
  createdAt: string;
}): TaskEventRecord {
  return {
    taskId: event.task.id,
    sequence: event.sequence,
    eventType: event.eventType,
    a2aEvent: taskSnapshot(event.task),
    createdAt: event.createdAt,
  };
}

function taskSnapshot(task: StoredTask): JsonObject {
  return jsonObject({
    ...task,
    history: task.history.map(messageSnapshot),
    status: task.status && {
      ...task.status,
      message: task.status.message && messageSnapshot(task.status.message),
    },
    artifacts: task.artifacts.map((artifact) => ({
      ...artifact,
      parts: artifact.parts.map(partSnapshot),
    })),
  });
}

function messageSnapshot(stored: StoredMessage) {
  return { ...stored, parts: stored.parts.map(partSnapshot) };
}

function partSnapshot(part: StoredPart) {
  const { content, ...attributes } = part;
  return content ? { ...attributes, [content.$case]: content.value } : attributes;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
