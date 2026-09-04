import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter } from "../contracts/runtime-adapter";
import { controlHandler } from "../packages/protocol-control/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

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
      inspected: string[] = [];
    const adapter = {
      descriptor: { capabilities: {} },
      async inspectSession(session: { opaqueId: string }) {
        inspected.push(session.opaqueId);
        return {
          session,
          availability: "idle",
          observedAt: new Date().toISOString(),
          attributes: {},
        };
      },
    } as unknown as RuntimeAdapter;
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
      (
        store.db
          .query(
            "SELECT count(*) n FROM audit_events WHERE action IN ('agent.create','binding.bind')",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
    const bridgeToken = readFileSync(paths.bridgeToken, "utf8"),
      denied = (await call("agents.create", { slug: "forbidden" }, "1", bridgeToken)).json();
    expect(await denied).toMatchObject({ error: { message: "NOT_AUTHORIZED" } });
    store.close();
  });
});
