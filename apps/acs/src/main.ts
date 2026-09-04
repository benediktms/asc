#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { handleA2A } from "../../../packages/protocol-a2a/src/index";
import { controlCall, controlHandler } from "../../../packages/protocol-control/src/index";
import { runMcp } from "../../../packages/bridge-mcp-codex/src/index";
import { initFiles, paths, Store } from "../../../packages/storage-sqlite/src/index";
import { CodexRuntimeAdapter } from "../../../packages/runtime-codex/src/index";
import { DeliveryScheduler } from "../../../packages/application/src/scheduler";

const args = Bun.argv.slice(2),
  config = paths(),
  port = Number(process.env.ACS_A2A_PORT ?? 7432);

async function main() {
  if (!args.length || args[0] === "--help" || args[0] === "help") return usage();
  if (args[0] === "init") {
    initFiles(config);
    const store = new Store(config);
    store.close();
    console.log(`Initialized ACS at ${config.data}`);
    return;
  }
  if (args[0] === "daemon" && args[1] === "run") return daemon();
  if (args[0] === "mcp" && args[1] === "codex") return runMcp(port);
  if (args[0] === "codex" && args[1] === "doctor") return doctor();
  if (args[0] === "codex" && args[1] === "install-mcp") {
    console.log(`codex mcp add acs -- ${process.execPath} mcp codex`);
    return;
  }
  const call = (method: string, params: unknown = {}) =>
    controlCall(config.runtime, config.token, method, params);
  if (args[0] === "agents" && args[1] === "create")
    return print(
      await call("agents.create", {
        slug: required(args[2], "agent slug"),
        displayName: option("--name"),
        description: option("--description"),
      }),
    );
  if (args[0] === "agents" && args[1] === "list") return print(await call("agents.list"));
  if (args[0] === "bindings" && args[1] === "bind")
    return print(
      await call("bindings.bind", {
        agent: required(args[2], "agent"),
        session: { installationId: "local", opaqueId: required(option("--session"), "--session") },
        allowNonAtomicWake: args.includes("--allow-non-atomic-wake"),
      }),
    );
  if (args[0] === "bindings" && args[1] === "list") return print(await call("bindings.list"));
  if (args[0] === "deliveries" && args[1] === "list") return print(await call("deliveries.list"));
  if (args[0] === "token" && args[1] === "show") {
    console.log(readFileSync(config.token, "utf8"));
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}`);
}

async function daemon() {
  const store = new Store(config),
    startedAt = new Date().toISOString();
  if (existsSync(config.runtime)) unlinkSync(config.runtime);
  const a2a = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => handleA2A(store, request, port),
    error: sanitizedError,
  });
  let control: ReturnType<typeof Bun.serve>;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const codexSocket =
    process.env.ACS_CODEX_SOCKET ??
    `${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/app-server-control/app-server-control.sock`;
  const adapter = new CodexRuntimeAdapter(codexSocket);
  const scheduler = new DeliveryScheduler(store, adapter, String(process.pid));
  await scheduler.start();
  const stop = () => {
    a2a.stop(false);
    control.stop(false);
    void scheduler.stop().then(() => {
      store.close();
      if (existsSync(config.runtime)) unlinkSync(config.runtime);
      finish();
    });
  };
  control = Bun.serve({
    unix: config.runtime,
    fetch: controlHandler(store, startedAt, stop, adapter),
    error: sanitizedError,
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.error(
    JSON.stringify({
      level: "info",
      event: "daemon.started",
      a2a: a2a.url.toString(),
      control: config.runtime,
    }),
  );
  await stopped;
}

function sanitizedError(error: Error) {
  console.error(JSON.stringify({ level: "error", code: error.message.split(":")[0] }));
  return Response.json({ error: "internal" }, { status: 500 });
}
function option(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
function doctor() {
  const codex = Bun.spawnSync([process.env.ACS_CODEX_BINARY ?? "codex", "--version"]);
  print({
    codex: codex.success ? codex.stdout.toString().trim() : "unavailable",
    phaseZero: {
      a2aOnBun: "locally testable",
      standaloneExecutable: "locally testable",
      mcpAttestation: "requires real two-build evidence",
      sharedAppServer: "unproven",
      safeDelivery: "unproven",
      approvalOwnership: "unproven",
    },
    mutatingDeliveryEnabled: false,
  });
}
function usage() {
  console.log(
    `ACS 0.1.0\n\n  acs init\n  acs daemon run\n  acs agents create <slug> [--name name] [--description text]\n  acs agents list\n  acs bindings bind <agent> --session <codex-thread-id> [--allow-non-atomic-wake]\n  acs bindings list\n  acs deliveries list\n  acs token show\n  acs codex doctor\n  acs codex install-mcp\n  acs mcp codex`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
