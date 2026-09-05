#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../packages/config/src/index";
import { controlCall } from "../packages/protocol-control/src/index";

const config = paths(),
  call = (method: string, params: unknown = {}) =>
    controlCall(config.runtime, config.token, method, params),
  timeline = new Array<{ at: string; event: string; taskId?: string; state?: string }>(),
  mark = (event: string, taskId?: string, state?: string) =>
    timeline.push({ at: new Date().toISOString(), event, taskId, state }),
  runId = Date.now().toString(36),
  architectSlug = `e2e-architect-${runId}`,
  backendSlug = `e2e-backend-${runId}`;

const initial = record(
    await call("system.initialize", {
      protocolVersion: "1.0",
      client: { name: "acs-real-codex-e2e", version: "0.1.0", instanceId: String(process.pid) },
      capabilities: {},
    }),
  ),
  initialInstanceId = string(record(initial.server).instanceId),
  architect = record(record(await call("agents.create", { slug: architectSlug })).agent),
  backend = record(record(await call("agents.create", { slug: backendSlug })).agent),
  architectClaim = record(await call("agents.createClaim", { agent: architectSlug })),
  backendClaim = record(await call("agents.createClaim", { agent: backendSlug }));

console.log(`Real-Codex verifier started for isolated run ${runId}.

1. In the architect Codex thread, call acs_claim with:
   ${string(architectClaim.claimCode)}
2. In a distinct backend Codex thread, call acs_claim with:
   ${string(backendClaim.claimCode)}

This verifier observes ASC state; it does not synthesize MCP metadata or model evidence.`);
const architectBinding = await waitForBinding(architectSlug),
  backendBinding = await waitForBinding(backendSlug);
if (
  string(record(architectBinding.session).opaqueId) ===
  string(record(backendBinding.session).opaqueId)
)
  throw new Error("REAL_CODEX_E2E_INVALID: both agents use the same Codex thread");
mark("agents-bound");

console.log(`
3. In architect, call acs_send to ${backendSlug}. Ask backend to request a choice and use
   notifyOn: ["input-required", "completed", "terminal"].`);
const task = await waitForTask(
  (item) =>
    item.requesterAgentId === string(architect.id) &&
    item.targetAgentId === string(backend.id) &&
    (item.state === "submitted" || item.state === "working"),
);
mark("task-observed", task.id, task.state);
const initialDelivery = await waitForDelivery(task.id, (item) => item.kind === "a2a-message");
assertBinding(initialDelivery, backendBinding, "initial delivery");

console.log(`
4. In backend, call acs_task_request_input for task ${task.id}.`);
await waitForTask((item) => item.id === task.id && item.state === "input-required");
mark("input-required", task.id, "input-required");
const beforeReply = new Set((await deliveries(task.id)).map((item) => string(item.id)));

console.log(`
5. In architect, call acs_task_reply for task ${task.id}.`);
const reply = await waitForDelivery(
  task.id,
  (item) => item.kind === "a2a-message" && !beforeReply.has(string(item.id)),
);
assertBinding(reply, backendBinding, "reply delivery");
await waitForTask((item) => item.id === task.id && item.state === "working");
mark("reply-delivered", task.id, "working");

console.log(`
6. In backend, call acs_task_complete with a summary and at least one URI artifact.`);
const completed = await waitForTask((item) => item.id === task.id && item.state === "completed"),
  persisted = persistedTask(task.id);
if (persisted.requesterAgentId !== string(architect.id))
  throw new Error("REAL_CODEX_E2E_INVALID: task requester does not match this run");
if (array(record(persisted.snapshot).artifacts).length === 0)
  throw new Error("REAL_CODEX_E2E_INVALID: completed task has no persisted artifact");
mark("completed-with-artifact", task.id, completed.state);

console.log(`
7. ASC will restart automatically; this verifier will query the exact task afterwards.`);
await call("system.shutdown");
await waitForUnavailable();
const daemon = Bun.spawn([process.execPath, "apps/acs/src/main.ts", "daemon", "start"], {
  cwd: join(import.meta.dir, ".."),
  env: process.env,
  stdout: "ignore",
  stderr: "ignore",
});
const restarted = await waitFor(async () => {
  try {
    return record(
      await call("system.initialize", {
        protocolVersion: "1.0",
        client: {
          name: "acs-real-codex-e2e-restart",
          version: "0.1.0",
          instanceId: String(process.pid),
        },
        capabilities: {},
      }),
    );
  } catch {
    if (daemon.exitCode !== null)
      throw new Error("REAL_CODEX_E2E_RESTART_FAILED: replacement daemon exited");
    return undefined;
  }
});
if (string(record(restarted.server).instanceId) === initialInstanceId)
  throw new Error("REAL_CODEX_E2E_INVALID: daemon instance did not change");
