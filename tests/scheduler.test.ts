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
      principal = authenticated(store);
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
      principal = authenticated(store);
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
  test("renews the attempt lease during a runtime call", async () => {
    const store = fixture(),
      agent = store.createAgent("lease-renewal"),
      requester = authenticated(store);
    store.bind(agent.id, "lease-renewal-thread");
    const accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "lease-renewal",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "append_context" },
      ),
      adapter = new FakeRuntimeAdapter();
    let release: (() => void) | undefined, markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    adapter.deliver = async () => {
      markStarted?.();
      await blocked;
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        evidence: { scheme: "fake", value: "renewed" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "lease-renewal", {
      concurrency: 1,
      leaseMs: 60,
      retryBaseMs: 10,
      retryCapMs: 100,
      reconnectMs: 10,
    });
    await scheduler.start();
    await started;
    await Bun.sleep(80);
    expect(
      store.db
        .query<{ lease_expires_at_ms: number }, [string]>(
          "SELECT lease_expires_at_ms FROM delivery_intents WHERE id=?",
        )
        .get(accepted.deliveryId)?.lease_expires_at_ms,
    ).toBeGreaterThan(Date.now());
    release?.();
    await scheduler.stop();
    store.close();
  });
  test("follows eligible rebinds and terminates unsafe delivery conditions", async () => {
    const store = fixture(),
      requester = authenticated(store),
      follow = store.createAgent("follow-rebind"),
      strict = store.createAgent("strict-rebind"),
      expired = store.createAgent("expired-target"),
      disabled = store.createAgent("disabled-target"),
      followOld = store.bind(follow.id, "follow-old"),
      strictOld = store.bind(strict.id, "strict-old", { continuityPolicy: "strict" });
    store.bind(expired.id, "expired-thread");
    store.bind(disabled.id, "disabled-thread");
    const followDelivery = store.accept(
        follow.id,
        requester.id,
        Message.fromJSON({ messageId: "follow", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "append_context" },
      ),
      strictDelivery = store.accept(
        strict.id,
        requester.id,
        Message.fromJSON({ messageId: "strict", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "append_context" },
      ),
      expiredDelivery = store.accept(
        expired.id,
        requester.id,
        Message.fromJSON({ messageId: "expired", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "append_context", expiresAt: new Date(Date.now() - 1000).toISOString() },
      ),
      disabledDelivery = store.accept(
        disabled.id,
        requester.id,
        Message.fromJSON({ messageId: "disabled", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "append_context" },
      );
    const pin = store.db.query(
      "UPDATE delivery_intents SET state='deferred',pinned_binding_id=?,pinned_binding_epoch=? WHERE id=?",
    );
    pin.run(followOld.id, followOld.epoch, followDelivery.deliveryId);
    pin.run(strictOld.id, strictOld.epoch, strictDelivery.deliveryId);
    store.bind(follow.id, "follow-new", { revokeExisting: true });
    store.bind(strict.id, "strict-new", { revokeExisting: true });
    store.updateAgent(disabled.id, { enabled: false });
    const sessions: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async (request) => {
      sessions.push(request.target.session.opaqueId);
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        evidence: { scheme: "fake", value: "accepted" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "continuity");
    await scheduler.start();
    await Bun.sleep(400);
    expect(sessions).toEqual(["follow-new"]);
    expect(deliveryState(store, followDelivery.deliveryId)).toEqual({
      state: "accepted",
      state_reason: null,
    });
    expect(deliveryState(store, strictDelivery.deliveryId)).toEqual({
      state: "failed-terminal",
      state_reason: "strict-binding-revoked",
    });
    expect(deliveryState(store, expiredDelivery.deliveryId)).toEqual({
      state: "failed-terminal",
      state_reason: "deadline-expired",
    });
    expect(deliveryState(store, disabledDelivery.deliveryId)).toEqual({
      state: "failed-terminal",
      state_reason: "target-disabled",
    });
    await scheduler.stop();
    store.close();
  });
  test("interrupts only the correlated ACS execution on cancellation", async () => {
    const store = fixture(),
      agent = store.createAgent("cancel-target"),
      requester = authenticated(store);
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
        .get(accepted.task.id)?.state,
    ).toBe("canceled");
    await scheduler.stop();
    store.close();
  });
  test("records local runtime input without changing the A2A task state", async () => {
    const store = fixture(),
      agent = store.createAgent("local-input-target"),
      requester = authenticated(store);
    const binding = store.bind(agent.id, "thread-local-input"),
      bindingRow = store.binding(binding.id);
    if (!bindingRow) throw new Error("missing binding");
    const accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "local-input-one",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "append_context" },
      ),
      adapter = new FakeRuntimeAdapter();
    let deliveryAccepted: (() => void) | undefined;
    const acceptedByRuntime = new Promise<void>((resolve) => {
      deliveryAccepted = resolve;
    });
    adapter.deliver = async () => {
      deliveryAccepted?.();
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "local-input-turn", alreadyRunning: false },
        evidence: { scheme: "fake", value: "local-input-turn" },
      };
    };
    adapter.observe = async function* (signal) {
      yield { type: "adapter.connection", state: "online" };
      yield {
        type: "session.observed",
        session: {
          installationId: bindingRow.installation_id,
          opaqueId: bindingRow.session_opaque_id,
        },
        snapshot: {
          session: {
            installationId: bindingRow.installation_id,
            opaqueId: bindingRow.session_opaque_id,
          },
          availability: "idle",
          observedAt: new Date().toISOString(),
          attributes: {},
        },
      };
      await acceptedByRuntime;
      await Bun.sleep(50);
      yield {
        type: "execution.awaiting-local-input",
        execution: {
          opaqueId: "local-input-turn",
          session: { installationId: "ins_codex_local", opaqueId: "thread-local-input" },
        },
        request: {
          opaqueId: "request-local-input",
          kind: "question",
          blocking: true,
        },
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const scheduler = new DeliveryScheduler(store, adapter, "test-local-input");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query<{ availability: string; execution_state: string; task_state: string }, [string]>(
          "SELECT b.last_observed_availability availability,e.state execution_state,t.state task_state FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN a2a_tasks t ON t.id=i.task_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE i.id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({
      availability: "idle",
      execution_state: "awaiting-local-input",
      task_state: "working",
    });
    await scheduler.stop();
    store.close();
  });
  test("reconciles an ambiguous runtime write without redelivery", async () => {
    const store = fixture(),
      agent = store.createAgent("ambiguous-target"),
      requester = authenticated(store);
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

function authenticated(store: Store) {
  const principal = store.authenticate(readFileSync(store.config.token, "utf8"));
  if (!principal) throw new Error("missing test principal");
  return principal;
}

function deliveryState(store: Store, deliveryId: string) {
  return store.db
    .query<{ state: string; state_reason: string | null }, [string]>(
      "SELECT state,state_reason FROM delivery_intents WHERE id=?",
    )
    .get(deliveryId);
}
