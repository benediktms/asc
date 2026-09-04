import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleA2A } from "../packages/protocol-a2a/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("A2A JSON-RPC", () => {
  test("discovers an agent and sends, reads, then cancels a durable task", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-a2a-"));
    roots.push(root);
    const paths: Paths = {
        data: join(root, "acs.db"),
        runtime: join(root, "control.sock"),
        token: join(root, "control.token"),
        bridgeToken: join(root, "bridge.token"),
        secret: join(root, "secret.key"),
      },
      store = new Store(paths),
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
      return (await response.json()) as {
        result?: {
          id?: string;
          status?: { state: string };
          task?: { id: string; status?: { state: string } };
        };
        error?: {
          message: string;
          data?: { code?: string; retryable?: boolean; correlationId?: string };
        };
      };
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
    const read = (await call("GetTask", { id: taskId })).result;
    expect(read?.task?.id ?? read?.id).toBe(taskId);
    const canceled = (await call("CancelTask", { id: taskId })).result;
    expect(canceled?.task?.status?.state ?? canceled?.status?.state).toBe("TASK_STATE_CANCELED");
    expect(
      (
        store.db.query("SELECT count(*) n FROM delivery_intents WHERE task_id=?").get(taskId) as {
          n: number;
        }
      ).n,
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
    expect(store.agent(agent.id)?.slug).toBe("backend");
    store.close();
  });
});
