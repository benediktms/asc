import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role } from "@a2a-js/sdk";
import { controlHandler } from "../packages/protocol-control/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import { FakeRuntimeAdapter } from "./fake-runtime-adapter";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("control protocol", () => {
  test("requires protocol version and verifies a runtime session before binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-control-"));
    roots.push(root);
    const paths: Paths = {
      data: join(root, "acs.db"),
      runtime: join(root, "control.sock"),
      token: join(root, "control.token"),
      bridgeToken: join(root, "bridge.token"),
      secret: join(root, "secret.key"),
    };
    const store = new Store(paths),
      inspected: string[] = [],
      adapter = new FakeRuntimeAdapter();
    adapter.inspectSession = async (session) => {
      inspected.push(session.opaqueId);
      return {
        session,
        availability: "idle",
        observedAt: new Date().toISOString(),
        attributes: {},
      };
    };
    const handler = controlHandler(store, new Date().toISOString(), () => {}, adapter),
      token = readFileSync(paths.token, "utf8");
    const call = async (method: string, params: unknown, version = "1", bearer = token) =>
      handler(
        new Request("http://localhost", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "ACS-Control-Version": version,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: "test", method, params }),
        }),
      );
    expect((await call("agents.create", { slug: "backend" })).status).toBe(200);
    expect((await call("bindings.bind", { agent: "backend", session: "thread-1" })).status).toBe(
      200,
    );
    expect(inspected).toEqual(["thread-1"]);
    expect((await call("agents.list", {}, "2")).status).toBe(426);
    expect(
      store.db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM audit_events WHERE action IN ('agent.create','binding.bind')",
        )
        .get()?.n,
    ).toBe(2);
    const bridgeToken = readFileSync(paths.bridgeToken, "utf8"),
      denied = (await call("agents.create", { slug: "forbidden" }, "1", bridgeToken)).json();
    expect(await denied).toMatchObject({ error: { message: "NOT_AUTHORIZED" } });
    store.close();
  });
  test("filters stable keyset pages for control-plane lists", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-control-pages-"));
    roots.push(root);
    const paths: Paths = {
        data: join(root, "acs.db"),
        runtime: join(root, "control.sock"),
        token: join(root, "control.token"),
        bridgeToken: join(root, "bridge.token"),
        secret: join(root, "secret.key"),
      },
      store = new Store(paths),
      adapter = new FakeRuntimeAdapter();
    adapter.inspectSession = async (session) => ({
      session,
      availability: "idle",
      observedAt: new Date().toISOString(),
      attributes: {},
    });
    const handler = controlHandler(store, new Date().toISOString(), () => {}, adapter),
      token = readFileSync(paths.token, "utf8"),
      call = async (method: string, params: unknown) => {
        const response = await handler(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "ACS-Control-Version": "1",
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
          }),
        );
        return page(await response.json());
      };
    const beta = store.createAgent("beta");
    store.createAgent("delta");
    const firstAgents = await call("agents.list", { limit: 1 });
    store.createAgent("alpha");
    const secondAgents = await call("agents.list", { limit: 1, cursor: firstAgents.nextCursor });
    expect(slugs(firstAgents.items)).toEqual(["beta"]);
    expect(slugs(secondAgents.items)).toEqual(["delta"]);
    expect(slugs((await call("agents.list", { text: "ELT" })).items)).toEqual(["delta"]);
    store.updateAgent("delta", {
      skills: [{ id: "reports", name: "Reporting", description: "Build reports", tags: ["data"] }],
    });
    expect(slugs((await call("agents.list", { skill: "data" })).items)).toEqual(["delta"]);

    store.bind(beta.id, "beta-old");
    const betaBinding = store.bind(beta.id, "beta-current"),
      activeBindings = await call("bindings.list", { agent: "beta", status: ["active"] });
    expect(activeBindings.items.map((item) => item.id)).toEqual([betaBinding.id]);

    const principal = required(store.authenticate(token), "principal");
    for (const messageId of ["page-one", "page-two"])
      store.accept(
        beta.id,
        principal.id,
        Message.fromJSON({ messageId, role: Role.ROLE_USER, parts: [{ text: "work" }] }),
        {},
      );
    const deliveries = await call("deliveries.list", {
      targetAgent: "beta",
      state: ["pending"],
      limit: 1,
    });
    const moreDeliveries = await call("deliveries.list", {
      targetAgent: "beta",
      state: ["pending"],
      limit: 1,
      cursor: deliveries.nextCursor,
    });
    expect([...deliveries.items, ...moreDeliveries.items]).toHaveLength(2);

    const inbox = await call("inbox.list", {
      threadId: betaBinding.sessionId,
      states: ["submitted"],
      limit: 1,
    });
    const moreInbox = await call("inbox.list", {
      threadId: betaBinding.sessionId,
      states: ["submitted"],
      limit: 1,
      cursor: inbox.nextCursor,
    });
    expect([...inbox.items, ...moreInbox.items]).toHaveLength(2);
    store.close();
  });
});

function page(value: unknown) {
  const rpc = record(value),
    result = record(rpc.result),
    items = result.items;
  if (!Array.isArray(items)) throw new Error("expected page items");
  return {
    items: items.map(record),
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : undefined,
  };
}
function slugs(items: Record<string, unknown>[]) {
  return items.map((item) => item.slug);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${name}`);
  return value;
}
