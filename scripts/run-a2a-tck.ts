import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/storage-sqlite/src/index";

const tck = process.env.A2A_TCK_DIR;
if (!tck || !existsSync(join(tck, "run_tck.py")))
  throw new Error("Set A2A_TCK_DIR to an a2a-tck checkout");
const expectedRevision = readFileSync(
    new URL("../conformance/a2a-tck-revision.txt", import.meta.url),
    "utf8",
  ).trim(),
  actualRevision = run(["git", "rev-parse", "HEAD"], tck).stdout.trim();
if (actualRevision !== expectedRevision)
  throw new Error(`A2A TCK revision mismatch: expected ${expectedRevision}, got ${actualRevision}`);

const root = mkdtempSync(join(tmpdir(), "acs-tck-")),
  binary = join(root, "acs"),
  codexSocket = join(root, "codex.sock"),
  servicePort = reservePort(),
  proxyPort = reservePort(),
  env = {
    ...process.env,
    ACS_HOME: root,
    ACS_A2A_PORT: String(servicePort),
    ACS_CONTROL_SOCKET: join(root, "control.sock"),
    ACS_STORAGE_PATH: join(root, "acs.db"),
    ACS_CODEX_SOCKET: codexSocket,
  };
let daemon: Bun.Subprocess | undefined,
  proxy: ReturnType<typeof Bun.serve> | undefined,
  emulator: ReturnType<typeof startCodexEmulator> | undefined;
try {
  run([process.execPath, "build", "apps/acs/src/main.ts", "--compile", "--outfile", binary]);
  run([binary, "init"], undefined, env);
  const tokenStore = new Store({
      data: env.ACS_STORAGE_PATH,
      runtime: env.ACS_CONTROL_SOCKET,
      token: join(root, "control.token"),
      bridgeToken: join(root, "bridge.token"),
      secret: join(root, "secret.key"),
    }),
    token = tokenStore.createToken().token;
  tokenStore.close();
  emulator = startCodexEmulator(codexSocket);
  daemon = Bun.spawn([binary, "daemon", "start"], { env, stdout: "ignore", stderr: "pipe" });
  await waitFor(() => existsSync(env.ACS_CONTROL_SOCKET));
  run([binary, "agents", "create", "tck-agent"], undefined, env);
  await runAsync(
    [binary, "bindings", "bind", "tck-agent", "--session", "thread-1", "--allow-non-atomic-wake"],
    undefined,
    env,
  );
  const upstream = `http://127.0.0.1:${servicePort}/agents/tck-agent`;
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: proxyPort,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        const response = await fetch(`${upstream}/.well-known/agent-card.json`),
          card = record(await response.json()),
          interfaces = card.supportedInterfaces;
        if (!Array.isArray(interfaces)) throw new Error("Agent Card has no interfaces");
        card.supportedInterfaces = interfaces.map((item) => {
          const projected = record(item);
          projected.url = `http://127.0.0.1:${proxyPort}`;
          return projected;
        });
        return Response.json(card);
      }
      if (request.method !== "POST" || url.pathname !== "/")
        return new Response("Not found", { status: 404 });
      return fetch(`${upstream}/a2a`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": request.headers.get("content-type") ?? "application/json",
          "A2A-Version": request.headers.get("A2A-Version") ?? "1.0",
        },
        body: await request.text(),
      });
    },
  });
  const tckProcess = Bun.spawn(
    [
      join(tck, ".venv/bin/python"),
      join(tck, "run_tck.py"),
      "--sut-host",
      `http://127.0.0.1:${proxyPort}`,
      "--transport",
      "jsonrpc",
      "--level",
      "must",
    ],
    { cwd: tck, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await tckProcess.exited;
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`A2A TCK exited with status ${exitCode}`);
  verifyExpectedFailures(tck, `http://127.0.0.1:${proxyPort}`);
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  await proxy?.stop(true);
  emulator?.stop();
  rmSync(root, { recursive: true });
}

function run(command: string[], cwd?: string, environment?: Record<string, string | undefined>) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `${command.join(" ")} failed`);
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
async function runAsync(
  command: string[],
  cwd?: string,
  environment?: Record<string, string | undefined>,
) {
  const process = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" }),
    exitCode = await process.exited;
  if (exitCode !== 0)
    throw new Error(
      (await new Response(process.stderr).text()).trim() || `${command.join(" ")} failed`,
    );
  return { stdout: await new Response(process.stdout).text() };
}
function reservePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() }),
    port = server.port;
  server.stop(true);
  if (!port) throw new Error("Could not reserve a port");
  return port;
}
async function waitFor(done: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (done()) return;
    await Bun.sleep(25);
  }
  throw new Error("ACS did not start");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

