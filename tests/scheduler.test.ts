import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message } from "@a2a-js/sdk";
import { DeliveryScheduler, retryDelay } from "../packages/application/src/scheduler";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import { FakeRuntimeAdapter } from "./fake-runtime-adapter";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-scheduler-"));
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

describe("delivery scheduler", () => {
  test("bounds exponential retry delay with jitter", () => {
    expect(retryDelay(1, () => 0.5)).toBe(250);
    expect(retryDelay(99, () => 0.999)).toBeLessThan(30_000);
  });
  test("starts degraded and reconnects when the runtime appears", async () => {
    const store = fixture();
    let starts = 0;
    const adapter = new FakeRuntimeAdapter();
    adapter.start = async () => {
      if (++starts === 1) throw new Error("offline");
    };
    const scheduler = new DeliveryScheduler(store, adapter, "reconnect", {
      concurrency: 1,
      leaseMs: 1000,
      retryBaseMs: 10,
      retryCapMs: 100,
      reconnectMs: 10,
    });
    await scheduler.start();
    await Bun.sleep(300);
    expect(starts).toBe(2);
    await scheduler.stop();
    store.close();
  });
  test("leases and accepts context delivery through the runtime port", async () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      principal = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    store.bind(agent.id, "thread-1");
    const accepted = store.accept(
      agent.id,
      principal.id,
      Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }),
      { mode: "append_context" },
    );
    const adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "accepted",
      acceptedAt: new Date().toISOString(),
      evidence: { scheme: "fake", value: "ok" },
    });
    const scheduler = new DeliveryScheduler(store, adapter, "test");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query<{ state: string; attempt_count: number }, [string]>(
          "SELECT state,attempt_count FROM delivery_intents WHERE id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({ state: "accepted", attempt_count: 1 });
    await scheduler.stop();
    store.close();
  });
  test("recovers an expired delivery lease after restart", async () => {
    const store = fixture(),
      agent = store.createAgent("expired-lease-worker"),
      principal = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    store.bind(agent.id, "expired-lease-thread");
    const accepted = store.accept(
      agent.id,
      principal.id,
      Message.fromJSON({
        messageId: "expired-lease",
        role: "ROLE_USER",
        parts: [{ text: "work" }],
      }),
      { mode: "append_context" },
    );
    store.db
      .query(
        "UPDATE delivery_intents SET state='leased',lease_owner='dead-process',lease_expires_at_ms=? WHERE id=?",
      )
      .run(Date.now() - 1, accepted.deliveryId);
    const adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "accepted",
      acceptedAt: new Date().toISOString(),
      evidence: { scheme: "fake", value: "recovered" },
    });
    const scheduler = new DeliveryScheduler(store, adapter, "replacement");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query("SELECT state,lease_owner,lease_expires_at_ms FROM delivery_intents WHERE id=?")
        .get(accepted.deliveryId),
    ).toEqual({ state: "accepted", lease_owner: null, lease_expires_at_ms: null });
    await scheduler.stop();
    store.close();
  });
  test("interrupts only the correlated ACS execution on cancellation", async () => {
    const store = fixture(),
      agent = store.createAgent("cancel-target"),
      requester = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    store.bind(agent.id, "thread-cancel");
    const accepted = store.accept(
      agent.id,
      requester.id,
      Message.fromJSON({ messageId: "cancel-one", role: "ROLE_USER", parts: [{ text: "work" }] }),
      { mode: "append_context" },
    );
    const canceled: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "accepted",
      acceptedAt: new Date().toISOString(),
      execution: { opaqueId: "owned-turn", alreadyRunning: false },
      evidence: { scheme: "fake", value: "owned-turn" },
    });
    adapter.cancel = async (request) => {
      canceled.push(request.execution.opaqueId);
      return { outcome: "accepted", acceptedAt: new Date().toISOString() };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "test-cancel");
    await scheduler.start();
    await Bun.sleep(400);
    store.requestCancellation(accepted.task.id, requester.id);
    await Bun.sleep(400);
    expect(canceled).toEqual(["owned-turn"]);
    expect(
      store.db
        .query<{ state: string }, [string]>("SELECT state FROM a2a_tasks WHERE id=?")
        .get(accepted.task.id)!.state,
    ).toBe("canceled");
    await scheduler.stop();
    store.close();
  });
  test("reconciles an ambiguous runtime write without redelivery", async () => {
    const store = fixture(),
      agent = store.createAgent("ambiguous-target"),
      requester = store.authenticate(readFileSync(store.config.token, "utf8"))!;
    store.bind(agent.id, "thread-ambiguous");
    const accepted = store.accept(
      agent.id,
      requester.id,
      Message.fromJSON({
        messageId: "ambiguous-one",
        role: "ROLE_USER",
        parts: [{ text: "work" }],
      }),
      { mode: "append_context" },
    );
    let deliveries = 0,
      reconciliations = 0;
    const adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => {
      deliveries++;
      return {
        outcome: "acceptance-unknown",
        ambiguity: "connection-reset",
        reconciliationToken: "marker",
      };
    };
    adapter.reconcile = async () => {
      reconciliations++;
      return {
        outcome: "accepted",
        execution: { opaqueId: "recovered-turn" },
        evidence: { marker: "found" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "test-reconcile");
    await scheduler.start();
    await Bun.sleep(700);
    expect(deliveries).toBe(1);
    expect(reconciliations).toBe(1);
    expect(
      store.db.query("SELECT state FROM delivery_intents WHERE id=?").get(accepted.deliveryId),
    ).toEqual({ state: "accepted" });
    await scheduler.stop();
    store.close();
  });
});
