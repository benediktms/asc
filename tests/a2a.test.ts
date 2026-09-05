import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCard, Message, Role, TaskState as A2ATaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AuthenticatedPrincipal } from "../contracts/a2a-application-port";
import { A2AApplication } from "../packages/application/src/a2a";
import { TaskState } from "../packages/domain/src/index";
import { handleA2A } from "../packages/protocol-a2a/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(maxQueuedDeliveryIntents = 1000) {
  const root = mkdtempSync(join(tmpdir(), "acs-a2a-"));
  roots.push(root);
  const paths: Paths = {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
  };
  return new Store(paths, { maxQueuedDeliveryIntents });
}

describe("A2A JSON-RPC", () => {
  test("stops reading an oversized request body", async () => {
    const store = fixture(),
      agent = store.createAgent("bounded"),
      { token } = store.createToken();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          canceled = true;
        },
      }),
      response = await handleA2A(
        store,
        new Request("http://localhost/agents/bounded/a2a", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
        }),
        7432,
        4,
      );
    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
    expect(
      (
        await handleA2A(
          store,
          new Request("http://localhost/agents/missing/a2a", {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": "5" },
            body: "12345",
          }),
          7432,
          4,
        )
      ).status,
    ).toBe(413);
    expect(store.agent(agent.id)?.slug).toBe("bounded");
    store.close();
  });

  test("returns HTTP 429 when delivery admission is full", async () => {
    const store = fixture(1),
      agent = store.createAgent("bounded"),
      { token } = store.createToken(),
      send = (messageId: string) =>
        handleA2A(
          store,
          new Request("http://localhost/agents/bounded/a2a", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: messageId,
              method: "SendMessage",
              params: {
                message: { messageId, role: "ROLE_USER", parts: [{ text: "work" }] },
                configuration: { returnImmediately: true },
              },
            }),
          }),
          7432,
        );
    expect((await send("accepted")).status).toBe(200);
    const overloaded = await send("overloaded"),
      body = record(await overloaded.json()),
      context = errorContext(record(body.error).data);
    expect(overloaded.status).toBe(429);
    expect(context).toMatchObject({ code: "ACS_OVERLOADED", retryable: true });
    expect(store.agent(agent.id)?.slug).toBe("bounded");
    store.close();
  });

  test("redacts unexpected storage errors", async () => {
    const store = fixture(),
      agent = store.createAgent("storage-error"),
      { token } = store.createToken(),
      accept = store.accept;
    store.accept = () => {
      throw new Error("SQLITE_IOERR: /private/secret/acs.db");
    };
    const response = await handleA2A(
        store,
        new Request("http://localhost/agents/storage-error/a2a", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "storage-error",
            method: "SendMessage",
            params: {
              message: { messageId: "storage-error", role: "ROLE_USER", parts: [{ text: "x" }] },
            },
          }),
        }),
        7432,
      ),
      body = await response.text();
    store.accept = accept;
    expect(body).toContain("ACS_STORAGE_UNAVAILABLE");
    expect(body).not.toContain("/private/secret");
    expect(store.agent(agent.id)?.slug).toBe("storage-error");
    store.close();
  });

  test("rejects the administrative local-user token", async () => {
    const store = fixture();
    store.createAgent("admin-token");
    const response = await handleA2A(
      store,
      new Request("http://localhost/agents/admin-token/a2a", {
        method: "POST",
        headers: {
          authorization: `Bearer ${readFileSync(store.config.token, "utf8")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "admin", method: "GetTask", params: {} }),
      }),
      7432,
    );
    expect(response.status).toBe(403);
    store.close();
  });

  test("drops invalid trace context before durable acceptance", async () => {
    const store = fixture();
    store.createAgent("invalid-trace");
    const { token } = store.createToken();
    await handleA2A(
      store,
      new Request("http://localhost/agents/invalid-trace/a2a", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "invalid-trace",
          method: "SendMessage",
          params: {
            message: {
              messageId: "invalid-trace",
              role: "ROLE_USER",
              parts: [{ text: "work" }],
            },
            configuration: { returnImmediately: true },
          },
        }),
      }),
      7432,
    );
    const payload = store.db
      .query<{ payload_json: string }, []>("SELECT payload_json FROM delivery_intents")
      .get();
    if (!payload) throw new Error("delivery payload missing");
    expect(record(JSON.parse(payload.payload_json)).traceContext).toBeUndefined();
    store.close();
  });

  test("discovers an agent and sends, reads, then cancels a durable task", async () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      { token } = store.createToken();
    let deliverySignals = 0;
    const card = await handleA2A(
      store,
      new Request("http://localhost/agents/backend/.well-known/agent-card.json"),
      7432,
    );
    expect(card.status).toBe(200);
    expect(
      (
        await handleA2A(
          store,
          new Request("http://localhost/agents/backend/.well-known/agent-card.json", {
            method: "POST",
          }),
          7432,
        )
      ).status,
    ).toBe(405);
    const publicCard = AgentCard.fromJSON(await card.json());
    expect(publicCard.supportedInterfaces.at(0)?.url).toBe(
      "http://127.0.0.1:7432/agents/backend/a2a",
    );
    expect(publicCard.capabilities).toMatchObject({
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: true,
    });
    const ipv6Card = await handleA2A(
      store,
      new Request("http://localhost/agents/backend/.well-known/agent-card.json"),
      7432,
      524288,
      () => {},
      "::1",
    );
    expect(AgentCard.fromJSON(await ipv6Card.json()).supportedInterfaces.at(0)?.url).toBe(
      "http://[::1]:7432/agents/backend/a2a",
    );
    const call = async (method: string, params: unknown, tracing: Record<string, string> = {}) => {
      if (
        method === "SendMessage" &&
        typeof params === "object" &&
        params !== null &&
        !("configuration" in params)
      )
        params = { ...params, configuration: { returnImmediately: true } };
      const response = await handleA2A(
        store,
        new Request("http://localhost/agents/backend/a2a", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...tracing,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
        }),
        7432,
        524288,
        () => deliverySignals++,
      );
      const result: {
        result?: {
          id?: string;
          name?: string;
          status?: { state: string };
          task?: {
            id: string;
            status?: { state: string };
            metadata?: Record<string, unknown>;
          };
        };
        error?: {
          code?: number;
          message: string;
          data?: Array<{ code?: string; retryable?: boolean; correlationId?: string }>;
        };
      } = await response.json();
      return result;
    };
    expect((await call("GetExtendedAgentCard", {})).result?.name).toBe("backend");
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate = "vendor=value",
      sent = await call(
        "SendMessage",
        {
          message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "work" }] },
        },
        { traceparent, tracestate },
      );
    expect(sent.error).toBeUndefined();
    const taskId = sent.result?.task?.id;
    expect(taskId).toStartWith("tsk_");
    if (!taskId) throw new Error("SendMessage did not return a task");
    const persistedPayload = store.db
      .query<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM delivery_intents WHERE task_id=?",
      )
      .get(taskId);
    if (!persistedPayload) throw new Error("delivery payload missing");
    expect(record(JSON.parse(persistedPayload.payload_json))).toMatchObject({
      traceContext: { traceparent, tracestate },
    });
    const delivery = record(
        record(sent.result?.task?.metadata)["urn:agent-communications:delivery-status:v1"],
      ),
      duplicate = await call("SendMessage", {
        message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "work" }] },
      }),
      duplicateDelivery = record(
        record(duplicate.result?.task?.metadata)["urn:agent-communications:delivery-status:v1"],
      );
    expect(delivery).toMatchObject({ state: "queued", duplicate: false });
    expect(duplicateDelivery).toMatchObject({ deliveryId: delivery.deliveryId, duplicate: true });
    expect(deliverySignals).toBe(1);
    const roleConflict = await call("SendMessage", {
      message: { messageId: "a2a-1", role: "ROLE_AGENT", parts: [{ text: "work" }] },
    });
    expect(errorContext(roleConflict.error?.data)?.code).toBe("ACS_IDEMPOTENCY_CONFLICT");
    const conflict = await call("SendMessage", {
      message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "different" }] },
    });
    const conflictContext = errorContext(conflict.error?.data);
    expect(conflictContext?.code).toBe("ACS_IDEMPOTENCY_CONFLICT");
    expect(conflictContext?.retryable).toBe(false);
    expect(
      (
        await call("SendMessage", {
          message: {
            messageId: "missing-continuation",
            taskId: "tsk_missing",
            role: "ROLE_USER",
            parts: [{ text: "work" }],
          },
        })
      ).error?.code,
    ).toBe(-32001);
    const missingSubscription = await call("SubscribeToTask", { id: "tsk_missing" });
    expect(missingSubscription.error?.code).toBe(-32001);
    const missingContext = errorContext(missingSubscription.error?.data);
    expect(missingContext?.code).toBe("ACS_TASK_NOT_VISIBLE");
    expect(missingContext?.retryable).toBe(false);
    expect(missingContext?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const read = (await call("GetTask", { id: taskId })).result;
    expect(read?.task?.id ?? read?.id).toBe(taskId);
    const canceled = (await call("CancelTask", { id: taskId })).result;
    expect(canceled?.task?.status?.state ?? canceled?.status?.state).toBe("TASK_STATE_CANCELED");
    const canceledAgain = (await call("CancelTask", { id: taskId })).result;
    expect(canceledAgain?.task?.status?.state ?? canceledAgain?.status?.state).toBe(
      "TASK_STATE_CANCELED",
    );
    const terminalDuplicate = await call("SendMessage", {
        message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "work" }] },
      }),
      terminalDelivery = record(
        record(terminalDuplicate.result?.task?.metadata)[
          "urn:agent-communications:delivery-status:v1"
        ],
      );
    expect(terminalDuplicate.result?.task?.status?.state).toBe("TASK_STATE_CANCELED");
    expect(terminalDelivery).toMatchObject({
      deliveryId: delivery.deliveryId,
      state: "canceled",
      duplicate: true,
    });
    expect(deliverySignals).toBe(1);
    expect(
      store.db
        .query<{ n: number }, [string]>("SELECT count(*) n FROM task_events WHERE task_id=?")
        .get(taskId)?.n,
    ).toBe(2);
    expect(
      store.db
        .query<{ n: number }, [string]>("SELECT count(*) n FROM delivery_intents WHERE task_id=?")
        .get(taskId)?.n,
    ).toBe(1);
    const limited = store.createToken();
    store.db
      .query("UPDATE auth_tokens SET scopes_json='[\"a2a:read\"]' WHERE principal_id=?")
      .run(limited.principalId);
    const forbidden = await handleA2A(
      store,
      new Request("http://localhost/agents/backend/a2a", {
        method: "POST",
        headers: {
          authorization: `Bearer ${limited.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "forbidden",
          method: "SendMessage",
          params: {
            message: { messageId: "a2a-forbidden", role: "ROLE_USER", parts: [{ text: "work" }] },
          },
        }),
      }),
      7432,
    );
    expect(forbidden.status).toBe(403);
    expect(
      store.db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM audit_events WHERE action='security.reject'",
        )
        .get()?.n,
    ).toBe(1);
    const unsupportedVersion = await handleA2A(
      store,
      new Request("http://localhost/agents/backend/a2a", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "A2A-Version": "99.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "version", method: "GetTask", params: {} }),
      }),
      7432,
    );
    expect(record(await unsupportedVersion.json()).error).toMatchObject({ code: -32009 });
    store.updateAgent(agent.id, { enabled: false });
    const disabled = await call("SendMessage", {
      message: {
        messageId: "disabled-agent",
        role: "ROLE_USER",
        parts: [{ text: "work" }],
      },
    });
    expect(errorContext(disabled.error?.data)?.code).toBe("ACS_AGENT_DISABLED");
    expect(store.agent(agent.id)?.slug).toBe("backend");
    store.close();
  });

  test("interoperates with the pinned SDK JSON-RPC client", async () => {
    const store = fixture(),
      agent = store.createAgent("sdk-client"),
      { token } = store.createToken(),
      fetchImpl = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          handleA2A(store, new Request(input, init), 7432),
        { preconnect: fetch.preconnect },
      ),
      cardResponse = await fetchImpl(
        "http://localhost/agents/sdk-client/.well-known/agent-card.json",
      ),
      card = AgentCard.fromJSON(await cardResponse.json()),
      client = await new ClientFactory({
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        clientConfig: { polling: true },
      }).createFromAgentCard(card),
      options = { serviceParameters: { Authorization: `Bearer ${token}` } },
      sent = await client.sendMessage(
        {
          tenant: "",
          message: Message.fromJSON({
            messageId: "sdk-client-message",
            role: Role.ROLE_USER,
            parts: [{ text: "work" }],
          }),
          configuration: {
            acceptedOutputModes: [],
            taskPushNotificationConfig: undefined,
            returnImmediately: true,
          },
          metadata: undefined,
        },
        options,
      );
    if (!("id" in sent)) throw new Error("SDK client did not return a task");
    expect(sent.id).toStartWith("tsk_");
    expect((await client.getTask({ tenant: "", id: sent.id }, options)).id).toBe(sent.id);
    expect(
      (await client.cancelTask({ tenant: "", id: sent.id, metadata: undefined }, options)).status
        ?.state,
    ).toBe(A2ATaskState.TASK_STATE_CANCELED);

    const binding = store.bind(agent.id, "sdk-client-thread"),
      streamState = store.taskStreamState.bind(store);
    let advancedDuringSubscription = false;
    store.taskStreamState = (taskId, principalId, targetAgentId) => {
      const state = streamState(taskId, principalId, targetAgentId);
      if (state && !advancedDuringSubscription) {
        advancedDuringSubscription = true;
        store.setTaskState(taskId, binding.principalId, TaskState.Working);
        store.setTaskState(taskId, binding.principalId, TaskState.Completed);
      }
      return state;
    };
    const streamedResponse = client.sendMessageStream(
        {
          tenant: "",
          message: Message.fromJSON({
            messageId: "sdk-client-stream",
            role: Role.ROLE_USER,
            parts: [{ text: "stream work" }],
          }),
          configuration: undefined,
          metadata: undefined,
        },
        options,
      ),
      streamed = streamedResponse[Symbol.asyncIterator](),
      initial = await streamed.next();
    if (initial.done || initial.value.payload?.$case !== "task")
      throw new Error("SDK stream did not return an initial task");
    const streamedTaskId = initial.value.payload.value.id;
    const working = await streamed.next();
    expect(working.value?.payload).toMatchObject({
      $case: "statusUpdate",
      value: { taskId: streamedTaskId, status: { state: A2ATaskState.TASK_STATE_WORKING } },
    });
    const completed = await streamed.next();
    expect(completed.value?.payload).toMatchObject({
      $case: "statusUpdate",
      value: { taskId: streamedTaskId, status: { state: A2ATaskState.TASK_STATE_COMPLETED } },
    });
    expect((await streamed.next()).done).toBe(true);

    const resumable = await client.sendMessage(
      {
        tenant: "",
        message: Message.fromJSON({
          messageId: "sdk-client-resubscribe",
          role: Role.ROLE_USER,
          parts: [{ text: "resume work" }],
        }),
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately: true,
        },
        metadata: undefined,
      },
      options,
    );
    if (!("id" in resumable)) throw new Error("SDK client did not return a resumable task");
    store.setTaskState(resumable.id, binding.principalId, TaskState.Working);
    const subscriptionResponse = client.resubscribeTask({ tenant: "", id: resumable.id }, options),
      subscription = subscriptionResponse[Symbol.asyncIterator](),
      current = await subscription.next();
    expect(current.value?.payload).toMatchObject({
      $case: "task",
      value: { id: resumable.id, status: { state: A2ATaskState.TASK_STATE_WORKING } },
    });
    store.setTaskState(resumable.id, binding.principalId, TaskState.Completed);
    expect((await subscription.next()).value?.payload).toMatchObject({
      $case: "statusUpdate",
      value: { taskId: resumable.id, status: { state: A2ATaskState.TASK_STATE_COMPLETED } },
    });
    expect((await subscription.next()).done).toBe(true);
    expect(store.agent(agent.id)?.slug).toBe("sdk-client");
    store.close();
  });

  test("honors blocking, interrupted, immediate, and response-history configuration", async () => {
    for (const [suffix, state, expected] of [
      ["completed", TaskState.Completed, "TASK_STATE_COMPLETED"],
      ["input", TaskState.InputRequired, "TASK_STATE_INPUT_REQUIRED"],
      ["auth", TaskState.AuthRequired, "TASK_STATE_AUTH_REQUIRED"],
    ] as const) {
      const store = fixture(),
        agent = store.createAgent(`execution-${suffix}`),
        requester = store.createToken(),
        binding = store.bind(agent.id, `execution-${suffix}-thread`),
        streamState = store.taskStreamState.bind(store);
      let advanced = false;
      store.taskStreamState = (taskId, principalId, targetAgentId) => {
        const snapshot = streamState(taskId, principalId, targetAgentId);
        if (snapshot && !advanced) {
          advanced = true;
          store.setTaskState(taskId, binding.principalId, TaskState.Working);
          store.setTaskState(taskId, binding.principalId, state);
        }
        return snapshot;
      };
      const response = await handleA2A(
          store,
          new Request(`http://localhost/agents/execution-${suffix}/a2a`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${requester.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: suffix,
              method: "SendMessage",
              params: {
                message: {
                  messageId: `execution-${suffix}`,
                  role: "ROLE_USER",
                  parts: [{ text: "work" }],
                },
              },
            }),
          }),
          7432,
        ),
        result = record(await response.json());
      expect(result.error).toBeUndefined();
      const task = record(record(result.result).task ?? result.result);
      expect(task.status).toMatchObject({ state: expected });
      store.close();
    }

    const store = fixture(),
      requester = store.createToken();
    store.createAgent("execution-immediate");
    store.taskStreamState = () => {
      throw new Error("immediate mode must not subscribe");
    };
    const response = await handleA2A(
        store,
        new Request("http://localhost/agents/execution-immediate/a2a", {
          method: "POST",
          headers: {
            authorization: `Bearer ${requester.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "immediate",
            method: "SendMessage",
            params: {
              message: {
                messageId: "execution-immediate",
                role: "ROLE_USER",
                parts: [{ text: "work" }],
              },
              configuration: { returnImmediately: true, historyLength: 0 },
            },
          }),
        }),
        7432,
      ),
      result = record(await response.json()),
      task = record(record(result.result).task ?? result.result);
    expect(task.status).toMatchObject({ state: "TASK_STATE_SUBMITTED" });
    expect(task.history ?? []).toEqual([]);
    store.close();
  });

  test("replays persisted application events once and closes terminal subscriptions", async () => {
    const store = fixture(),
      agent = store.createAgent("application-port"),
      requester = store.createToken(),
      binding = store.bind(agent.id, "application-port-thread"),
      application = new A2AApplication(store),
      principal: AuthenticatedPrincipal = {
        id: requester.principalId,
        kind: "external-a2a-client",
        scopes: ["*"],
      },
      target = {
        agentId: agent.id,
        slug: agent.slug,
        profileRevision: agent.profile_revision,
      },
      accepted = await application.acceptMessage({
        principal,
        target,
        requestCorrelationId: "application-port-request",
        externalMessageId: "application-port-message",
        role: "agent",
        parts: [{ kind: "text", text: "work" }],
        requestMetadata: {},
        messageMetadata: {},
        delivery: {
          mode: "wake_when_idle",
          priority: "normal",
          notifyOn: ["terminal"],
          replyExpected: true,
        },
        canonicalRequestHash: "application-port-hash",
      });
    expect(store.db.query<{ role: string }, []>("SELECT role FROM a2a_messages").get()?.role).toBe(
      "agent",
    );
    store.setTaskState(accepted.taskId, binding.principalId, TaskState.Working);
    store.publishArtifacts(accepted.taskId, binding.principalId, [
      {
        artifactId: "application-port-artifact",
        name: "result",
        description: "",
        parts: [
          {
            content: { $case: "text", value: "result" },
            filename: "",
            mediaType: "text/plain",
          },
        ],
        extensions: [],
      },
    ]);
    const compact = await application.listTasks({
        principal,
        target,
        historyLength: 0,
      }),
      full = await application.listTasks({
        principal,
        target,
        states: ["submitted", "working"],
        updatedAfter: "1970-01-01T00:00:00.000Z",
        includeArtifacts: true,
      }),
      future = await application.listTasks({
        principal,
        target,
        updatedAfter: "2999-01-01T00:00:00.000Z",
      });
    expect(compact.tasks).toMatchObject([{ history: [], artifacts: [] }]);
    expect(full.tasks).toMatchObject([
      { artifacts: [{ artifactId: "application-port-artifact" }] },
    ]);
    expect(future).toMatchObject({ tasks: [], totalSize: 0 });
    store.setTaskState(accepted.taskId, binding.principalId, TaskState.Completed);

    const subscription = await application.subscribeTask({
      principal,
      target,
      taskId: accepted.taskId,
      afterSequence: 1,
    });
    expect(subscription.replay.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect((await subscription.live[Symbol.asyncIterator]().next()).done).toBe(true);
    await subscription.close();
    store.close();
  });
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}
function errorContext(data: unknown) {
  if (!Array.isArray(data)) return;
  for (const detail of data)
    if (
      typeof detail === "object" &&
      detail !== null &&
      "retryable" in detail &&
      typeof detail.retryable === "boolean" &&
      "correlationId" in detail &&
      typeof detail.correlationId === "string"
    )
      return {
        code: "code" in detail && typeof detail.code === "string" ? detail.code : undefined,
        retryable: detail.retryable,
        correlationId: detail.correlationId,
      };
}
