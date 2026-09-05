import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [],
  processes: Bun.Subprocess[] = [],
  servers: ReturnType<typeof Bun.listen>[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    process.kill("SIGTERM");
    await process.exited;
  }
  for (const server of servers.splice(0)) server.stop(true);
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
  const codexSocket = join(root, "codex.sock"),
    codexServer = fakeCodex(codexSocket),
    bin = join(root, "bin"),
    codex = join(bin, "codex");
  servers.push(codexServer);
  mkdirSync(bin);
  writeFileSync(codex, "#!/bin/sh\nprintf 'codex-cli 0.153.2\\n'\n");
  chmodSync(codex, 0o700);
  const env = {
    ...process.env,
    ACS_HOME: root,
    ACS_A2A_PORT: String(port),
    ACS_CONTROL_SOCKET: join(root, "control.sock"),
    ACS_STORAGE_PATH: join(root, "acs.db"),
    ACS_CODEX_SOCKET: codexSocket,
    ACS_CODEX_BINARY: codex,
    PATH: `${bin}:/usr/bin:/bin`,
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

  const doctor = Bun.spawn([binary, "codex", "doctor"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    }),
    diagnosis = record(JSON.parse(await new Response(doctor.stdout).text()));
  expect(await doctor.exited).toBe(0);
  expect(record(diagnosis.phaseZero).sharedAppServer).toBe("ready (0 thread sampled)");
  expect(diagnosis.codex).toMatchObject({
    installed: "codex-cli 0.153.2",
    runningVersion: "0.153.2",
    compatibility: "tested",
  });

  daemon.kill("SIGTERM");
  expect(await daemon.exited).toBe(0);
  processes.splice(processes.indexOf(daemon), 1);
}, 30_000);

function fakeCodex(path: string) {
  const buffers = new WeakMap<object, Buffer>();
  return Bun.listen({
    unix: path,
    socket: {
      open() {},
      data(socket, data) {
        const bytes = Buffer.from(data),
          text = bytes.toString();
        if (text.startsWith("GET ")) {
          const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.at(1);
          if (!key) throw new Error("missing WebSocket key");
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          return;
        }
        let pending = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), bytes]);
        for (;;) {
          const frame = clientFrame(pending);
          if (!frame) break;
          pending = pending.subarray(frame.consumed);
          if (!frame.text) continue;
          const request = record(JSON.parse(frame.text));
          if (typeof request.id !== "number") continue;
          socket.write(
            serverFrame(
              JSON.stringify({
                id: request.id,
                result:
                  request.method === "initialize"
                    ? { userAgent: "codex-cli 0.153.2" }
                    : { data: [], nextCursor: null },
              }),
            ),
          );
        }
        buffers.set(socket, pending);
      },
      close() {},
      error() {},
    },
  });
}

function clientFrame(frame: Buffer) {
  if (frame.length < 6) return undefined;
  const lengthCode = byte(frame, 1) & 0x7f,
    offset = lengthCode === 126 ? 4 : 2,
    length = lengthCode === 126 ? frame.readUInt16BE(2) : lengthCode,
    mask = frame.subarray(offset, offset + 4),
    payload = frame.subarray(offset + 4, offset + 4 + length);
  if (payload.length < length) return undefined;
  return {
    text: Buffer.from(payload.map((value, index) => value ^ byte(mask, index % 4))).toString(),
    consumed: offset + 4 + length,
  };
}

function serverFrame(text: string) {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("invalid WebSocket frame");
  return value;
}

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
