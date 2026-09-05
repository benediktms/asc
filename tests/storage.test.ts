import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role } from "@a2a-js/sdk";
import { Store, type Paths, type StoredPart } from "../packages/storage-sqlite/src/index";
import { TaskState } from "../packages/domain/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture(limits: Partial<Store["limits"]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "acs-"));
  roots.push(root);
  const p: Paths = {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
  };
  return new Store(p, limits);
}

function requestMessage(messageId: string) {
  return Message.fromJSON({ messageId, role: Role.ROLE_USER, parts: [{ text: "work" }] });
}
function authenticated(store: Store) {
  const principal = store.authenticate(readFileSync(store.config.token, "utf8"));
  if (!principal) throw new Error("missing test principal");
  return principal;
}

describe("durable acceptance", () => {
  test("repairs permissions on existing runtime credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-permissions-"));
    roots.push(root);
    const paths: Paths = {
      data: join(root, "acs.db"),
      runtime: join(root, "control.sock"),
      token: join(root, "control.token"),
      bridgeToken: join(root, "bridge.token"),
      secret: join(root, "secret.key"),
    };
    writeFileSync(paths.secret, Buffer.alloc(32, 1));
    writeFileSync(paths.token, "existing-control-token");
    writeFileSync(paths.bridgeToken, "existing-bridge-token");
    for (const file of [paths.secret, paths.token, paths.bridgeToken]) chmodSync(file, 0o666);
    const store = new Store(paths);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    for (const file of [paths.secret, paths.token, paths.bridgeToken])
      expect(statSync(file).mode & 0o777).toBe(0o600);
    store.close();
  });
  test("rejects a permissive runtime directory", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-unsafe-runtime-"));
    roots.push(root);
    chmodSync(root, 0o777);
    expect(
      () =>
        new Store({
          data: join(root, "acs.db"),
          runtime: join(root, "control.sock"),
          token: join(root, "control.token"),
          bridgeToken: join(root, "bridge.token"),
          secret: join(root, "secret.key"),
        }),
    ).toThrow("runtime directory must have mode 0700");
  });
  test("signs opaque cursors and rejects tampering", () => {
    const store = fixture(),
      cursor = store.encodeCursor({ sortKey: "backend", id: "agt_1", offset: 1 });
    expect(store.decodeCursor(cursor)).toEqual({ offset: 1, sortKey: "backend", id: "agt_1" });
    expect(() => store.decodeCursor(`${cursor}x`)).toThrow("invalid cursor");
    store.close();
  });
  test("paginates tasks by stable key when newer work arrives", async () => {
    const store = fixture(),
      agent = store.createAgent("paged-worker"),
      principal = authenticated(store);
    const ids: string[] = [];
    for (const messageId of ["page-1", "page-2", "page-3"]) {
      ids.push(
        store.accept(
          agent.id,
          principal.id,
          Message.fromJSON({ messageId, role: Role.ROLE_USER, parts: [{ text: messageId }] }),
          {},
        ).task.id,
      );
      await Bun.sleep(2);
    }
    const first = store.listTasks(agent.id, principal.id, { limit: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    await Bun.sleep(2);
    const newer = store.accept(
      agent.id,
      principal.id,
      Message.fromJSON({ messageId: "page-new", role: Role.ROLE_USER, parts: [{ text: "new" }] }),
      {},
    ).task.id;
    const second = store.listTasks(agent.id, principal.id, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect([...first.tasks, ...second.tasks].map((task) => task.id).toSorted()).toEqual(
      ids.toSorted(),
    );
    expect(second.tasks.map((task) => task.id)).not.toContain(newer);
    store.close();
  });
  test("commits one task and one delivery for an idempotent message", () => {
    const store = fixture(),
      agent = store.createAgent("backend"),
      principal = authenticated(store);
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
  test("rejects target overload without partial acceptance", () => {
    const store = fixture({ maxQueuedDeliveryIntents: 1 }),
      agent = store.createAgent("overloaded-worker"),
      principal = authenticated(store);
    store.accept(agent.id, principal.id, requestMessage("overload-1"), {});
    expect(() => store.accept(agent.id, principal.id, requestMessage("overload-2"), {})).toThrow(
      "ACS_OVERLOADED",
    );
    expect(store.db.query("SELECT count(*) count FROM a2a_tasks").get()).toEqual({ count: 1 });
    expect(store.db.query("SELECT count(*) count FROM delivery_intents").get()).toEqual({
      count: 1,
    });
    store.close();
  });
  test("rejects acceptance for a disabled target", () => {
    const store = fixture(),
      agent = store.createAgent("disabled-target"),
      principal = authenticated(store);
    store.updateAgent(agent.id, { enabled: false });
    expect(() => store.accept(agent.id, principal.id, requestMessage("disabled"), {})).toThrow(
      "ACS_AGENT_DISABLED",
    );
    expect(store.db.query("SELECT count(*) count FROM a2a_tasks").get()).toEqual({ count: 0 });
    store.close();
  });
  test("enforces configured message part limits", () => {
    const store = fixture({ maxParts: 1, maxTextPartBytes: 4 }),
      agent = store.createAgent("bounded-message"),
      principal = authenticated(store);
    expect(() =>
      store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "too-many-parts",
          role: Role.ROLE_USER,
          parts: [{ text: "one" }, { text: "two" }],
        }),
        {},
      ),
    ).toThrow("ACS_MESSAGE_TOO_LARGE");
    expect(() =>
      store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({
          messageId: "text-too-large",
          role: Role.ROLE_USER,
          parts: [{ text: "12345" }],
        }),
        {},
      ),
    ).toThrow("ACS_MESSAGE_TOO_LARGE");
    expect(store.db.query("SELECT count(*) count FROM a2a_tasks").get()).toEqual({ count: 0 });
    store.close();
  });
  test("rolls back when any acceptance write fails", () => {
    const tables = [
      "conversation_contexts",
      "a2a_tasks",
      "a2a_messages",
      "task_events",
      "delivery_intents",
      "idempotency_records",
    ];
    for (const failureTable of tables) {
      const store = fixture(),
        agent = store.createAgent(`rollback-${failureTable.replaceAll("_", "-")}`),
        principal = authenticated(store);
      store.db.exec(
        `CREATE TEMP TRIGGER fail_acceptance BEFORE INSERT ON ${failureTable} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      );
      expect(() =>
        store.accept(
          agent.id,
          principal.id,
          Message.fromJSON({
            messageId: `rollback-${failureTable}`,
            role: Role.ROLE_USER,
            parts: [{ text: "work" }],
          }),
          {},
        ),
      ).toThrow("injected failure");
      for (const table of tables)
        expect(store.db.query(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
      store.close();
    }
  });
  test("recovers committed work after a WAL restart", () => {
    const store = fixture(),
      config = store.config,
      agent = store.createAgent("restart-worker"),
      principal = authenticated(store),
      accepted = store.accept(
        agent.id,
        principal.id,
        Message.fromJSON({ messageId: "restart", role: Role.ROLE_USER, parts: [{ text: "work" }] }),
        {},
      );
    store.close();
    const reopened = new Store(config);
    expect(reopened.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(reopened.task(accepted.task.id, principal.id)?.id).toBe(accepted.task.id);
    expect(
      reopened.db.query("SELECT state FROM delivery_intents WHERE id=?").get(accepted.deliveryId),
    ).toEqual({ state: "pending" });
    reopened.close();
  });
  test("acquires the SQLite write lock before transaction work", () => {
    const first = fixture(),
      second = new Store(first.config, { busyTimeoutMs: 1 });
    first.write(() => {
      expect(() => second.db.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
    });
    second.close();
    first.close();
  });
  test("detects and repairs task projection drift from the event log", () => {
    const store = fixture(),
      target = store.createAgent("projection-worker"),
      binding = store.bind(target.id, "projection-thread"),
      requester = authenticated(store),
      accepted = store.accept(
        target.id,
        requester.id,
        Message.fromJSON({
          messageId: "projection",
          role: Role.ROLE_USER,
          parts: [{ text: "work" }],
        }),
        {},
      );
    store.publishMessage(accepted.task.id, binding.principalId, [
      { content: { $case: "text", value: "result" }, filename: "", mediaType: "text/plain" },
    ]);
    store.publishArtifacts(accepted.task.id, binding.principalId, [
      {
        artifactId: "artifact-1",
        name: "result",
        description: "",
        parts: [
          { content: { $case: "text", value: "artifact" }, filename: "", mediaType: "text/plain" },
        ],
        extensions: [],
      },
    ]);
    store.setTaskState(accepted.task.id, binding.principalId, TaskState.Completed, "done");
    expect(store.eventsAfter(accepted.task.id, 0).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    store.db
      .query("UPDATE a2a_tasks SET state='submitted',a2a_snapshot_json=? WHERE id=?")
      .run(JSON.stringify(accepted.task), accepted.task.id);
    expect(store.verifyTaskProjections()).toEqual({
      checked: 1,
      mismatched: [accepted.task.id],
      missing: [],
      repaired: 0,
    });
    expect(store.verifyTaskProjections(true).repaired).toBe(1);
    expect(store.verifyTaskProjections().mismatched).toEqual([]);
    expect(store.task(accepted.task.id, requester.id)?.status?.state).toBe(3);
    store.close();
  });
  test("enforces one active binding per agent and runtime session", () => {
    const store = fixture(),
      firstAgent = store.createAgent("first-bound-agent"),
      secondAgent = store.createAgent("second-bound-agent"),
      binding = store.bind(firstAgent.id, "shared-runtime-session");
    expect(() =>
      store.db
        .query(
          "INSERT INTO runtime_bindings(id,agent_id,installation_id,session_opaque_id,epoch,status,continuity_policy,delivery_policy_json,created_at_ms) SELECT 'bnd_duplicate_agent',agent_id,installation_id,'other-session',epoch+1,'active',continuity_policy,delivery_policy_json,created_at_ms FROM runtime_bindings WHERE id=?",
        )
        .run(binding.id),
    ).toThrow("UNIQUE constraint failed");
    expect(() =>
      store.db
        .query(
          "INSERT INTO runtime_bindings(id,agent_id,installation_id,session_opaque_id,epoch,status,continuity_policy,delivery_policy_json,created_at_ms) SELECT 'bnd_duplicate_session',?,installation_id,session_opaque_id,1,'active',continuity_policy,delivery_policy_json,created_at_ms FROM runtime_bindings WHERE id=?",
        )
        .run(secondAgent.id, binding.id),
    ).toThrow("UNIQUE constraint failed");
    store.close();
  });
  test("creates a Crockford claim and consumes it once", () => {
    const store = fixture(),
      agent = store.createAgent("claimed-agent"),
      requester = authenticated(store),
      claim = store.createClaim(agent.id, requester.id),
      binding = store.claim(claim.claimCode, "claimed-thread");
    expect(claim.claimCode).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    expect(binding.agentId).toBe(agent.id);
    expect(() => store.claim(claim.claimCode, "replayed-thread")).toThrow(
      "invalid or expired claim",
    );
    expect(store.binding(binding.id)?.session_opaque_id).toBe("claimed-thread");
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
      .get();
    if (!notification) throw new Error("missing task notification");
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
      requester = authenticated(store);
    const accepted = store.accept(
      target.id,
      requester.id,
      Message.fromJSON({ messageId: "request-3", role: Role.ROLE_USER, parts: [{ text: "work" }] }),
      {},
    );
    const output: StoredPart[] = [
      { content: { $case: "text", value: "done" }, filename: "", mediaType: "text/plain" },
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
      requester = authenticated(store),
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
    expect(() => store.bind(target.id, "new-thread")).toThrow("BINDING_CONFLICT");
    const rebound = store.bind(target.id, "new-thread", { revokeExisting: true });
    expect(
      store.db
        .query<{ disabled_at_ms: number | null }, [string]>(
          "SELECT disabled_at_ms FROM principals WHERE id=?",
        )
        .get(first.principalId)?.disabled_at_ms,
    ).toBeNumber();
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