const afterRestart = persistedTask(task.id);
if (
  afterRestart.state !== "completed" ||
  array(record(afterRestart.snapshot).artifacts).length === 0
)
  throw new Error("REAL_CODEX_E2E_INVALID: completion or artifacts did not survive restart");
mark("persisted-after-restart", task.id, afterRestart.state);

const directory = join(process.cwd(), "artifacts"),
  output = join(directory, `real-codex-two-agent-${Date.now()}.json`);
mkdirSync(directory, { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      result: "passed",
      runId,
      taskId: task.id,
      bindingEpochs: {
        architect: number(architectBinding.epoch),
        backend: number(backendBinding.epoch),
      },
      timeline,
    },
    null,
    2,
  )}\n`,
);
console.log(`
Verified the correlated real two-agent input/reply/completion and restart cycle.
Sanitized event trace: ${output}`);

async function waitForBinding(agent: string) {
  return waitFor(async () => {
    const items = array(record(await call("bindings.list", { agent, status: ["active"] })).items);
    return items.length === 1 ? record(items[0]) : undefined;
  });
}
async function waitForTask(predicate: (item: TaskView) => boolean) {
  return waitFor(async () =>
    array(
      record(
        await call("inbox.list", {
          agent: backendSlug,
          states: ["submitted", "working", "input-required", "completed"],
          limit: 100,
        }),
      ).items,
    )
      .map((item) => taskView(record(item)))
      .find(predicate),
  );
}
async function deliveries(taskId: string) {
  return array(record(await call("deliveries.list", { taskId, limit: 100 })).items).map((item) =>
    record(item),
  );
}
async function waitForDelivery(
  taskId: string,
  predicate: (item: Record<string, unknown>) => boolean,
) {
  return waitFor(async () => (await deliveries(taskId)).find(predicate));
}
function assertBinding(
  delivery: Record<string, unknown>,
  binding: Record<string, unknown>,
  label: string,
) {
  if (delivery.bindingId !== binding.id || delivery.bindingEpoch !== binding.epoch)
    throw new Error(`REAL_CODEX_E2E_INVALID: ${label} used an unexpected binding fence`);
}
function persistedTask(taskId: string) {
  const database = new Database(config.data, { readonly: true, strict: true });
  try {
    const row = database
      .query<
        { state: string; requester_agent_id: string | null; a2a_snapshot_json: string },
        [string]
      >("SELECT state,requester_agent_id,a2a_snapshot_json FROM a2a_tasks WHERE id=?")
      .get(taskId);
    if (!row) throw new Error("REAL_CODEX_E2E_INVALID: correlated task is not persisted");
    return {
      state: row.state,
      requesterAgentId: row.requester_agent_id,
      snapshot: record(JSON.parse(row.a2a_snapshot_json)),
    };
  } finally {
    database.close();
  }
}
async function waitForUnavailable() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await call("system.health");
    } catch {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("REAL_CODEX_E2E_RESTART_FAILED: original daemon did not stop");
}
async function waitFor<T>(probe: () => Promise<T | false | undefined>, timeoutMs = 1_200_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await Bun.sleep(500);
  }
  throw new Error("REAL_CODEX_E2E_TIMEOUT: expected workflow state was not observed");
}
interface TaskView {
  readonly id: string;
  readonly requesterAgentId?: string;
  readonly targetAgentId: string;
  readonly state: string;
}
function taskView(value: Record<string, unknown>): TaskView {
  return {
    id: string(value.id),
    requesterAgentId:
      typeof value.requesterAgentId === "string" ? value.requesterAgentId : undefined,
    targetAgentId: string(value.targetAgentId),
    state: string(value.state),
  };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return value;
}
function string(value: unknown) {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function number(value: unknown) {
  if (typeof value !== "number") throw new Error("expected number");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
