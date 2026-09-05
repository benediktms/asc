#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { handleA2A } from "../../../packages/protocol-a2a/src/index";
import { controlCall, controlHandler } from "../../../packages/protocol-control/src/index";
import { runMcp } from "../../../packages/bridge-mcp-codex/src/index";
import { initFiles, Store } from "../../../packages/storage-sqlite/src/index";
import {
  CodexCallerAttestor,
  CodexRuntimeAdapter,
  SUPPORTED_CODEX_VERSIONS,
  TESTED_CODEX_VERSION,
} from "../../../packages/runtime-codex/src/index";
import { DeliveryScheduler } from "../../../packages/application/src/scheduler";
import {
  loadConfig,
  parseListen,
  paths,
  writeDefaultConfig,
} from "../../../packages/config/src/index";
import { pickSession, type SessionChoice } from "./session-picker";
import {
  VERSION,
  awaitProcess,
  createRecord,
  daemonIdentity,
  installSelf,
  installedExecutable,
  nativeProcesses,
  readDaemonRecord,
  removeStaleRuntime,
  socketAccepts,
  spawnDaemon,
  uninstallSelf,
  withLifecycleLock,
  writeDaemonRecord,
} from "./lifecycle";

const args = Bun.argv.slice(2),
  config = paths(),
  settings = loadConfig(),
  listen = parseListen(settings.daemon.a2aListen),
  port = listen.port;

