import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role } from "@a2a-js/sdk";
import { TaskState, transition } from "../packages/domain/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acs-model-"));
  roots.push(root);
  const paths: Paths = {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
  };
  return new Store(paths);
}

function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % limit;
  };
}

function pick<T>(values: readonly T[], index: number): T {
  const value = values.at(index % values.length);
  if (value === undefined) throw new Error("empty model domain");
  return value;
}

function principal(store: Store) {
  const value = store.authenticate(readFileSync(store.config.token, "utf8"));
  if (!value) throw new Error("missing test principal");
  return value;
}

const taskStates = Object.values(TaskState),
  terminalTaskStates = new Set([
    TaskState.Completed,
    TaskState.Failed,
    TaskState.Canceled,
    TaskState.Rejected,
  ]),
  taskEdges = new Set([
    `${TaskState.Submitted}:${TaskState.Working}`,
    `${TaskState.Submitted}:${TaskState.InputRequired}`,
    `${TaskState.Submitted}:${TaskState.Failed}`,
    `${TaskState.Submitted}:${TaskState.Canceled}`,
    `${TaskState.Submitted}:${TaskState.Rejected}`,
    `${TaskState.Working}:${TaskState.InputRequired}`,
    `${TaskState.Working}:${TaskState.AuthRequired}`,
    `${TaskState.Working}:${TaskState.Completed}`,
    `${TaskState.Working}:${TaskState.Failed}`,
    `${TaskState.Working}:${TaskState.Canceled}`,
    `${TaskState.InputRequired}:${TaskState.Working}`,
    `${TaskState.InputRequired}:${TaskState.Failed}`,
    `${TaskState.InputRequired}:${TaskState.Canceled}`,
    `${TaskState.AuthRequired}:${TaskState.Working}`,
    `${TaskState.AuthRequired}:${TaskState.Failed}`,
    `${TaskState.AuthRequired}:${TaskState.Canceled}`,
  ]);

function taskTransitionAllowed(current: TaskState, next: TaskState) {
  return (
    (current === next && terminalTaskStates.has(current)) || taskEdges.has(`${current}:${next}`)
  );
}

