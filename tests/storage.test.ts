import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role } from "@a2a-js/sdk";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

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
    store.setTaskState(accepted.task.id, targetBinding.principalId, "working");
    store.setTaskState(accepted.task.id, targetBinding.principalId, "completed", "done");
    const notification = store.db
      .query(
        "SELECT kind,target_agent_id,pinned_binding_id,state FROM delivery_intents WHERE kind='task-event-notification'",
      )
      .get() as {
      kind: string;
      target_agent_id: string;
      pinned_binding_id: string;
      state: string;
    };
    expect(notification).toEqual({
      kind: "task-event-notification",
      target_agent_id: sender.id,
      pinned_binding_id: senderBinding.id,
      state: "pending",
    });
    store.close();
  });
});
