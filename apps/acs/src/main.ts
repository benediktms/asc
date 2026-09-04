#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { handleA2A } from "../../../packages/protocol-a2a/src/index";
import { controlCall, controlHandler } from "../../../packages/protocol-control/src/index";
import { runMcp } from "../../../packages/bridge-mcp-codex/src/index";
import { initFiles, paths, Store } from "../../../packages/storage-sqlite/src/index";
import { CodexRuntimeAdapter } from "../../../packages/runtime-codex/src/index";
import { CodexAppServerClient } from "../../../packages/runtime-codex/src/app-server-client";
import { DeliveryScheduler } from "../../../packages/application/src/scheduler";
import { loadConfig, parseListen, writeDefaultConfig } from "../../../packages/config/src/index";

const args = Bun.argv.slice(2),
  config = paths(),
  settings = loadConfig(),
  listen = parseListen(settings.daemon.a2aListen),
  port = listen.port;

async function main() {
  if (!args.length || args[0] === "--help" || args[0] === "help") return usage();
  if (args[0] === "init") {
    writeDefaultConfig();
    initFiles(config);
    const store = new Store(config);
    store.close();
    console.log(`Initialized ACS at ${config.data}`);
    return;
  }
  if (args[0] === "daemon" && (args[1] === "run" || args[1] === "start")) return daemon();
  if (args[0] === "mcp" && args[1] === "codex") return runMcp(port);
  if (args[0] === "codex" && args[1] === "doctor") return doctor();
  if (args[0] === "codex" && args[1] === "install-mcp") {
    const installed = Bun.spawnSync([
      settings.codex.binary,
      "mcp",
      "add",
      "acs",
      "--",
      process.execPath,
      "mcp",
      "codex",
    ]);
    if (!installed.success)
      throw new Error(installed.stderr.toString().trim() || "Codex MCP installation failed");
    process.stdout.write(installed.stdout);
    return;
  }
  const call = (method: string, params: unknown = {}) =>
    controlCall(config.runtime, config.token, method, params);
  await call("system.initialize", {
    protocolVersion: "1.0",
    client: { name: "acs-cli", version: "0.1.0", instanceId: String(process.pid) },
    capabilities: {},
  });
  if (args[0] === "agents" && args[1] === "create") {
    const agent = required(args[2], "agent slug"),
      created = await call("agents.create", {
        slug: agent,
        displayName: option("--name"),
        description: option("--description"),
      });
    return print(
      args.includes("--claim")
        ? { created, claim: await call("agents.createClaim", { agent }) }
        : created,
    );
  }
  if (args[0] === "agents" && args[1] === "get")
    return print(await call("agents.get", { agent: required(args[2], "agent") }));
  if (args[0] === "agents" && args[1] === "update")
    return print(
      await call("agents.update", {
        agent: required(args[2], "agent"),
        displayName: option("--name"),
        description: option("--description"),
        enabled: args.includes("--enable") ? true : args.includes("--disable") ? false : undefined,
      }),
    );
  if (args[0] === "agents" && args[1] === "delete")
    return print(await call("agents.delete", { agent: required(args[2], "agent") }));
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
  if (args[0] === "bindings" && args[1] === "get")
    return print(await call("bindings.get", { bindingId: required(args[2], "binding ID") }));
  if (args[0] === "bindings" && args[1] === "revoke")
    return print(
      await call("bindings.revoke", {
        bindingId: required(args[2], "binding ID"),
        reason: option("--reason"),
      }),
    );
  if (args[0] === "runtimes" && args[1] === "list") return print(await call("runtimes.list"));
  if (args[0] === "codex" && args[1] === "sessions" && args[2] === "list")
    return print(await call("runtimes.sessions.list"));
  if (args[0] === "deliveries" && args[1] === "list") return print(await call("deliveries.list"));
  if (args[0] === "deliveries" && args[1] === "get")
    return print(await call("deliveries.get", { deliveryId: required(args[2], "delivery ID") }));
  if (args[0] === "deliveries" && args[1] === "retry")
    return print(await call("deliveries.retry", { deliveryId: required(args[2], "delivery ID") }));
  if (args[0] === "deliveries" && args[1] === "cancel")
    return print(
      await call("deliveries.cancel", {
        deliveryId: required(args[2], "delivery ID"),
        reason: option("--reason"),
      }),
    );
  if (args[0] === "deliveries" && args[1] === "resolve")
    return print(
      await call("deliveries.resolveUnknown", {
        deliveryId: required(args[2], "delivery ID"),
        resolution: required(option("--as"), "--as"),
      }),
    );
  if (args[0] === "token" && args[1] === "show") {
    console.log(readFileSync(config.token, "utf8"));
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}`);
}

async function daemon() {
  const store = new Store(config, {
      maxInlineContentBytes: settings.security.maxInlineContentBytes,
      claimTtlSeconds: settings.security.claimTtlSeconds,
      defaultMode: settings.delivery.defaultMode,
      busyTimeoutMs: settings.storage.busyTimeoutMs,
      durability: settings.storage.durability,
    }),
    startedAt = new Date().toISOString();
  if (existsSync(config.runtime)) unlinkSync(config.runtime);
  const a2a = Bun.serve({
    hostname: listen.hostname,
    port,
    fetch: (request) => handleA2A(store, request, port, settings.security.maxRequestBytes),
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
  const adapter = settings.codex.enabled ? new CodexRuntimeAdapter(codexSocket) : undefined;
  const scheduler = adapter
    ? new DeliveryScheduler(store, adapter, String(process.pid), {
        concurrency: settings.delivery.workerConcurrency,
        leaseMs: settings.delivery.leaseSeconds * 1000,
        retryBaseMs: settings.delivery.retryBaseMs,
        retryCapMs: settings.delivery.retryCapMs,
        reconnectMs: settings.codex.statusPollIntervalMs,
      })
    : undefined;
  await scheduler?.start();
  const stop = () => {
    a2a.stop(false);
    control.stop(false);
    void Promise.resolve(scheduler?.stop()).then(() => {
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
async function doctor() {
  const codex = Bun.spawnSync([settings.codex.binary, "--version"]);
  const socket =
      process.env.ACS_CODEX_SOCKET ??
      `${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/app-server-control/app-server-control.sock`,
    client = new CodexAppServerClient(socket);
  let sharedAppServer: string;
  try {
    await client.start();
    const threads = await client.listThreads({ limit: 1, useStateDbOnly: true });
    sharedAppServer = `ready (${threads.data.length} thread sampled)`;
  } catch (error) {
    sharedAppServer = `unavailable (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    client.close();
  }
  print({
    codex: codex.success ? codex.stdout.toString().trim() : "unavailable",
    phaseZero: {
      a2aOnBun: "locally testable",
      standaloneExecutable: "locally testable",
      mcpAttestation: "requires real two-build evidence",
      sharedAppServer,
      safeDelivery: "context injection proven; wake remains explicit non-atomic opt-in",
      approvalOwnership: "unproven",
    },
    mutatingDeliveryEnabled: sharedAppServer.startsWith("ready"),
  });
}
function usage() {
  console.log(
    `ACS 0.1.0\n\n  acs init\n  acs daemon start\n  acs agents create <slug> [--claim] [--name name] [--description text]\n  acs agents get|update|delete <agent>\n  acs agents list\n  acs codex sessions list\n  acs bindings bind <agent> --session <codex-thread-id> [--allow-non-atomic-wake]\n  acs bindings get|revoke <binding-id>\n  acs bindings list\n  acs runtimes list\n  acs deliveries list|get|retry|cancel <delivery-id>\n  acs deliveries resolve <delivery-id> --as <resolution>\n  acs token show\n  acs codex doctor\n  acs codex install-mcp\n  acs mcp codex`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
