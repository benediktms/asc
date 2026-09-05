#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../packages/config/src/index";
import { controlCall } from "../packages/protocol-control/src/index";

const config = paths(),
  call = (method: string, params: unknown = {}) =>
    controlCall(config.runtime, config.token, method, params),
  timeline = new Array<{ at: string; event: string; taskId?: string; state?: string }>(),
  recordEvent = (event: string, taskId?: string, state?: string) => {
    timeline.push({ at: new Date().toISOString(), event, taskId, state });
  };

await call("system.initialize", {
  protocolVersion: "1.0",
  client: { name: "acs-real-codex-e2e", version: "0.1.0", instanceId: String(process.pid) },
  capabilities: {},
});
await ensureAgent("architect");
await ensureAgent("backend");
const architectClaim = record(await call("agents.createClaim", { agent: "architect" })),
  backendClaim = record(await call("agents.createClaim", { agent: "backend" }));

console.log(`Real-Codex two-agent verifier started.

1. In the architect Codex thread, call acs_claim with:
   ${string(architectClaim.claimCode)}
2. In the backend Codex thread, call acs_claim with:
   ${string(backendClaim.claimCode)}

The verifier only observes ASC state. It does not synthesize MCP metadata or model evidence.`);
await waitFor(async () => (await activeBinding("architect")) && (await activeBinding("backend")));
recordEvent("agents-bound");
console.log(`
3. In architect, call acs_send to backend with a task that asks backend to request a choice.
   Use notifyOn: ["input-required", "completed", "terminal"].`);
const task = await waitForTask(
  (candidate) => candidate.state === "submitted" || candidate.state === "working",
);
recordEvent("task-observed", task.id, task.state);
console.log(`
4. Task ${task.id} reached backend. In backend, call acs_task_request_input for this task.`);
await waitForTask((candidate) => candidate.id === task.id && candidate.state === "input-required");
recordEvent("input-required", task.id, "input-required");
console.log(`
5. In architect, call acs_task_reply for ${task.id}.
6. In backend, call acs_task_complete with a summary and at least one URI artifact.`);
const completed = await waitForTask(
  (candidate) => candidate.id === task.id && candidate.state === "completed",
);
recordEvent("completed", completed.id, completed.state);
const persisted = await waitForTask(
  (candidate) => candidate.id === task.id && candidate.state === "completed",
);
recordEvent("persisted-query", completed.id, persisted.state);

const outputDirectory = join(process.cwd(), "artifacts");
mkdirSync(outputDirectory, { recursive: true });
const output = join(outputDirectory, `real-codex-two-agent-${Date.now()}.json`);
writeFileSync(
  output,
  `${JSON.stringify({ schemaVersion: 1, result: "passed", taskId: task.id, timeline }, null, 2)}\n`,
);
console.log(`
Verified the real two-agent task/input/reply/completion cycle.
Sanitized event trace: ${output}`);

async function ensureAgent(slug: string) {
  try {
    await call("agents.get", { agent: slug });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("AGENT_NOT_FOUND")) throw error;
    await call("agents.create", { slug });
  }
}

async function activeBinding(agent: string) {
  const result = record(await call("bindings.list", { agent, status: ["active"] }));
  return array(result.items).length > 0;
}

async function waitForTask(predicate: (candidate: TaskView) => boolean) {
  return waitFor(async () => {
    const result = record(
      await call("inbox.list", {
        agent: "backend",
        states: ["submitted", "working", "input-required", "completed"],
        limit: 100,
      }),
    );
    return array(result.items)
      .map((item) => taskView(record(item)))
      .find(predicate);
  });
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
  readonly state: string;
}
function taskView(value: Record<string, unknown>): TaskView {
  return { id: string(value.id), state: string(value.state) };
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
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