function verifyExpectedFailures(tckPath: string, sutUrl: string) {
  const report = record(
      JSON.parse(readFileSync(join(tckPath, "reports/compatibility.json"), "utf8")),
    ),
    summary = record(report.summary),
    requirements = record(report.per_requirement);
  if (summary.sut_url !== sutUrl) throw new Error("A2A TCK report is stale");
  const actual = Object.entries(requirements)
      .filter(([, result]) => record(result).status === "FAIL")
      .map(([requirement]) => requirement)
      .toSorted(),
    allowlistValue: unknown = JSON.parse(
      readFileSync(
        new URL("../conformance/a2a-tck-expected-failures.json", import.meta.url),
        "utf8",
      ),
    );
  if (!Array.isArray(allowlistValue)) throw new Error("Invalid A2A TCK expected-failure list");
  const expected = allowlistValue
    .map((item) => {
      const entry = record(item);
      if (typeof entry.requirement !== "string" || typeof entry.rationale !== "string")
        throw new Error("Invalid A2A TCK expected-failure entry");
      return entry.requirement;
    })
    .toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `A2A TCK failures changed\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`,
    );
  console.log(`A2A TCK passed with ${actual.length} reviewed expected-failure groups`);
}

function startCodexEmulator(path: string) {
  const buffers = new WeakMap<object, Buffer>();
  let turn = 0;
  return Bun.listen({
    unix: path,
    socket: {
      open() {},
      data(socket, data) {
        const bytes = Buffer.from(data),
          text = bytes.toString();
        if (text.startsWith("GET ")) {
          const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.[1];
          if (!key) throw new Error("Missing WebSocket key");
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
          const decoded = decodeClientFrame(pending);
          if (!decoded) break;
          pending = pending.subarray(decoded.consumed);
          const request = record(JSON.parse(decoded.text)),
            method = typeof request.method === "string" ? request.method : "",
            id = request.id;
          if (typeof id !== "number") continue;
          const turnId = method === "turn/start" ? `turn-${++turn}` : undefined;
          socket.write(serverFrame(JSON.stringify({ id, result: codexResponse(method, turnId) })));
          if (turnId)
            setTimeout(() => {
              socket.write(
                serverFrame(
                  JSON.stringify({
                    method: "item/completed",
                    params: {
                      turnId,
                      item: { type: "agentMessage", text: "TCK task completed" },
                    },
                  }),
                ),
              );
              socket.write(
                serverFrame(
                  JSON.stringify({
                    method: "turn/completed",
                    params: { turn: { id: turnId, status: "completed" } },
                  }),
                ),
              );
            }, 5);
        }
        buffers.set(socket, pending);
      },
      close() {},
      error() {},
    },
  });
}

function codexResponse(method: string, turnId?: string) {
  if (method === "initialize") return { userAgent: "acs-tck-emulator" };
  if (method === "thread/read")
    return {
      thread: {
        id: "thread-1",
        preview: "TCK agent",
        name: "TCK agent",
        updatedAt: 1,
        cwd: "/tmp",
        cliVersion: "tck",
        source: "test",
        status: { type: "idle" },
      },
    };
  if (method === "turn/start") return { turn: { id: turnId } };
  return {};
}

function decodeClientFrame(frame: Buffer) {
  if (frame.length < 6) return undefined;
  const lengthCode = byte(frame, 1) & 0x7f,
    offset = lengthCode === 126 ? 4 : 2,
    length = lengthCode === 126 ? frame.readUInt16BE(2) : lengthCode,
    payload = frame.subarray(offset + 4, offset + 4 + length);
  if (payload.length < length) return undefined;
  const mask = frame.subarray(offset, offset + 4);
  return {
    text: Buffer.from(payload.map((value, index) => value ^ byte(mask, index % 4))).toString(),
    consumed: offset + 4 + length,
  };
}

function serverFrame(text: string) {
  const body = Buffer.from(text);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("Invalid WebSocket frame");
  return value;
}
