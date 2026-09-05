import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [],
  processes: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    process.kill("SIGTERM");
    await process.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("compiled binary runs a clean-machine two-agent service workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "acs-package-"));
  roots.push(root);
  const binary = join(root, "acs"),
    built = Bun.spawnSync([
      process.execPath,
      "build",
      "apps/acs/src/main.ts",
      "--compile",
      "--outfile",
      binary,
    ]);
  expect(built.exitCode).toBe(0);

  const reservation = Bun.serve({ port: 0, fetch: () => new Response() }),
    port = required(reservation.port, "reserved port");
  reservation.stop(true);
  const env = {
    ...process.env,
    ACS_HOME: root,
    ACS_A2A_PORT: String(port),
    ACS_CONTROL_SOCKET: join(root, "control.sock"),
    ACS_STORAGE_PATH: join(root, "acs.db"),
    ACS_CODEX_SOCKET: join(root, "missing-codex.sock"),
    PATH: "/usr/bin:/bin",
  };
  expect(Bun.spawnSync([binary, "init"], { env }).exitCode).toBe(0);

  const daemon = Bun.spawn([binary, "daemon", "start"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(daemon);
  const startedLog = record(JSON.parse((await readUntil(daemon.stderr, "\n")).trim()));
  expect(startedLog.severity).toBe("info");
  expect(startedLog.event).toBe("daemon.started");
  expect(string(startedLog.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.stringify(startedLog)).not.toContain(root);
  const socket = join(root, "control.sock");
  await waitFor(() => existsSync(socket));
  expect(statSync(socket).mode & 0o777).toBe(0o600);
  for (const file of ["control.token", "bridge.token", "secret.key"])
    expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);

  for (const agent of ["sender", "receiver"])
    expect(Bun.spawnSync([binary, "agents", "create", agent], { env }).exitCode).toBe(0);
  const listed = record(
    JSON.parse(Bun.spawnSync([binary, "agents", "list"], { env }).stdout.toString()),
  );
  expect(array(listed.items).map((item) => string(record(item).slug))).toEqual([
    "receiver",
    "sender",
  ]);
  const cardResponse = await fetch(
    `http://127.0.0.1:${port}/agents/receiver/.well-known/agent-card.json`,
  );
  expect(cardResponse.status).toBe(200);
  const card = record(await cardResponse.json());
  expect(card.name).toBe("receiver");

  const token = Bun.spawnSync([binary, "token", "show"], { env }).stdout.toString().trim();
  const sent = await rpc(port, "receiver", token, "SendMessage", {
    message: {
      messageId: "smoke-message",
      role: "ROLE_USER",
      parts: [{ text: "hello" }],
    },
  });
  const task = record(record(sent.result).task ?? sent.result),
    taskId = string(task.id);
  expect(taskId.startsWith("tsk_")).toBe(true);
  expect((await rpc(port, "receiver", token, "GetTask", { id: taskId })).error).toBeUndefined();
  expect((await rpc(port, "receiver", token, "CancelTask", { id: taskId })).error).toBeUndefined();

  const mcp = Bun.spawn([binary, "mcp", "codex"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(mcp);
  mcp.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-smoke", version: "1" },
      },
    })}\n`,
  );
  const initialized = await readUntil(mcp.stdout, '"id":1');
  expect(initialized).toContain('"serverInfo"');
}, 30_000);

async function rpc(port: number, agent: string, token: string, method: string, params: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/agents/${agent}/a2a`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  expect(response.status).toBe(200);
  return record(await response.json());
}

async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await Bun.sleep(25);
  }
  throw new Error("service did not become ready");
}

async function readUntil(stream: ReadableStream<Uint8Array>, needle: string) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let output = "";
  return await Promise.race([
    (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.value) output += decoder.decode(next.value, { stream: true });
        if (output.includes(needle) || next.done) return output;
      }
    })(),
    Bun.sleep(10_000).then(() => {
      throw new Error(`MCP did not initialize: ${output}`);
    }),
  ]);
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
