import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message } from "@a2a-js/sdk";
import { DeliveryScheduler, retryDelay } from "../packages/application/src/scheduler";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import type { RuntimeAdapter } from "../contracts/runtime-adapter";

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
    const adapter = {
      descriptor: { adapterApiVersion: 1 },
      async start() {
        if (++starts === 1) throw new Error("offline");
      },
      async stop() {},
      async *observe(signal: AbortSignal) {
        yield { type: "adapter.connection", state: "online" };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    } as unknown as RuntimeAdapter;
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
    const adapter = {
      descriptor: { adapterApiVersion: 1 },
      async start() {},
      async stop() {},
      async *observe(signal: AbortSignal) {
        yield { type: "adapter.connection", state: "online" };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      async deliver() {
        return {
          outcome: "accepted",
          acceptedAt: new Date().toISOString(),
          evidence: { scheme: "fake", value: "ok" },
        };
      },
    } as unknown as RuntimeAdapter;
    const scheduler = new DeliveryScheduler(store, adapter, "test");
    await scheduler.start();
    await Bun.sleep(400);
    expect(
      store.db
        .query("SELECT state,attempt_count FROM delivery_intents WHERE id=?")
        .get(accepted.deliveryId) as { state: string; attempt_count: number },
    ).toEqual({ state: "accepted", attempt_count: 1 });
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
      adapter = {
        descriptor: { adapterApiVersion: 1 },
        async start() {},
        async stop() {},
        async *observe(signal: AbortSignal) {
          yield { type: "adapter.connection", state: "online" };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
        async deliver() {
          return {
            outcome: "accepted",
            acceptedAt: new Date().toISOString(),
            execution: { opaqueId: "owned-turn", alreadyRunning: false },
            evidence: { scheme: "fake", value: "owned-turn" },
          };
        },
        async cancel(request: { execution: { opaqueId: string } }) {
          canceled.push(request.execution.opaqueId);
          return { outcome: "accepted", acceptedAt: new Date().toISOString() };
        },
      } as unknown as RuntimeAdapter;
    const scheduler = new DeliveryScheduler(store, adapter, "test-cancel");
    await scheduler.start();
    await Bun.sleep(400);
    store.requestCancellation(accepted.task.id, requester.id);
    await Bun.sleep(400);
    expect(canceled).toEqual(["owned-turn"]);
    expect(
      (
        store.db.query("SELECT state FROM a2a_tasks WHERE id=?").get(accepted.task.id) as {
          state: string;
        }
      ).state,
    ).toBe("canceled");
    await scheduler.stop();
    store.close();
  });
});
