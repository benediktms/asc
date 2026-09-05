import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntimeEmulator } from "./codex-runtime-emulator";

const roots: string[] = [],
  processes: Bun.Subprocess[] = [],
  servers: ReturnType<typeof Bun.listen>[] = [];

interface McpProcess {
  readonly stdin: { write(data: string): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
}

afterEach(async () => {
  for (const process of processes.splice(0)) {
    process.kill("SIGTERM");
    await process.exited;
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("two Codex agents complete the canonical task workflow across every public boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "acs-two-agent-"));
  roots.push(root);
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() }),
    port = required(reservation.port, "reserved port");
  reservation.stop(true);
  const socket = join(root, "codex.sock"),
    emulator = createCodexRuntimeEmulator(socket, [
      "thread-architect",
      "thread-backend",
      "thread-backend-rebound",
    ]);
  servers.push(emulator.server);
  const env = environment(root, socket, port);
  writeFileSync(join(root, "config.toml"), config(port));
  runCommand(env, "init");
  let daemon = await startDaemon(env),
    correlationId = "not-yet-issued";
  try {
    const architectClaim = createClaim(env, "architect"),
      backendClaim = createClaim(env, "backend");
    const architect = await startMcp(env, "architect-client"),
      backend = await startMcp(env, "backend-client");
    expect(
      data(
        await tool(
          architect,
          "architect-claim",
          "acs_claim",
          {
            claimCode: architectClaim,
            continuityPolicy: "strict",
            allowNonAtomicWake: true,
          },
          "thread-architect",
        ),
      ),
    ).toMatchObject({ agent: { slug: "architect" }, binding: { epoch: 1 } });
    expect(
      data(
        await tool(
          backend,
          "backend-claim",
          "acs_claim",
          {
            claimCode: backendClaim,
            continuityPolicy: "strict",
            allowNonAtomicWake: true,
          },
          "thread-backend",
        ),
      ),
    ).toMatchObject({ agent: { slug: "backend" }, binding: { epoch: 1 } });

    const acceptedResponse = await tool(
        architect,
        "canonical-send",
        "acs_send",
        {
          to: "backend",
          text: "Implement the storage adapter",
          replyExpected: true,
          notifyOn: ["input-required", "completed", "terminal"],
        },
        "thread-architect",
      ),
      accepted = data(acceptedResponse),
      taskId = string(accepted.taskId),
      deliveryId = string(accepted.deliveryId);
    correlationId = string(
      record(acceptedResponse.result).structuredContent
        ? record(record(acceptedResponse.result).structuredContent).correlationId
        : undefined,
    );
    expect(accepted).toMatchObject({ state: "submitted", duplicate: false });

    // A2A durability is observable before the independent scheduler/runtime acceptance.
    expect(record(command(env, "deliveries", "get", deliveryId).delivery)).toMatchObject({
      id: deliveryId,
      taskId,
      bindingEpoch: 1,
    });
    const firstDelivery = await waitForDelivery(emulator.deliveries, taskId, "thread-backend");
    expect(firstDelivery.envelope).toMatchObject({
      schema: "urn:agent-communications:runtime-envelope:v1",
      deliveryId,
      kind: "a2a-message",
      from: { name: "architect" },
      to: { name: "backend" },
      task: { id: taskId, state: "submitted" },
      provenance: { authority: "peer-agent", trustedForPermissions: false },
    });
    expect(record(command(env, "deliveries", "get", deliveryId).delivery).state).toBe("accepted");
    await waitForTask(architect, taskId, "thread-architect", "working");

    // Runtime-local approvals fan out as observation only; ASC never answers them.
    const firstTurnId = required(firstDelivery.turnId, "first receiver turn"),
      approvalId = emulator.requestApproval(firstTurnId);
    await Bun.sleep(100);
    expect(emulator.clientResponses.some((response) => response.id === approvalId)).toBe(false);
    expect(
      data(
        await tool(
          backend,
          "request-input",
          "acs_task_request_input",
          { taskId, question: "Which consistency level?", choices: ["strict", "eventual"] },
          "thread-backend",
        ),
      ),
    ).toMatchObject({ taskId, state: "input-required" });
    emulator.finishTurn(firstTurnId, "completed", "Waiting for the architect");
    await waitForTask(architect, taskId, "thread-architect", "input-required");

    expect(
      data(
        await tool(
          architect,
          "task-reply",
          "acs_task_reply",
          { taskId, text: "Use strict consistency" },
          "thread-architect",
        ),
      ),
    ).toMatchObject({ taskId, state: "input-required" });
    const replyDelivery = await waitForDelivery(
      emulator.deliveries,
      taskId,
      "thread-backend",
      firstTurnId,
    );
    await waitForTask(architect, taskId, "thread-architect", "working");
    expect(
      data(
        await tool(
          backend,
          "task-complete",
          "acs_task_complete",
          {
            taskId,
            summary: "Storage adapter implemented",
            artifacts: [
              {
                kind: "uri",
                uri: "file:///workspace/storage-adapter.patch",
                name: "storage-adapter.patch",
                mediaType: "text/x-diff",
              },
            ],
          },
          "thread-backend",
        ),
      ),
    ).toMatchObject({ taskId, state: "completed" });
    emulator.finishTurn(required(replyDelivery.turnId, "reply turn"));
    const completed = await waitForTask(architect, taskId, "thread-architect", "completed");
    expect(array(completed.artifacts)).toEqual([
      expect.objectContaining({ name: "storage-adapter.patch" }),
    ]);

    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
    processes.splice(processes.indexOf(daemon), 1);
    daemon = await startDaemon(env);
    expect(
      data(await tool(architect, "after-restart", "acs_task_get", { taskId }, "thread-architect")),
    ).toMatchObject({ task: { id: taskId, status: { state: "TASK_STATE_COMPLETED" } } });

    await exerciseIdempotencyCancellationAndBusyRecovery(env, architect, backend, emulator);
    await exerciseOfflineRecovery(architect, backend, emulator);
    await exerciseBindingFence(env, architect, backend, emulator);
    await exerciseAcceptanceReconciliation(architect, backend, emulator);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\ncorrelationId=${correlationId}\n` +
        `sanitizedTimeline=${JSON.stringify(emulator.timeline())}`,
      { cause: error },
    );
  }
}, 45_000);

async function exerciseIdempotencyCancellationAndBusyRecovery(
  env: Record<string, string | undefined>,
  architect: McpProcess,
  _backend: McpProcess,
  emulator: ReturnType<typeof createCodexRuntimeEmulator>,
) {
  const first = data(
      await tool(
        architect,
        "idempotent-send",
        "acs_send",
        { to: "backend", text: "Long-running work" },
        "thread-architect",
      ),
    ),
    taskId = string(first.taskId),
    duplicate = data(
      await tool(
        architect,
        "idempotent-send",
        "acs_send",
        { to: "backend", text: "Long-running work" },
        "thread-architect",
      ),
    );
  expect(duplicate).toMatchObject({ taskId, deliveryId: first.deliveryId, duplicate: true });
  const conflict = await tool(
    architect,
    "idempotent-send",
    "acs_send",
    { to: "backend", text: "Changed retry payload" },
    "thread-architect",
  );
  expect(record(conflict.result).isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain("IDEMPOTENCY_CONFLICT");
  const active = await waitForDelivery(emulator.deliveries, taskId, "thread-backend");

  const queued = data(
      await tool(
        architect,
        "busy-send",
        "acs_send",
        { to: "backend", text: "Queue while busy" },
        "thread-architect",
      ),
    ),
    queuedTaskId = string(queued.taskId);
  await Bun.sleep(350);
  expect(emulator.deliveries.some((item) => record(item.envelope.task).id === queuedTaskId)).toBe(
    false,
  );
  expect(
    data(
      await tool(
        architect,
        "cancel-owned",
        "acs_task_cancel",
        { taskId, reason: "No longer needed" },
        "thread-architect",
      ),
    ),
  ).toMatchObject({ taskId, cancellationRequested: true });
  await waitFor(() =>
    emulator
      .timeline()
      .some((event) => event.event === "turn/interrupt" && event.turnId === active.turnId),
  );
  expect(command(env, "deliveries", "list").items).toBeDefined();
  const afterBusy = await waitForDelivery(emulator.deliveries, queuedTaskId, "thread-backend");
  await tool(
    architect,
    "cancel-queued-after-delivery",
    "acs_task_cancel",
    { taskId: queuedTaskId },
    "thread-architect",
  );
  await waitFor(() =>
    emulator
      .timeline()
      .some((event) => event.event === "turn/interrupt" && event.turnId === afterBusy.turnId),
  );
}

async function exerciseOfflineRecovery(
  architect: McpProcess,
  _backend: McpProcess,
  emulator: ReturnType<typeof createCodexRuntimeEmulator>,
) {
  emulator.state("thread-backend", "offline");
  const canceledBeforeDelivery = data(
      await tool(
        architect,
        "offline-cancel-send",
        "acs_send",
        { to: "backend", text: "Cancel before reconnect" },
        "thread-architect",
      ),
    ),
    canceledTaskId = string(canceledBeforeDelivery.taskId);
  await tool(
    architect,
    "offline-cancel-before-delivery",
    "acs_task_cancel",
    { taskId: canceledTaskId },
    "thread-architect",
  );
  emulator.state("thread-backend", "idle");
  await Bun.sleep(350);
  expect(emulator.deliveries.some((item) => record(item.envelope.task).id === canceledTaskId)).toBe(
    false,
  );

  emulator.state("thread-backend", "offline");
  const accepted = data(
      await tool(
        architect,
        "offline-send",
        "acs_send",
        { to: "backend", text: "Deliver after reconnect" },
        "thread-architect",
      ),
    ),
    taskId = string(accepted.taskId);
  await Bun.sleep(350);
  expect(emulator.deliveries.some((item) => record(item.envelope.task).id === taskId)).toBe(false);
  emulator.state("thread-backend", "idle");
  const recovered = await waitForDelivery(emulator.deliveries, taskId, "thread-backend");
  await tool(architect, "offline-cancel", "acs_task_cancel", { taskId }, "thread-architect");
  await waitFor(() =>
    emulator
      .timeline()
      .some((event) => event.event === "turn/interrupt" && event.turnId === recovered.turnId),
  );
}

async function exerciseBindingFence(
  env: Record<string, string | undefined>,
  architect: McpProcess,
  _backend: McpProcess,
  emulator: ReturnType<typeof createCodexRuntimeEmulator>,
) {
  emulator.state("thread-backend", "offline");
  const accepted = data(
      await tool(
        architect,
        "fenced-send",
        "acs_send",
        { to: "backend", text: "Must remain on the accepted strict epoch" },
        "thread-architect",
      ),
    ),
    taskId = string(accepted.taskId),
    deliveryId = string(accepted.deliveryId);
  await Bun.sleep(350);
  command(
    env,
    "bindings",
    "bind",
    "backend",
    "--session",
    "thread-backend-rebound",
    "--continuity",
    "strict",
    "--allow-non-atomic-wake",
    "--revoke-existing",
  );
  emulator.state("thread-backend", "idle");
  await waitFor(
    () =>
      record(command(env, "deliveries", "get", deliveryId).delivery).state === "failed-terminal",
  );
  expect(record(command(env, "deliveries", "get", deliveryId).delivery)).toMatchObject({
    taskId,
    state: "failed-terminal",
    reason: "strict-binding-revoked",
    bindingEpoch: 1,
  });
  expect(
    emulator.deliveries.some(
      (item) =>
        item.threadId === "thread-backend-rebound" && record(item.envelope.task).id === taskId,
    ),
  ).toBe(false);
}

async function exerciseAcceptanceReconciliation(
  architect: McpProcess,
  backend: McpProcess,
  emulator: ReturnType<typeof createCodexRuntimeEmulator>,
) {
  // The backend was rebound above, so future work uses the replacement epoch.
  emulator.dropResponseAfterNextTurnStart();
  const accepted = data(
      await tool(
        architect,
        "ambiguous-send",
        "acs_send",
        { to: "backend", text: "Recover the write marker after disconnect" },
        "thread-architect",
      ),
    ),
    taskId = string(accepted.taskId);
  await waitFor(() =>
    emulator.timeline().some((event) => event.event === "turn/start.response-dropped"),
  );
  await waitForTask(architect, taskId, "thread-architect", "working", 10_000);
  expect(
    data(
      await tool(
        backend,
        "ambiguous-complete",
        "acs_task_complete",
        { taskId, summary: "Recovered exactly once" },
        "thread-backend-rebound",
      ),
    ),
  ).toMatchObject({ taskId, state: "completed" });
  expect(
    emulator.deliveries.filter((item) => record(item.envelope.task).id === taskId),
  ).toHaveLength(1);
}

async function startDaemon(env: Record<string, string | undefined>) {
  const daemon = Bun.spawn([process.execPath, "apps/acs/src/main.ts", "daemon", "start"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  processes.push(daemon);
  await waitFor(() => existsSync(string(env.ACS_CONTROL_SOCKET)));
  return daemon;
}

async function startMcp(
  env: Record<string, string | undefined>,
  name: string,
): Promise<McpProcess> {
  const child = Bun.spawn([process.execPath, "apps/acs/src/main.ts", "mcp", "codex"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name, version: "1" },
      },
    })}\n`,
  );
  await readUntil(child.stdout, '"id":"initialize"');
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return child;
}

async function tool(
  process: McpProcess,
  id: string,
  name: string,
  args: Record<string, unknown>,
  threadId: string,
) {
  process.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args, _meta: { threadId } },
    })}\n`,
  );
  return jsonRpcResponse(await readUntil(process.stdout, `"id":"${id}"`), id);
}

async function waitForTask(
  process: McpProcess,
  taskId: string,
  threadId: string,
  state: string,
  timeoutMs = 5_000,
) {
  let latest: Record<string, unknown> = {};
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    latest = record(
      data(await tool(process, `get-${taskId}-${attempt}`, "acs_task_get", { taskId }, threadId))
        .task,
    );
    if (taskState(latest) === state) return latest;
    await Bun.sleep(50);
  }
  throw new Error(`task ${taskId} remained ${taskState(latest)} instead of ${state}`);
}

async function waitForDelivery(
  deliveries: readonly {
    readonly threadId: string;
    readonly turnId?: string;
    readonly envelope: Record<string, unknown>;
  }[],
  taskId: string,
  threadId: string,
  excludingTurnId?: string,
) {
  let found:
    | {
        readonly threadId: string;
        readonly turnId?: string;
        readonly envelope: Record<string, unknown>;
      }
    | undefined;
  await waitFor(() => {
    found = deliveries.find(
      (item) =>
        item.threadId === threadId &&
        item.turnId !== excludingTurnId &&
        record(item.envelope.task).id === taskId,
    );
    return Boolean(found);
  });
  return required(found, "runtime delivery");
}

function createClaim(env: Record<string, string | undefined>, agent: string) {
  return string(record(command(env, "agents", "create", agent, "--claim").claim).claimCode);
}

function command(env: Record<string, string | undefined>, ...args: string[]) {
  const output = runCommand(env, ...args).trim();
  return output ? record(JSON.parse(output)) : {};
}

function runCommand(env: Record<string, string | undefined>, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "apps/acs/src/main.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function environment(root: string, socket: string, port: number) {
  return {
    ...process.env,
    ACS_HOME: root,
    ACS_CONFIG_PATH: join(root, "config.toml"),
    ACS_A2A_PORT: String(port),
    ACS_CONTROL_SOCKET: join(root, "control.sock"),
    ACS_STORAGE_PATH: join(root, "acs.db"),
    ACS_CODEX_SOCKET: socket,
    ACS_LOG_FORMAT: "json",
  };
}

function config(port: number) {
  return `[daemon]
a2a_listen = "127.0.0.1:${port}"
log_format = "json"

[delivery]
retry_base_ms = 20
retry_cap_ms = 50

[runtimes.codex]
status_poll_interval_ms = 20
auto_resume_dormant_threads = true
`;
}

async function waitFor(done: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition did not become true");
}

async function readUntil(stream: ReadableStream<Uint8Array>, needle: string) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let output = "";
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.value) output += decoder.decode(next.value, { stream: true });
          if (output.includes(needle) || next.done) return output;
        }
      })(),
      Bun.sleep(10_000).then(() => {
        throw new Error(`MCP response timed out: ${output}`);
      }),
    ]);
  } finally {
    reader.releaseLock();
  }
}

function jsonRpcResponse(output: string, id: string) {
  for (const line of output.trim().split("\n")) {
    const value: unknown = JSON.parse(line);
    if (isRecord(value) && value.id === id) return value;
  }
  throw new Error(`missing JSON-RPC response ${id}`);
}

function data(response: Record<string, unknown>) {
  return record(record(record(response.result).structuredContent).data);
}
function taskState(task: Record<string, unknown>) {
  return string(record(task.status).state)
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replaceAll("_", "-");
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown) {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}
