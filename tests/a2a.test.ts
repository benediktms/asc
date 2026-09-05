import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCard, Message, Role } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { TaskState } from "../packages/domain/src/index";
import { handleA2A } from "../packages/protocol-a2a/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-a2a-"));
  roots.push(root);
  const paths: Paths = {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
  };
  return new Store(paths);
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
    expect(store.agent(agent.id)?.slug).toBe("bounded");
    store.close();
  });

  test("discovers an agent and sends, reads, then cancels a durable task", async () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      { token } = store.createToken();
    const card = await handleA2A(
      store,
      new Request("http://localhost/agents/backend/.well-known/agent-card.json"),
      7432,
    );
    expect(card.status).toBe(200);
    const call = async (method: string, params: unknown) => {
      const response = await handleA2A(
        store,
        new Request("http://localhost/agents/backend/a2a", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "A2A-Version": "1.0",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
        }),
        7432,
      );
      const result: {
        result?: {
          id?: string;
          status?: { state: string };
          task?: { id: string; status?: { state: string } };
        };
        error?: {
          code?: number;
          message: string;
          data?: { code?: string; retryable?: boolean; correlationId?: string };
        };
      } = await response.json();
      return result;
    };
    const sent = await call("SendMessage", {
      message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "work" }] },
    });
    expect(sent.error).toBeUndefined();
    const taskId = sent.result?.task?.id;
    expect(taskId).toStartWith("tsk_");
    if (!taskId) throw new Error("SendMessage did not return a task");
    const conflict = await call("SendMessage", {
      message: { messageId: "a2a-1", role: "ROLE_USER", parts: [{ text: "different" }] },
    });
    expect(conflict.error?.data?.code).toBe("ACS_IDEMPOTENCY_CONFLICT");
    expect(conflict.error?.data?.retryable).toBe(false);
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
    expect((await call("SubscribeToTask", { id: "tsk_missing" })).error?.code).toBe(-32001);
    const read = (await call("GetTask", { id: taskId })).result;
    expect(read?.task?.id ?? read?.id).toBe(taskId);
    const canceled = (await call("CancelTask", { id: taskId })).result;
    expect(canceled?.task?.status?.state ?? canceled?.status?.state).toBe("TASK_STATE_CANCELED");
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
          configuration: undefined,
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
    ).toBe(5);

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
      value: { taskId: streamedTaskId, status: { state: 2 } },
    });
    const completed = await streamed.next();
    expect(completed.value?.payload).toMatchObject({
      $case: "statusUpdate",
      value: { taskId: streamedTaskId, status: { state: 3 } },
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
        configuration: undefined,
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
      value: { id: resumable.id, status: { state: 2 } },
    });
    store.setTaskState(resumable.id, binding.principalId, TaskState.Completed);
    expect((await subscription.next()).value?.payload).toMatchObject({
      $case: "statusUpdate",
      value: { taskId: resumable.id, status: { state: 3 } },
    });
    expect((await subscription.next()).done).toBe(true);
    expect(store.agent(agent.id)?.slug).toBe("sdk-client");
    store.close();
  });
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}
