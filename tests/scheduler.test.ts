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
});
