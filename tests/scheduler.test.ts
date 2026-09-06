import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, TaskState as A2ATaskState } from "@a2a-js/sdk";
import type { RuntimeDeliveryRequest } from "../contracts/runtime-adapter";
import { DeliveryScheduler, retryDelay } from "../packages/application/src/scheduler";
import { TaskState } from "../packages/domain/src/index";
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
  test("shared-turn completion and cancellation keep task results independent", async () => {
    const store = fixture(),
      agent = store.createAgent("shared"),
      requester = authenticated(store),
      binding = store.bind(agent.id, "shared-thread", {
        deliveryPolicy: { interruptOnCancel: true },
      }),
      adapter = new FakeRuntimeAdapter(),
      release = Promise.withResolvers<void>();
    const tasks = ["a", "b"].map((messageId) =>
      store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({ messageId, role: "ROLE_USER", parts: [{ text: messageId }] }),
        {},
      ),
    );
    let target: RuntimeDeliveryRequest["target"] | undefined,
      interrupts = 0;
    adapter.deliver = async (request) => {
      target = request.target;
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "shared-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: request.deliveryId },
      };
    };
    adapter.cancel = async () => {
      interrupts++;
      return { outcome: "accepted", acceptedAt: new Date().toISOString() };
    };
    adapter.observe = async function* (signal) {
      await release.promise;
      if (!target) return;
      yield {
        type: "execution.completed",
        execution: { session: target.session, opaqueId: "shared-turn" },
        outcome: "completed",
        finalParts: [{ kind: "text", text: "unattributed runtime output" }],
      };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const scheduler = new DeliveryScheduler(store, adapter, "shared-test");
    try {
      await scheduler.start();
      await until(
        () =>
          store.db
            .query<{ count: number }, []>("SELECT count(*) count FROM runtime_executions")
            .get()?.count === 2,
      );
      release.resolve();
      await until(
        () =>
          store.db
            .query<{ count: number }, []>(
              "SELECT count(*) count FROM runtime_executions WHERE state='completed'",
            )
            .get()?.count === 2,
      );
      for (const task of tasks)
        expect(store.task(task.task.id, requester.id)?.status?.state).toBe(
          A2ATaskState.TASK_STATE_WORKING,
        );
      const first = tasks[0],
        second = tasks[1];
      if (!first || !second) throw new Error("missing task");
      store.requestCancellation(first.task.id, requester.id);
      scheduler.signal();
      await until(
        () =>
          store.task(first.task.id, requester.id)?.status?.state ===
          A2ATaskState.TASK_STATE_CANCELED,
      );
      expect(interrupts).toBe(0);
      store.completeTask(second.task.id, binding.principalId, "explicit result for b", []);
      expect(store.task(second.task.id, requester.id)?.status?.state).toBe(
        A2ATaskState.TASK_STATE_COMPLETED,
      );
    } finally {
      release.resolve();
      await scheduler.stop();
      store.close();
    }
  });

  test("an ambiguous canceled task cannot starve unrelated delivery", async () => {
    const store = fixture(),
      agent = store.createAgent("ambiguous"),
      other = store.createAgent("other"),
      requester = authenticated(store),
      adapter = new FakeRuntimeAdapter();
    store.bind(agent.id, "ambiguous-thread");
    store.bind(other.id, "other-thread");
    const first = store.accept(
      agent.id,
      requester.id,
      Message.fromJSON({ messageId: "ambiguous", role: "ROLE_USER", parts: [{ text: "first" }] }),
      {},
    );
    store.db
      .query("UPDATE delivery_intents SET state='acceptance-unknown' WHERE id=?")
      .run(first.deliveryId);
    store.requestCancellation(first.task.id, requester.id);
    const second = store.accept(
      other.id,
      requester.id,
      Message.fromJSON({ messageId: "unrelated", role: "ROLE_USER", parts: [{ text: "second" }] }),
      {},
    );
    adapter.deliver = async () => ({
      outcome: "accepted",
      acceptedAt: new Date().toISOString(),
      execution: { opaqueId: "other-turn", relationship: "unknown" },
      evidence: { scheme: "fake", value: "other" },
    });
    const scheduler = new DeliveryScheduler(store, adapter, "fairness-test");
    try {
      await scheduler.start();
      await until(() => deliveryState(store, second.deliveryId)?.state === "accepted");
      expect(deliveryState(store, first.deliveryId)?.state).toBe("acceptance-unknown");
    } finally {
      await scheduler.stop();
      store.close();
    }
  });

  test("bounds exponential retry delay with jitter", () => {
    expect(retryDelay(1, () => 0.5)).toBe(250);
    expect(retryDelay(99, () => 0.999)).toBeLessThan(30_000);
  });
  test("starts degraded and reconnects when the runtime appears", async () => {
    const store = fixture();
    const agent = store.createAgent("reconnected-session");
    store.bind(agent.id, "reconnected-thread");
    let starts = 0;
    const inspected: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.start = async () => {
      if (++starts === 1) throw new Error("offline");
    };
    adapter.inspectSession = async (session) => {
      inspected.push(session.opaqueId);
      return {
        session,
        availability: "idle",
        observedAt: new Date().toISOString(),
        attributes: {},
      };
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
    expect(
      store.db.query<{ state: string }, []>("SELECT state FROM runtime_installations").get()?.state,
    ).toBe("online");
    expect(inspected).toEqual(["reconnected-thread"]);
    expect(
      store.db
        .query<{ availability: string | null }, []>(
          "SELECT last_observed_availability availability FROM runtime_bindings WHERE status='active'",
        )
        .get()?.availability,
    ).toBe("idle");
    await scheduler.stop();
    store.close();
  });
  test("leases and accepts direct delivery through the runtime port", async () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      principal = authenticated(store);
    store.bind(agent.id, "thread-1", {
      deliveryPolicy: { interruptOnCancel: false },
    });
    const accepted = store.accept(
      agent.id,
      principal.id,
      Message.fromJSON({ messageId: "one", role: "ROLE_USER", parts: [{ text: "work" }] }),
      {
        mode: "direct",
        traceContext: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
        },
      },
    );
    const adapter = new FakeRuntimeAdapter();
    let delivered: RuntimeDeliveryRequest | undefined;
    adapter.deliver = async (request) => {
      delivered = request;
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: "ok" },
      };
    };
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
    expect(store.task(accepted.task.id, principal.id)).toMatchObject({
      metadata: {
        "urn:agent-communications:delivery-status:v1": {
          state: "accepted",
          deliveryId: accepted.deliveryId,
          attemptCount: 1,
        },
      },
    });
    expect(delivered).toMatchObject({
      traceContext: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      },
    });
    await scheduler.stop();
    store.close();
  });
  test("replays execution events received before runtime acceptance is committed", async () => {
    const store = fixture(),
      agent = store.createAgent("early-events"),
      principal = authenticated(store);
    store.bind(agent.id, "early-events-thread");
    const accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "early-events",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      delivering = Promise.withResolvers<{
        session: { installationId: `ins_${string}`; opaqueId: string };
      }>(),
      emitted = Promise.withResolvers<void>(),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async (request) => {
      delivering.resolve({ session: request.target.session });
      await emitted.promise;
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "early-turn", relationship: "started" },
        evidence: { scheme: "fake", value: "early-turn" },
      };
    };
    adapter.observe = async function* (signal) {
      yield { type: "adapter.connection", state: "online" };
      const target = await delivering.promise,
        execution = { opaqueId: "early-turn", session: target.session };
      yield { type: "execution.started", session: target.session, execution };
      yield {
        type: "execution.completed",
        execution,
        outcome: "completed",
        finalParts: [{ kind: "text", text: "early final answer" }],
      };
      emitted.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const scheduler = new DeliveryScheduler(store, adapter, "early-events");
    await scheduler.start();
    await Bun.sleep(400);
    expect(store.task(accepted.task.id, principal.id)).toMatchObject({
      status: {
        state: A2ATaskState.TASK_STATE_WORKING,
      },
    });
    await scheduler.stop();
    store.close();
  });
  test("uses direct delivery with no wake-policy opt-in", async () => {
    const store = fixture(),
      agent = store.createAgent("atomic-wake"),
      principal = authenticated(store);
    store.bind(agent.id, "thread-atomic-wake");
    const accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "atomic-wake",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      delivered = Promise.withResolvers<void>(),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => {
      delivered.resolve();
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: "atomic-wake" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "atomic-wake");
    await scheduler.start();
    scheduler.signal();
    await delivered.promise;
    await Bun.sleep(0);
    expect(deliveryState(store, accepted.deliveryId)?.state).toBe("accepted");
    await scheduler.stop();
    store.close();
  });
  test("honors runtime-probed capability reductions", async () => {
    const store = fixture(),
      agent = store.createAgent("probed-wake"),
      principal = authenticated(store);
    store.bind(agent.id, "thread-probed-wake");
    const accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "probed-wake",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      adapter = new FakeRuntimeAdapter();
    let deliveries = 0;
    adapter.probe = async () => ({
      state: "ready",
      observedAt: new Date().toISOString(),
      capabilities: { ...adapter.descriptor.capabilities, directDelivery: false },
      diagnostics: [],
    });
    adapter.deliver = async () => {
      deliveries++;
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: "probed-wake" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "probed-wake");
    await scheduler.start();
    scheduler.signal();
    await Bun.sleep(350);
    expect(deliveries).toBe(0);
    expect(deliveryState(store, accepted.deliveryId)).toEqual({
      state: "deferred",
      state_reason: "unsupported-capability",
    });
    await scheduler.stop();
    store.close();
  });
  test("does not let one busy lane hide another target", async () => {
    const store = fixture(),
      principal = authenticated(store),
      congested = store.createAgent("congested"),
      available = store.createAgent("available");
    store.bind(congested.id, "thread-congested");
    store.bind(available.id, "thread-available");
    for (let index = 0; index < 101; index++)
      store.accept(
        congested.id,
        principal.id,
        Message.fromJSON({
          messageId: `congested-${index}`,
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      );
    store.accept(
      available.id,
      principal.id,
      Message.fromJSON({
        messageId: "available",
        role: "ROLE_USER",
        parts: [{ text: "work" }],
      }),
      { mode: "direct" },
    );
    const releaseCongested = Promise.withResolvers<void>(),
      availableDelivered = Promise.withResolvers<void>(),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async (request) => {
      if (request.target.session.opaqueId === "thread-congested") await releaseCongested.promise;
      else availableDelivered.resolve();
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: request.deliveryId },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "fair-lanes", {
      concurrency: 2,
      leaseMs: 1000,
      retryBaseMs: 10,
      retryCapMs: 100,
      reconnectMs: 10,
    });
    await scheduler.start();
    scheduler.signal();
    const delivered = await Promise.race([
      availableDelivered.promise.then(() => true),
      Bun.sleep(1000).then(() => false),
    ]);
    releaseCongested.resolve();
    await scheduler.stop();
    expect(delivered).toBe(true);
    store.close();
  });
  test("persists redacted runtime rejection diagnostics", async () => {
    const store = fixture(),
      agent = store.createAgent("rejected-runtime"),
      principal = authenticated(store);
    store.bind(agent.id, "thread-rejected-runtime");
    const accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "rejected-runtime",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "rejected",
      reason: "runtime-protocol-error",
      retryable: false,
      details: { code: "INVALID_REQUEST" },
    });
    const scheduler = new DeliveryScheduler(store, adapter, "rejected-runtime");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query<{ outcome: string; error_code: string; error_json: string }, [string]>(
          "SELECT outcome,error_code,error_json FROM delivery_attempts WHERE intent_id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({
      outcome: "rejected",
      error_code: "runtime-protocol-error",
      error_json: JSON.stringify({ code: "INVALID_REQUEST" }),
    });
    expect(deliveryState(store, accepted.deliveryId)?.state).toBe("failed-terminal");
    await scheduler.stop();
    store.close();
  });
  test("backs off retryable runtime rejections", async () => {
    const store = fixture(),
      agent = store.createAgent("retryable-rejection"),
      principal = authenticated(store);
    store.bind(agent.id, "thread-retryable-rejection");
    const accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "retryable-rejection",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "rejected",
      reason: "runtime-protocol-error",
      retryable: true,
    });
    const scheduler = new DeliveryScheduler(store, adapter, "retryable-rejection");
    await scheduler.start();
    await Bun.sleep(400);
    const delivery = store.db
      .query<
        { state: string; state_reason: string; not_before_ms: number; updated_at_ms: number },
        [string]
      >("SELECT state,state_reason,not_before_ms,updated_at_ms FROM delivery_intents WHERE id=?")
      .get(accepted.deliveryId);
    expect(delivery).toMatchObject({
      state: "deferred",
      state_reason: "runtime-protocol-error",
    });
    expect(delivery?.not_before_ms).toBeGreaterThanOrEqual(delivery?.updated_at_ms ?? Infinity);
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
      { mode: "direct" },
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
      execution: { opaqueId: "fake-turn", relationship: "unknown" },
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
  test("redelivers only attempts that expired before the runtime write", async () => {
    const store = fixture(),
      agent = store.createAgent("write-boundary-worker"),
      principal = authenticated(store),
      binding = store.bind(agent.id, "write-boundary-thread"),
      unflushed = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({ messageId: "unflushed", role: "ROLE_USER", parts: [{ text: "one" }] }),
        { mode: "direct" },
      ),
      flushed = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({ messageId: "flushed", role: "ROLE_USER", parts: [{ text: "two" }] }),
        { mode: "direct" },
      ),
      expired = Date.now() - 1;
    store.db
      .query(
        "UPDATE delivery_intents SET state='attempting',attempt_count=1,pinned_binding_id=?,pinned_binding_epoch=?,lease_owner='dead-process',lease_expires_at_ms=? WHERE id IN (?,?)",
      )
      .run(binding.id, binding.epoch, expired, unflushed.deliveryId, flushed.deliveryId);
    const insertAttempt = store.db.query(
      "INSERT INTO delivery_attempts(id,intent_id,attempt_number,adapter_id,binding_id,binding_epoch,started_at_ms,request_flushed_at_ms) VALUES(?,?,1,'codex.app-server',?,?,?,?)",
    );
    insertAttempt.run(
      "atm_unflushed",
      unflushed.deliveryId,
      binding.id,
      binding.epoch,
      expired,
      null,
    );
    insertAttempt.run(
      "atm_flushed",
      flushed.deliveryId,
      binding.id,
      binding.epoch,
      expired,
      expired,
    );

    const deliveries: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async (request) => {
      deliveries.push(request.deliveryId);
      request.markRequestFlushed?.();
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: "recovered" },
      };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "replacement");
    await scheduler.start();
    await Bun.sleep(700);
    expect(deliveries).toEqual([unflushed.deliveryId]);
    expect(deliveryState(store, unflushed.deliveryId)?.state).toBe("accepted");
    expect(deliveryState(store, flushed.deliveryId)?.state).toBe("acceptance-unknown");
    expect(store.task(flushed.task.id, principal.id)).toMatchObject({
      metadata: {
        "urn:agent-communications:delivery-status:v1": {
          state: "acceptance-unknown",
          deliveryId: flushed.deliveryId,
          attemptCount: 1,
        },
      },
    });
    expect(
      store.db
        .query<{ outcome: string; error_code: string }, [string]>(
          "SELECT outcome,error_code FROM delivery_attempts WHERE id=?",
        )
        .get("atm_unflushed"),
    ).toEqual({ outcome: "deferred", error_code: "lease-expired-before-write" });
    expect(
      store.db
        .query<{ outcome: string; reconciliation_token: string }, [string]>(
          "SELECT outcome,reconciliation_token FROM delivery_attempts WHERE id=?",
        )
        .get("atm_flushed"),
    ).toEqual({
      outcome: "acceptance-unknown",
      reconciliation_token: `write-boundary-thread:${flushed.deliveryId}`,
    });
    expect(
      store.db
        .query<{ request_flushed_at_ms: number | null }, [string, number]>(
          "SELECT request_flushed_at_ms FROM delivery_attempts WHERE intent_id=? AND attempt_number=?",
        )
        .get(unflushed.deliveryId, 2)?.request_flushed_at_ms,
    ).toBeNumber();
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
        { mode: "direct" },
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
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
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
  test("aborts in-flight runtime work during shutdown", async () => {
    const store = fixture(),
      agent = store.createAgent("shutdown-target"),
      requester = authenticated(store);
    store.bind(agent.id, "shutdown-thread");
    const accepted = store.accept(
      agent.id,
      requester.id,
      Message.fromJSON({ messageId: "shutdown", role: "ROLE_USER", parts: [{ text: "work" }] }),
      { mode: "direct" },
    );
    const adapter = new FakeRuntimeAdapter();
    let markStarted: (() => void) | undefined,
      aborted = false;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    adapter.deliver = async (request, signal) => {
      markStarted?.();
      request.markRequestFlushed?.();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const scheduler = new DeliveryScheduler(store, adapter, "shutdown");
    await scheduler.start();
    await started;
    await scheduler.stop();
    expect(aborted).toBe(true);
    expect(deliveryState(store, accepted.deliveryId)).toEqual({
      state: "acceptance-unknown",
      state_reason: "request-flushed-no-response",
    });
    expect(
      store.db
        .query<{ outcome: string; reconciliation_token: string }, [string]>(
          "SELECT outcome,reconciliation_token FROM delivery_attempts WHERE intent_id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({
      outcome: "acceptance-unknown",
      reconciliation_token: `shutdown-thread:${accepted.deliveryId}`,
    });
    store.close();
  });
  test("stops the adapter after its connection drops", async () => {
    const store = fixture(),
      adapter = new FakeRuntimeAdapter();
    let stopped = false;
    adapter.observe = async function* () {
      yield { type: "adapter.connection", state: "offline" };
    };
    adapter.stop = async () => {
      stopped = true;
    };
    const scheduler = new DeliveryScheduler(store, adapter, "disconnected-shutdown");
    await scheduler.start();
    await Bun.sleep(10);
    await scheduler.stop();
    expect(stopped).toBe(true);
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
        { mode: "direct" },
      ),
      strictDelivery = store.accept(
        strict.id,
        requester.id,
        Message.fromJSON({ messageId: "strict", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "direct" },
      ),
      expiredDelivery = store.accept(
        expired.id,
        requester.id,
        Message.fromJSON({ messageId: "expired", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "direct", expiresAt: new Date(Date.now() - 1000).toISOString() },
      ),
      disabledDelivery = store.accept(
        disabled.id,
        requester.id,
        Message.fromJSON({ messageId: "disabled", role: "ROLE_USER", parts: [{ text: "work" }] }),
        { mode: "direct" },
      );
    const pin = store.db.query(
      "UPDATE delivery_intents SET state='deferred',state_reason='offline',not_before_ms=?,pinned_binding_id=?,pinned_binding_epoch=? WHERE id=?",
    );
    pin.run(Date.now() + 60_000, followOld.id, followOld.epoch, followDelivery.deliveryId);
    pin.run(Date.now() + 60_000, strictOld.id, strictOld.epoch, strictDelivery.deliveryId);
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
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
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
    store.bind(agent.id, "thread-cancel", { deliveryPolicy: { interruptOnCancel: true } });
    const accepted = store.accept(
      agent.id,
      requester.id,
      Message.fromJSON({ messageId: "cancel-one", role: "ROLE_USER", parts: [{ text: "work" }] }),
      { mode: "direct" },
    );
    const canceled: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async () => ({
      outcome: "accepted",
      acceptedAt: new Date().toISOString(),
      execution: { opaqueId: "owned-turn", relationship: "started" },
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
    store.requestCancellation(accepted.task.id, requester.id);
    expect(
      store.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) count FROM task_events WHERE task_id=? AND event_type='cancellation-requested'",
        )
        .get(accepted.task.id)?.count,
    ).toBe(1);
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
  test("settles cancellation only after an in-flight write has a definitive outcome", async () => {
    const store = fixture(),
      agent = store.createAgent("cancel-in-flight-target"),
      requester = authenticated(store);
    store.bind(agent.id, "thread-cancel-in-flight");
    const accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "cancel-in-flight",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      adapter = new FakeRuntimeAdapter();
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    adapter.deliver = async () => {
      started.resolve();
      await release.promise;
      return { outcome: "deferred", reason: "offline" };
    };
    const scheduler = new DeliveryScheduler(store, adapter, "test-cancel-in-flight");
    await scheduler.start();
    await started.promise;
    const requested = store.requestCancellation(accepted.task.id, requester.id);
    expect(requested.status?.state).not.toBe(TaskState.Canceled);
    expect(requested.metadata).toMatchObject({
      "urn:agent-communications:cancellation:v1": { requested: true },
    });
    release.resolve();
    await Bun.sleep(400);
    expect(
      store.db
        .query<{ state: string }, [string]>("SELECT state FROM a2a_tasks WHERE id=?")
        .get(accepted.task.id)?.state,
    ).toBe("canceled");
    expect(deliveryState(store, accepted.deliveryId)?.state).toBe("canceled");
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
        { mode: "direct" },
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
        execution: { opaqueId: "local-input-turn", relationship: "started" },
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
        type: "execution.completed",
        execution: {
          opaqueId: "local-input-turn",
          session: {
            installationId: bindingRow.installation_id,
            opaqueId: "another-thread",
          },
        },
        outcome: "completed",
        finalParts: [{ kind: "text", text: "unrelated" }],
      };
      yield {
        type: "execution.awaiting-local-input",
        execution: {
          opaqueId: "local-input-turn",
          session: {
            installationId: bindingRow.installation_id,
            opaqueId: bindingRow.session_opaque_id,
          },
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
        .query<
          {
            availability: string;
            execution_id_matches: number;
            execution_state: string;
            task_state: string;
          },
          [string]
        >(
          "SELECT b.last_observed_availability availability,i.runtime_execution_id=e.id execution_id_matches,e.state execution_state,t.state task_state FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN a2a_tasks t ON t.id=i.task_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE i.id=?",
        )
        .get(accepted.deliveryId),
    ).toEqual({
      availability: "idle",
      execution_id_matches: 1,
      execution_state: "awaiting-local-input",
      task_state: "working",
    });
    await scheduler.stop();
    store.close();
  });
  test("records notification execution without transitioning the task", async () => {
    const store = fixture(),
      sender = store.createAgent("notification-sender"),
      target = store.createAgent("notification-target"),
      senderBinding = store.bind(sender.id, "notification-sender-thread"),
      targetBinding = store.bind(target.id, "notification-target-thread"),
      accepted = store.accept(
        target.id,
        senderBinding.principalId,
        Message.fromJSON({
          messageId: "notification-execution",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { notifyOn: ["input-required"] },
      );
    store.db
      .query("UPDATE delivery_intents SET state='accepted' WHERE id=?")
      .run(accepted.deliveryId);
    store.setTaskState(accepted.task.id, targetBinding.principalId, TaskState.Working);
    store.setTaskState(
      accepted.task.id,
      targetBinding.principalId,
      TaskState.InputRequired,
      "question",
    );
    const delivered = Promise.withResolvers<{
        installationId: `ins_${string}`;
        opaqueId: string;
      }>(),
      adapter = new FakeRuntimeAdapter();
    adapter.deliver = async (request) => {
      delivered.resolve(request.target.session);
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "notification-turn", relationship: "started" },
        evidence: { scheme: "fake", value: "notification-turn" },
      };
    };
    adapter.observe = async function* (signal) {
      yield { type: "adapter.connection", state: "online" };
      const session = await delivered.promise;
      yield {
        type: "execution.completed",
        execution: { opaqueId: "notification-turn", session },
        outcome: "completed",
        finalParts: [{ kind: "text", text: "must not complete the task" }],
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const scheduler = new DeliveryScheduler(store, adapter, "notification-execution");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query<{ state: string }, [string]>("SELECT state FROM a2a_tasks WHERE id=?")
        .get(accepted.task.id)?.state,
    ).toBe("input-required");
    expect(
      store.db.query<{ count: number }, []>("SELECT count(*) count FROM runtime_executions").get(),
    ).toEqual({ count: 1 });
    await scheduler.stop();
    store.close();
  });
  test("finalizes the runtime execution without replacing an explicit task result", async () => {
    const store = fixture(),
      agent = store.createAgent("explicit-result-target"),
      requester = authenticated(store),
      binding = store.bind(agent.id, "thread-explicit-result"),
      bindingRow = store.binding(binding.id),
      accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "explicit-result",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      adapter = new FakeRuntimeAdapter();
    if (!bindingRow) throw new Error("missing binding");
    let delivered: (() => void) | undefined, completeRuntime: (() => void) | undefined;
    const runtimeAccepted = new Promise<void>((resolve) => {
        delivered = resolve;
      }),
      runtimeCompleted = new Promise<void>((resolve) => {
        completeRuntime = resolve;
      });
    adapter.deliver = async () => {
      delivered?.();
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "explicit-result-turn", relationship: "started" },
        evidence: { scheme: "fake", value: "explicit-result-turn" },
      };
    };
    adapter.observe = async function* (signal) {
      yield { type: "adapter.connection", state: "online" };
      await runtimeCompleted;
      yield {
        type: "execution.completed",
        execution: {
          opaqueId: "explicit-result-turn",
          session: {
            installationId: bindingRow.installation_id,
            opaqueId: bindingRow.session_opaque_id,
          },
        },
        outcome: "completed",
        finalParts: [{ kind: "text", text: "automatic result", mediaType: "text/plain" }],
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const scheduler = new DeliveryScheduler(store, adapter, "explicit-result");
    await scheduler.start();
    await runtimeAccepted;
    await Bun.sleep(50);
    const assignee = store.db
      .query<{ id: `prn_${string}` }, [string]>("SELECT id FROM principals WHERE binding_id=?")
      .get(binding.id);
    if (!assignee) throw new Error("missing assignee principal");
    store.setTaskState(accepted.task.id, assignee.id, TaskState.Completed, "explicit result");
    completeRuntime?.();
    await Bun.sleep(50);
    expect(
      store.db.query<{ state: string }, []>("SELECT state FROM runtime_executions").get()?.state,
    ).toBe("completed");
    expect(
      store.db
        .query<{ state: string; summary: string }, [string]>(
          "SELECT state,summary FROM a2a_tasks WHERE id=?",
        )
        .get(accepted.task.id),
    ).toEqual({ state: "completed", summary: "explicit result" });
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
      { mode: "direct" },
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
    expect(store.db.query("SELECT state FROM a2a_tasks WHERE id=?").get(accepted.task.id)).toEqual({
      state: "working",
    });
    await scheduler.stop();
    store.close();
  });
  test("keeps a completed delivery attempt immutable", async () => {
    const store = fixture(),
      agent = store.createAgent("immutable-attempt"),
      requester = authenticated(store);
    store.bind(agent.id, "immutable-attempt-thread");
    const accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "immutable-attempt-message",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      scheduler = new DeliveryScheduler(store, new FakeRuntimeAdapter(), "immutable-attempt");
    await scheduler.start();
    await Bun.sleep(400);
    expect(() =>
      store.db
        .query("UPDATE delivery_attempts SET outcome='rejected' WHERE intent_id=?")
        .run(accepted.deliveryId),
    ).toThrow("DELIVERY_ATTEMPT_IMMUTABLE");
    expect(() =>
      store.db.query("DELETE FROM delivery_attempts WHERE intent_id=?").run(accepted.deliveryId),
    ).toThrow("DELIVERY_ATTEMPT_IMMUTABLE");
    await scheduler.stop();
    store.close();
  });
  test("wakes offline and busy deliveries when their bound session becomes ready", async () => {
    const store = fixture(),
      agent = store.createAgent("status-wake-target"),
      requester = authenticated(store),
      binding = store.bind(agent.id, "status-wake-thread"),
      bindingRow = store.binding(binding.id);
    if (!bindingRow) throw new Error("missing binding");
    const accepted = store.accept(
        agent.id,
        requester.id,
        Message.fromJSON({
          messageId: "status-wake",
          role: "ROLE_USER",
          parts: [{ text: "work" }],
        }),
        { mode: "direct" },
      ),
      firstDelivery = Promise.withResolvers<void>(),
      secondDelivery = Promise.withResolvers<void>(),
      adapter = new FakeRuntimeAdapter();
    let deliveries = 0;
    adapter.deliver = async () => {
      if (++deliveries === 1) {
        firstDelivery.resolve();
        return { outcome: "deferred", reason: "offline", retryAfterMs: 30_000 };
      }
      if (deliveries === 2) {
        secondDelivery.resolve();
        return { outcome: "deferred", reason: "local-input", retryAfterMs: 30_000 };
      }
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: "fake-turn", relationship: "unknown" },
        evidence: { scheme: "fake", value: "status-wake" },
      };
    };
    adapter.observe = async function* (signal) {
      yield { type: "adapter.connection", state: "online" };
      await firstDelivery.promise;
      await Bun.sleep(25);
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
      await secondDelivery.promise;
      await Bun.sleep(25);
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
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const scheduler = new DeliveryScheduler(store, adapter, "status-wake");
    await scheduler.start();
    await Bun.sleep(950);
    expect(deliveries).toBe(3);
    expect(deliveryState(store, accepted.deliveryId)?.state).toBe("accepted");
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

async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("scheduler condition timed out");
}