describe("reference state models", () => {
  test("generated task transitions agree with the reference graph", () => {
    for (let seed = 1; seed <= 64; seed++) {
      const next = random(seed);
      let state = TaskState.Submitted;
      for (let step = 0; step < 32; step++) {
        const candidate = pick(taskStates, next(taskStates.length));
        if (taskTransitionAllowed(state, candidate)) {
          expect(transition(state, candidate)).toBe(candidate);
          state = candidate;
        } else {
          expect(() => transition(state, candidate)).toThrow("TASK_STATE_CONFLICT");
        }
      }
    }
  });

  test("generated binding changes preserve one active epoch and rebind continuity", () => {
    const store = fixture(),
      agent = store.createAgent("model-binding"),
      next = random(91);
    let activeId: string | null = null,
      expectedEpoch = 0;
    for (let step = 0; step < 64; step++) {
      if (activeId && next(4) === 0) {
        store.revokeBinding(activeId);
        activeId = null;
      } else {
        expectedEpoch++;
        activeId = store.bind(agent.id, `model-thread-${step}`).id;
      }
      const rows = store.db
          .query<{ id: string; epoch: number; status: string }, [string]>(
            "SELECT id,epoch,status FROM runtime_bindings WHERE agent_id=? ORDER BY epoch",
          )
          .all(agent.id),
        active = rows.filter((row) => row.status === "active");
      expect(rows.at(-1)?.epoch).toBe(expectedEpoch);
      expect(active.map((row) => row.id)).toEqual(activeId ? [activeId] : []);
    }
    expect(() => store.revokeBinding("bnd_missing")).toThrow("BINDING_NOT_FOUND");
    store.close();
  });

  test("generated delivery operations agree with the reference transitions", () => {
    const store = fixture(),
      target = store.createAgent("model-delivery"),
      requester = principal(store),
      next = random(301),
      states = [
        "pending",
        "leased",
        "attempting",
        "deferred",
        "accepted",
        "acceptance-unknown",
        "failed-terminal",
        "canceled",
        "superseded",
      ],
      operations = ["retry", "cancel", "resolve-accepted", "resolve-retry", "resolve-cancel"];
    for (let step = 0; step < 128; step++) {
      const accepted = store.accept(
          target.id,
          requester.id,
          Message.fromJSON({
            messageId: `delivery-model-${step}`,
            role: Role.ROLE_USER,
            parts: [{ text: "work" }],
          }),
          {},
        ),
        state = pick(states, next(states.length)),
        operation = pick(operations, next(operations.length));
      store.db
        .query("UPDATE delivery_intents SET state=? WHERE id=?")
        .run(state, accepted.deliveryId);
      const allowed =
        (operation === "retry" && ["deferred", "failed-terminal"].includes(state)) ||
        (operation === "cancel" && !["accepted", "canceled", "superseded"].includes(state)) ||
        (operation.startsWith("resolve-") && state === "acceptance-unknown");
      const apply = () => {
        if (operation === "retry") return store.retryDelivery(accepted.deliveryId);
        if (operation === "cancel") return store.cancelDelivery(accepted.deliveryId);
        return store.resolveUnknown(
          accepted.deliveryId,
          operation
            .replace("resolve-", "not-accepted-and-")
            .replace("not-accepted-and-accepted", "accepted"),
        );
      };
      if (allowed) expect(apply).not.toThrow();
      else expect(apply).toThrow();
    }
    store.close();
  });

  test("generated cancellation races and duplicate requests agree with their models", () => {
    const store = fixture(),
      target = store.createAgent("model-races"),
      executor = store.bind(target.id, "model-races-thread"),
      requester = principal(store),
      next = random(701),
      acceptedMessages = new Map<string, string>();
    for (let step = 0; step < 128; step++) {
      const messageId = `duplicate-${next(16)}`,
        text = `payload-${next(4)}`,
        existing = acceptedMessages.get(messageId),
        accept = () =>
          store.accept(
            target.id,
            requester.id,
            Message.fromJSON({ messageId, role: Role.ROLE_USER, parts: [{ text }] }),
            {},
          );
      if (existing === undefined) {
        expect(accept().duplicate).toBe(false);
        acceptedMessages.set(messageId, text);
      } else if (existing === text) {
        expect(accept().duplicate).toBe(true);
      } else {
        expect(accept).toThrow("ACS_IDEMPOTENCY_CONFLICT");
      }
    }
    for (let step = 0; step < 32; step++) {
      const accepted = store.accept(
          target.id,
          requester.id,
          Message.fromJSON({
            messageId: `cancellation-${step}`,
            role: Role.ROLE_USER,
            parts: [{ text: "work" }],
          }),
          {},
        ),
        race = next(4);
      if (race > 0) store.setTaskState(accepted.task.id, executor.principalId, TaskState.Working);
      if (race === 2)
        store.setTaskState(accepted.task.id, executor.principalId, TaskState.Completed);
      if (race === 3) store.setTaskState(accepted.task.id, executor.principalId, TaskState.Failed);
      if (race < 2)
        expect(store.requestCancellation(accepted.task.id, requester.id).status?.state).toBe(5);
      else expect(() => store.requestCancellation(accepted.task.id, requester.id)).toThrow();
      expect(() =>
        store.setTaskState(accepted.task.id, executor.principalId, TaskState.Working),
      ).toThrow("TASK_STATE_CONFLICT");
    }
    expect(
      store.db.query<{ count: number }, []>("SELECT count(*) count FROM delivery_intents").get()
        ?.count,
    ).toBe(acceptedMessages.size + 32);
    store.close();
  });
});
