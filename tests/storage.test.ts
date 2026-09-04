import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role } from "@a2a-js/sdk";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import { TaskState } from "../packages/domain/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-"));
  roots.push(root);
  const p: Paths = {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
  };
  return new Store(p);
}

describe("durable acceptance", () => {
  test("signs opaque cursors and rejects tampering", () => {
    const store = fixture(),
      cursor = store.encodeCursor({ sortKey: "backend", id: "agt_1", offset: 1 });
    expect(store.decodeCursor<{ offset: number }>(cursor).offset).toBe(1);
    expect(() => store.decodeCursor(`${cursor}x`)).toThrow("invalid cursor");
    store.close();
  });
  test("commits one task and one delivery for an idempotent message", () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      principal = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    const message = Message.fromJSON({
      messageId: "request-1",
      role: Role.ROLE_USER,
      parts: [{ text: "work" }],
    });
    const first = store.accept(agent.id, principal.id, message, {}),
      second = store.accept(agent.id, principal.id, message, {});
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(store.db.query("SELECT count(*) n FROM delivery_intents").get()).toEqual({ n: 1 });
    store.close();
  });
  test("uses delivery defaults and queues subscribed terminal notifications", () => {
    const store = fixture(),
      sender = store.createAgent("sender"),
      target = store.createAgent("target"),
      senderBinding = store.bind(sender.id, "sender-thread"),
      targetBinding = store.bind(target.id, "target-thread");
    const message = Message.fromJSON({
      messageId: "request-2",
      role: Role.ROLE_USER,
      parts: [{ text: "work" }],
    });
    const accepted = store.accept(target.id, senderBinding.principalId, message, {
      mode: "wake_when_idle",
      priority: "normal",
      notifyOn: ["terminal"],
      replyExpected: true,
    });
    store.setTaskState(accepted.task.id, targetBinding.principalId, TaskState.Working);
    store.setTaskState(accepted.task.id, targetBinding.principalId, TaskState.Completed, "done");
    const notification = store.db
      .query<
        {
          kind: string;
          target_agent_id: string;
          pinned_binding_id: string;
          state: string;
        },
        []
      >(
        "SELECT kind,target_agent_id,pinned_binding_id,state FROM delivery_intents WHERE kind='task-event-notification'",
      )
      .get()!;
    expect(notification).toEqual({
      kind: "task-event-notification",
      target_agent_id: sender.id,
      pinned_binding_id: senderBinding.id,
      state: "pending",
    });
    store.close();
  });
  test("allows only the assigned agent to publish and complete work", () => {
    const store = fixture(),
      target = store.createAgent("worker"),
      stranger = store.createAgent("stranger"),
      targetBinding = store.bind(target.id, "worker-thread"),
      strangerBinding = store.bind(stranger.id, "stranger-thread"),
      requester = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    const accepted = store.accept(
      target.id,
      requester.id,
      Message.fromJSON({ messageId: "request-3", role: Role.ROLE_USER, parts: [{ text: "work" }] }),
      {},
    );
    const output = [
      { content: { $case: "text" as const, value: "done" }, filename: "", mediaType: "text/plain" },
    ];
    expect(() =>
      store.publishMessage(accepted.task.id, strangerBinding.principalId, output),
    ).toThrow("TASK_NOT_ASSIGNED");
    expect(
      store.publishMessage(accepted.task.id, targetBinding.principalId, output).task.status?.state,
    ).toBe(2);
    expect(
      store.setTaskState(accepted.task.id, targetBinding.principalId, TaskState.Completed, "done")
        .status?.state,
    ).toBe(3);
    store.close();
  });
  test("rejects executor callbacks from a rebound session after delivery was pinned", () => {
    const store = fixture(),
      target = store.createAgent("rebound-worker"),
      first = store.bind(target.id, "old-thread"),
      requester = store.authenticate(readFileSync(store.config.token, "utf8"))!,
      accepted = store.accept(
        target.id,
        requester.id,
        Message.fromJSON({
          messageId: "request-4",
          role: Role.ROLE_USER,
          parts: [{ text: "work" }],
        }),
        { mode: "append_context" },
      );
    store.db
      .query("UPDATE delivery_intents SET pinned_binding_id=?,pinned_binding_epoch=? WHERE id=?")
      .run(first.id, first.epoch, accepted.deliveryId);
    const rebound = store.bind(target.id, "new-thread");
    expect(
      store.db
        .query<{ pinned_binding_id: string; pinned_binding_epoch: number }, [string]>(
          "SELECT pinned_binding_id,pinned_binding_epoch FROM delivery_intents WHERE id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({ pinned_binding_id: first.id, pinned_binding_epoch: first.epoch });
    expect(() =>
      store.setTaskState(
        accepted.task.id,
        rebound.principalId,
        TaskState.Completed,
        "wrong session",
      ),
    ).toThrow("TASK_NOT_ASSIGNED");
    store.close();
  });
});