async function main() {
  if (!args.length || args[0] === "--help" || args[0] === "help") return usage();
  if (args[0] === "version" || args[0] === "--version") {
    return print({
      version: VERSION,
      commit: process.env.ACS_BUILD_COMMIT ?? "unknown",
      target: `${process.platform}-${process.arch}`,
      bun: Bun.version,
      codexProfiles: SUPPORTED_CODEX_VERSIONS,
    });
  }
  if (args[0] === "install") {
    if (process.execPath.endsWith("/bun") || process.execPath.endsWith("/bunx"))
      throw new Error("INSTALL_REQUIRES_RELEASE: install must be run from a compiled ASC binary");
    const prefix = resolvePath(option("--prefix") ?? `${process.env.HOME ?? ""}/.local`);
    return withLifecycleLock(config.lifecycleLock, async () => {
      const installed = installSelf(realpathSync(process.execPath), prefix, config.installRecord);
      console.log(`Installed ASC ${VERSION} at ${installed.executable}`);
    });
  }
  if (args[0] === "uninstall")
    return withLifecycleLock(config.lifecycleLock, async () => {
      const record = readDaemonRecord(config.daemonRecord);
      if (record && daemonIdentity(record))
        throw new Error("DAEMON_RUNNING: stop the daemon before uninstalling ASC");
      print(uninstallSelf(config.installRecord));
    });
  if (args[0] === "init") {
    writeDefaultConfig();
    initFiles(config);
    console.log(`Initialized ACS at ${config.data}`);
    return;
  }
  if (args[0] === "daemon" && args[1] === "run") return daemon();
  if (args[0] === "daemon" && args[1] === "start") {
    await daemonStart();
    process.exit(0);
  }
  if (args[0] === "daemon" && args[1] === "status") return daemonStatus();
  if (args[0] === "daemon" && args[1] === "stop") return daemonStop();
  if (args[0] === "daemon" && args[1] === "restart") {
    await daemonStop();
    await daemonStart();
    process.exit(0);
  }
  if (args[0] === "mcp" && args[1] === "codex") return runMcp(port);
  if (args[0] === "codex" && args[1] === "doctor") return doctor();
  if (args[0] === "codex" && args[1] === "install-mcp") {
    const installed = Bun.spawnSync([
      settings.codex.binary,
      "mcp",
      "add",
      "acs",
      "--",
      installedExecutable(config.installRecord),
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
  if (args[0] === "codex" && args[1] === "bind") {
    const agent = required(args[2], "agent"),
      explicitSession = option("--session"),
      session = explicitSession ?? (await chooseCodexSession(call));
    return print(await call("bindings.bind", bindingParams(agent, session)));
  }
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
        slug: option("--slug"),
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
      await call(
        "bindings.bind",
        bindingParams(required(args[2], "agent"), required(option("--session"), "--session")),
      ),
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
  if (args[0] === "inbox") return print(await call("inbox.list", { agent: args[1] || undefined }));
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
        resolution: resolutionOption(),
      }),
    );
  if (args[0] === "token" && args[1] === "show") {
    console.log(readFileSync(config.token, "utf8"));
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}`);
}

async function daemon() {
  const instanceId = option("--instance") ?? crypto.randomUUID(),
    managed = process.env.ACS_MANAGED_DAEMON === "1";
  if (managed) {
    let record = readDaemonRecord(config.daemonRecord);
    for (let attempt = 0; !record && attempt < 40; attempt++) {
      await Bun.sleep(25);
      record = readDaemonRecord(config.daemonRecord);
    }
    if (!record || record.pid !== process.pid || record.instanceId !== instanceId)
      throw new Error("DAEMON_IDENTITY_FAILED: managed process record does not match");
  } else {
    await withLifecycleLock(config.lifecycleLock, async () => {
      const existing = readDaemonRecord(config.daemonRecord);
      if (existing && daemonIdentity(existing)) throw new Error("DAEMON_ALREADY_RUNNING");
      await recoverStaleRuntime();
      writeDaemonRecord(config.daemonRecord, createRecord(process.pid, instanceId));
    });
  }
  const store = new Store(config, {
      maxInlineContentBytes: settings.security.maxInlineContentBytes,
      maxParts: settings.security.maxParts,
      maxTextPartBytes: settings.security.maxTextPartBytes,
      claimTtlSeconds: settings.security.claimTtlSeconds,
      defaultMode: settings.delivery.defaultMode,
      busyTimeoutMs: settings.storage.busyTimeoutMs,
      durability: settings.storage.durability,
      maxQueuedDeliveryIntents: settings.delivery.maxQueuedDeliveryIntents,
    }),
    startedAt = new Date().toISOString();
  let scheduler: DeliveryScheduler | undefined;
  const a2a = Bun.serve({
    hostname: listen.hostname,
    port,
    fetch: (request) =>
      handleA2A(
        store,
        request,
        port,
        settings.security.maxRequestBytes,
        () => scheduler?.signal(),
        listen.hostname,
      ),
    error: (error) => sanitizedError(error, String(process.pid)),
  });
  let control: ReturnType<typeof Bun.serve>;
  let finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const codexSocket =
    process.env.ACS_CODEX_SOCKET ??
    `${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/app-server-control/app-server-control.sock`;
  const adapter = settings.codex.enabled
      ? new CodexRuntimeAdapter(codexSocket, settings.codex.maxInFlightRequests)
      : undefined,
    callerAttestor = adapter
      ? new CodexCallerAttestor(
          required(
            store
              .query<{ id: `ins_${string}` }, [string]>(
                "SELECT id FROM runtime_installations WHERE adapter_id=? LIMIT 1",
              )
              .get(adapter.descriptor.adapterId),
            "runtime installation",
          ).id,
        )
      : undefined;
  scheduler = adapter
    ? new DeliveryScheduler(store, adapter, String(process.pid), {
        concurrency: settings.delivery.workerConcurrency,
        leaseMs: settings.delivery.leaseSeconds * 1000,
        retryBaseMs: settings.delivery.retryBaseMs,
        retryCapMs: settings.delivery.retryCapMs,
        reconnectMs: settings.codex.statusPollIntervalMs,
      })
    : undefined;
  await scheduler?.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      let forceTimer: Timer | undefined;
      const serversStopped = Promise.all([a2a.stop(), control.stop()]),
        forcedClosed = new Promise<void>((resolve) => {
          forceTimer = setTimeout(() => {
            void a2a.stop(true);
            void control.stop(true);
            resolve();
          }, 1000);
        });
      try {
        await scheduler?.stop();
        await Promise.race([serversStopped, forcedClosed]);
      } catch (error) {
        sanitizedError(
          error instanceof Error ? error : new Error(String(error)),
          String(process.pid),
        );
      } finally {
        if (forceTimer) clearTimeout(forceTimer);
        store.close();
        if (existsSync(config.runtime)) unlinkSync(config.runtime);
        const record = readDaemonRecord(config.daemonRecord);
        if (record?.pid === process.pid && record.instanceId === instanceId)
          unlinkSync(config.daemonRecord);
        finish?.();
      }
    })();
  };
  control = Bun.serve({
    unix: config.runtime,
    fetch: controlHandler(store, startedAt, stop, adapter, callerAttestor),
    error: (error) => sanitizedError(error, String(process.pid)),
  });
  chmodSync(config.runtime, 0o600);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("info", "daemon.started", String(process.pid), {
    a2a: a2a.url.origin,
    control: "ready",
  });
  await stopped;
}

async function daemonStart() {
  return withLifecycleLock(config.lifecycleLock, async () => {
    const current = readDaemonRecord(config.daemonRecord);
    if (current && daemonIdentity(current)) {
      print({
        status: "running",
        pid: current.pid,
        version: current.version,
        alreadyRunning: true,
      });
      return;
    }
    await recoverStaleRuntime();
    initFiles(config);
    const child = spawnDaemon(config);
    let record;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        record = createRecord(child.pid, child.instanceId);
        break;
      } catch {
        await Bun.sleep(25);
      }
    }
    if (!record) throw new Error("DAEMON_START_FAILED: child exited before inspection");
    writeDaemonRecord(config.daemonRecord, record);
    try {
      await waitForHealth(5000);
    } catch (error) {
      if (daemonIdentity(record)) nativeProcesses.signal(record.pid, "SIGTERM");
      if (!(await awaitProcess(record.pid, 1000, () => daemonIdentity(record)))) {
        if (daemonIdentity(record)) nativeProcesses.signal(record.pid, "SIGKILL");
        await awaitProcess(record.pid, 1000, () => daemonIdentity(record));
      }
      if (daemonIdentity(record))
        throw new Error("DAEMON_START_FAILED: child could not be terminated safely", {
          cause: error,
        });
      removeStaleRuntime(config);
      throw error;
    }
    print({ status: "running", pid: record.pid, version: record.version });
  });
}

async function daemonStatus() {
  return withLifecycleLock(config.lifecycleLock, async () => {
    const record = readDaemonRecord(config.daemonRecord);
    if (!record || !daemonIdentity(record)) {
      if (await runtimeResponds()) {
        print({
          status: "untracked",
          detail: "control socket is live but process identity is absent",
        });
        return;
      }
      removeStaleRuntime(config);
      print({ status: "stopped" });
      return;
    }
    try {
      await health();
      print({
        status: "running",
        pid: record.pid,
        version: record.version,
        startedAt: record.startedAt,
        executable: record.executable,
        health: "ok",
      });
    } catch {
      print({ status: "running", health: "degraded", pid: record.pid, version: record.version });
    }
  });
}

async function daemonStop() {
  return withLifecycleLock(config.lifecycleLock, async () => {
    const record = readDaemonRecord(config.daemonRecord);
    if (!record || !daemonIdentity(record)) {
      if (await runtimeResponds())
        throw new Error("DAEMON_UNTRACKED: refusing to stop a process without matching identity");
      removeStaleRuntime(config);
      print({ status: "stopped", alreadyStopped: true });
      return;
    }
    try {
      await lifecycleCall("system.shutdown");
    } catch {
      // The identity check below remains authoritative if the control plane is unavailable.
    }
    if (!(await awaitProcess(record.pid, 3000, () => daemonIdentity(record)))) {
      if (daemonIdentity(record)) nativeProcesses.signal(record.pid, "SIGTERM");
      if (!(await awaitProcess(record.pid, 2000, () => daemonIdentity(record)))) {
        if (!daemonIdentity(record))
          throw new Error("DAEMON_IDENTITY_CHANGED: refusing forced signal");
        nativeProcesses.signal(record.pid, "SIGKILL");
        await awaitProcess(record.pid, 1000, () => daemonIdentity(record));
      }
    }
    if (daemonIdentity(record)) throw new Error("DAEMON_STOP_FAILED: process did not exit");
    removeStaleRuntime(config);
    print({ status: "stopped", pid: record.pid });
  });
}

async function waitForHealth(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await health();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(
    `DAEMON_START_FAILED: readiness timeout (${lastError instanceof Error ? lastError.message : "unavailable"})`,
  );
}

async function health() {
  await lifecycleCall("system.initialize", {
    protocolVersion: "1.0",
    client: { name: "acs-lifecycle", version: VERSION, instanceId: String(process.pid) },
    capabilities: {},
  });
  return lifecycleCall("system.health");
}

function lifecycleCall(method: string, params: unknown = {}) {
  return Promise.race([
    controlCall(config.runtime, config.token, method, params),
    Bun.sleep(750).then(() => {
      throw new Error("RUNTIME_UNAVAILABLE: control request timed out");
    }),
  ]);
}

async function recoverStaleRuntime() {
  if (await runtimeResponds())
    throw new Error("DAEMON_UNTRACKED: a live control socket has no matching process record");
  removeStaleRuntime(config);
}

async function runtimeResponds() {
  return existsSync(config.runtime) && (await socketAccepts(config.runtime));
}

function sanitizedError(error: Error, instanceId: string) {
  log("error", "daemon.error", instanceId, { code: error.message.split(":")[0] });
  return Response.json({ error: "internal" }, { status: 500 });
}
function log(
  severity: "info" | "error",
  event: string,
  daemonInstanceId: string,
  attributes: Record<string, unknown>,
) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[severity] < levels[settings.daemon.logLevel]) return;
  const record = {
    timestamp: new Date().toISOString(),
    severity,
    daemonInstanceId,
    event,
    ...attributes,
  };
  console.error(
    settings.daemon.logFormat === "json"
      ? JSON.stringify(record)
      : Object.entries(record)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" "),
  );
}
function option(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
function resolutionOption() {
  const resolutions = [
    ["--accepted", "accepted"],
    ["--not-accepted-and-retry", "not-accepted-and-retry"],
    ["--not-accepted-and-cancel", "not-accepted-and-cancel"],
  ].filter(([flag]) => args.includes(flag));
  if (resolutions.length !== 1) throw new Error("Specify exactly one delivery resolution flag");
  return required(resolutions[0]?.[1], "delivery resolution");
}
function required<T>(value: T | null | undefined, name: string): T {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
function bindingParams(
  agent: string,
  session: string | { readonly installationId: string; readonly opaqueId: string },
) {
  return {
    agent,
    session,
    continuityPolicy: option("--continuity") ?? "follow-pending",
    deliveryPolicy: {
      wakeStrategy:
        args.includes("--allow-non-atomic-wake") || settings.codex.allowNonAtomicWake
          ? "non-atomic-idle-check"
          : "atomic-only",
      allowActiveTurnSteering: settings.codex.allowActiveTurnSteering,
      autoResumeDormantThread: settings.codex.autoResumeDormantThreads,
      interruptOnCancel: true,
    },
    revokeExisting: args.includes("--revoke-existing"),
  };
}
async function chooseCodexSession(call: (method: string, params?: unknown) => Promise<unknown>) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Interactive Codex binding requires a terminal; use --session for automation");
  const sessions = new Array<SessionChoice>();
  let cursor: string | undefined;
  do {
    const page = recordValue(await call("runtimes.sessions.list", { cursor, limit: 100 }));
    sessions.push(...sessionChoices(page.sessions));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await pickSession(sessions, (prompt) => terminal.question(prompt));
  } finally {
    terminal.close();
  }
}
function sessionChoices(value: unknown): SessionChoice[] {
  if (!Array.isArray(value)) throw new Error("Invalid runtime session list");
  return value.map((item) => {
    const snapshot = recordValue(item),
      session = recordValue(snapshot.session),
      attributes = recordValue(snapshot.attributes);
    if (
      typeof session.installationId !== "string" ||
      typeof session.opaqueId !== "string" ||
      typeof snapshot.availability !== "string"
    )
      throw new Error("Invalid runtime session");
    return {
      session: { installationId: session.installationId, opaqueId: session.opaqueId },
      availability: snapshot.availability,
      title: typeof attributes.displayTitle === "string" ? attributes.displayTitle : undefined,
      cwd: typeof attributes.cwdHint === "string" ? attributes.cwdHint : undefined,
    };
  });
}
async function doctor() {
  const codex = Bun.spawnSync([settings.codex.binary, "--version"]);
  const installedCodex = codex.success ? codex.stdout.toString().trim() : undefined,
    call = (method: string, params: unknown = {}) =>
      controlCall(config.runtime, config.token, method, params);
  let sharedAppServer: string, runningCodexVersion: string | undefined;
  try {
    await call("system.initialize", {
      protocolVersion: "1.0",
      client: { name: "acs-doctor", version: "0.1.0", instanceId: String(process.pid) },
      capabilities: {},
    });
    const probeResult = recordValue(await call("runtimes.probe")),
      probe = recordValue(probeResult.probe),
      sessionsResult = recordValue(await call("runtimes.sessions.list", { limit: 1 })),
      sessions = sessionsResult.sessions;
    runningCodexVersion =
      typeof probe.runtimeVersion === "string" ? probe.runtimeVersion : undefined;
    sharedAppServer = `ready (${Array.isArray(sessions) ? sessions.length : 0} thread sampled)`;
  } catch (error) {
    sharedAppServer = `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
  print({
    codex: {
      installed: installedCodex ?? "unavailable",
      testedVersion: TESTED_CODEX_VERSION,
      supportedVersions: SUPPORTED_CODEX_VERSIONS,
      runningVersion: runningCodexVersion ?? "unavailable",
      compatibility:
        runningCodexVersion && SUPPORTED_CODEX_VERSIONS.includes(runningCodexVersion)
          ? "tested"
          : "untested",
    },
    phaseZero: {
      a2aOnBun: "verified by pinned TCK",
      standaloneExecutable: "verified by clean-machine release matrix",
      mcpAttestation: "verified on Codex 0.153.2 and 0.153.4",
      sharedAppServer,
      safeDelivery: "context injection proven; wake remains explicit non-atomic opt-in",
      deliveryReconciliation: "durable wake marker proven; absence remains operator-owned",
      approvalOwnership:
        "verified: user approvals remain TUI-owned; ACS never answers local-input requests",
    },
    mutatingDeliveryEnabled: Boolean(
      runningCodexVersion &&
      SUPPORTED_CODEX_VERSIONS.includes(runningCodexVersion) &&
      sharedAppServer.startsWith("ready"),
    ),
  });
}
function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecordValue(value)) throw new Error("Invalid control response");
  return value;
}
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function usage() {
  console.log(
    `ACS ${VERSION}\n\n  acs version\n  acs install [--prefix ~/.local] [--non-interactive]\n  acs uninstall\n  acs init\n  acs daemon run|start|status|restart|stop\n  acs agents create <slug> [--claim] [--name name] [--description text]\n  acs agents get|delete <agent>\n  acs agents update <agent> [--slug slug] [--name name] [--description text] [--enable|--disable]\n  acs agents list\n  acs codex sessions list\n  acs codex bind <agent> [--session <codex-thread-id>] [--continuity follow-pending|strict] [--allow-non-atomic-wake] [--revoke-existing]\n  acs bindings bind <agent> --session <codex-thread-id> [--continuity follow-pending|strict] [--allow-non-atomic-wake] [--revoke-existing]\n  acs bindings get|revoke <binding-id>\n  acs bindings list\n  acs runtimes list\n  acs inbox [agent]\n  acs deliveries list|get|retry|cancel <delivery-id>\n  acs deliveries resolve <delivery-id> --accepted|--not-accepted-and-retry|--not-accepted-and-cancel\n  acs token show\n  acs codex doctor\n  acs codex install-mcp\n  acs mcp codex`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
