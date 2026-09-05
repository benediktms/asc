import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AcsConfig {
  daemon: {
    a2aListen: string;
    controlSocket: string;
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "pretty" | "json";
  };
  storage: { path: string; durability: "balanced" | "strict"; busyTimeoutMs: number };
  security: {
    requireA2aAuth: boolean;
    maxRequestBytes: number;
    maxInlineContentBytes: number;
    maxParts: number;
    maxTextPartBytes: number;
    claimTtlSeconds: number;
  };
  delivery: {
    workerConcurrency: number;
    leaseSeconds: number;
    defaultMode: "wake_when_idle" | "append_context";
    retryBaseMs: number;
    retryCapMs: number;
    maxQueuedDeliveryIntents: number;
  };
  codex: {
    enabled: boolean;
    binary: string;
    connection: "daemon";
    statusPollIntervalMs: number;
    maxInFlightRequests: number;
    allowNonAtomicWake: boolean;
    allowActiveTurnSteering: boolean;
    autoResumeDormantThreads: boolean;
  };
}

export interface Paths {
  data: string;
  runtime: string;
  token: string;
  bridgeToken: string;
  secret: string;
}

export interface RuntimePaths extends Paths {
  stateDirectory: string;
  daemonRecord: string;
  lifecycleLock: string;
  logDirectory: string;
  daemonLog: string;
  installRecord: string;
}

const text = `[daemon]
a2a_listen = "127.0.0.1:7432"
control_socket = "auto"
log_level = "info"
log_format = "pretty"

[storage]
path = "auto"
durability = "balanced"
busy_timeout_ms = 5000

[security]
require_a2a_auth = true
max_request_bytes = 524288
max_inline_content_bytes = 262144
max_parts = 32
max_text_part_bytes = 65536
claim_ttl_seconds = 600

[delivery]
worker_concurrency = 16
lease_seconds = 30
default_mode = "wake_when_idle"
retry_base_ms = 250
retry_cap_ms = 30000
max_queued_delivery_intents = 1000

[runtimes.codex]
enabled = true
codex_binary = "codex"
connection = "daemon"
status_poll_interval_ms = 2000
max_in_flight_requests = 128
allow_non_atomic_wake = false
allow_active_turn_steering = false
auto_resume_dormant_threads = false
`;

export function defaultLocations(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  uid = process.getuid?.() ?? 0,
) {
  const home = environment.HOME ?? "",
    temporary = environment.TMPDIR ?? "/tmp";
  if (platform === "linux")
    return {
      configDirectory: `${environment.XDG_CONFIG_HOME ?? `${home}/.config`}/acs`,
      dataDirectory: `${environment.XDG_DATA_HOME ?? `${home}/.local/share`}/acs`,
      runtimeSocket: environment.XDG_RUNTIME_DIR
        ? `${environment.XDG_RUNTIME_DIR}/acs/control.sock`
        : `${temporary}/acs-${uid}/control.sock`,
    };
  const directory = `${home}/Library/Application Support/acs`;
  return {
    configDirectory: directory,
    dataDirectory: directory,
    runtimeSocket: `${temporary}/acs-${uid}/control.sock`,
  };
}

export function configPath() {
  const defaults = defaultLocations();
  return (
    process.env.ACS_CONFIG_PATH ?? `${process.env.ACS_HOME ?? defaults.configDirectory}/config.toml`
  );
}
export function writeDefaultConfig(path = configPath()) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}
export function loadConfig(path = configPath()): AcsConfig {
  const defaults = defaultLocations(),
    base = process.env.ACS_HOME ?? defaults.dataDirectory;
  const root = existsSync(path) ? object(Bun.TOML.parse(readFileSync(path, "utf8")), "config") : {};
  keys(root, ["daemon", "storage", "security", "delivery", "runtimes"], "config");
  const daemon = section(root, "daemon", [
      "a2a_listen",
      "control_socket",
      "log_level",
      "log_format",
    ]),
    storage = section(root, "storage", ["path", "durability", "busy_timeout_ms"]),
    security = section(root, "security", [
      "require_a2a_auth",
      "max_request_bytes",
      "max_inline_content_bytes",
      "max_parts",
      "max_text_part_bytes",
      "claim_ttl_seconds",
    ]),
    delivery = section(root, "delivery", [
      "worker_concurrency",
      "lease_seconds",
      "default_mode",
      "retry_base_ms",
      "retry_cap_ms",
      "max_queued_delivery_intents",
    ]),
    runtimes = section(root, "runtimes", ["codex"]),
    codex = section(runtimes, "codex", [
      "enabled",
      "codex_binary",
      "connection",
      "status_poll_interval_ms",
      "max_in_flight_requests",
      "allow_non_atomic_wake",
      "allow_active_turn_steering",
      "auto_resume_dormant_threads",
    ]);
  const configuredListen = string(daemon.a2a_listen, "127.0.0.1:7432"),
    listen = process.env.ACS_A2A_PORT
      ? `127.0.0.1:${positive(Number(process.env.ACS_A2A_PORT), "ACS_A2A_PORT")}`
      : configuredListen,
    controlSocket = socketPath(
      process.env.ACS_CONTROL_SOCKET ??
        auto(string(daemon.control_socket, "auto"), defaults.runtimeSocket),
    ),
    defaultMode = string(delivery.default_mode, "wake_when_idle"),
    durability = string(storage.durability, "balanced"),
    connection = string(codex.connection, "daemon"),
    logLevel = process.env.ACS_LOG_LEVEL ?? string(daemon.log_level, "info"),
    logFormat = process.env.ACS_LOG_FORMAT ?? string(daemon.log_format, "pretty");
  parseListen(listen);
  if (defaultMode !== "wake_when_idle" && defaultMode !== "append_context")
    throw new Error("VALIDATION_FAILED: invalid delivery.default_mode");
  if (durability !== "balanced" && durability !== "strict")
    throw new Error("VALIDATION_FAILED: invalid storage.durability");
  if (connection !== "daemon")
    throw new Error("VALIDATION_FAILED: invalid runtimes.codex.connection");
  if (!isLogLevel(logLevel)) throw new Error("VALIDATION_FAILED: invalid daemon.log_level");
  if (logFormat !== "pretty" && logFormat !== "json")
    throw new Error("VALIDATION_FAILED: invalid daemon.log_format");
  if (!boolean(security.require_a2a_auth, true))
    throw new Error("VALIDATION_FAILED: A2A authentication is required in v1");
  return {
    daemon: {
      a2aListen: listen,
      controlSocket,
      logLevel,
      logFormat,
    },
    storage: {
      path: process.env.ACS_STORAGE_PATH ?? auto(string(storage.path, "auto"), `${base}/acs.db`),
      durability,
      busyTimeoutMs: positive(number(storage.busy_timeout_ms, 5000), "storage.busy_timeout_ms"),
    },
    security: {
      requireA2aAuth: boolean(security.require_a2a_auth, true),
      maxRequestBytes: positive(
        number(security.max_request_bytes, 524288),
        "security.max_request_bytes",
      ),
      maxInlineContentBytes: positive(
        number(security.max_inline_content_bytes, 262144),
        "security.max_inline_content_bytes",
      ),
      maxParts: positive(number(security.max_parts, 32), "security.max_parts"),
      maxTextPartBytes: positive(
        number(security.max_text_part_bytes, 65536),
        "security.max_text_part_bytes",
      ),
      claimTtlSeconds: positive(
        number(security.claim_ttl_seconds, 600),
        "security.claim_ttl_seconds",
      ),
    },
    delivery: {
      workerConcurrency: positive(
        number(delivery.worker_concurrency, 16),
        "delivery.worker_concurrency",
      ),
      leaseSeconds: positive(number(delivery.lease_seconds, 30), "delivery.lease_seconds"),
      defaultMode,
      retryBaseMs: positive(number(delivery.retry_base_ms, 250), "delivery.retry_base_ms"),
      retryCapMs: positive(number(delivery.retry_cap_ms, 30000), "delivery.retry_cap_ms"),
      maxQueuedDeliveryIntents: positive(
        number(delivery.max_queued_delivery_intents, 1000),
        "delivery.max_queued_delivery_intents",
      ),
    },
    codex: {
      enabled: boolean(codex.enabled, true),
      binary: process.env.ACS_CODEX_BINARY ?? string(codex.codex_binary, "codex"),
      connection,
      statusPollIntervalMs: positive(
        number(codex.status_poll_interval_ms, 2000),
        "runtimes.codex.status_poll_interval_ms",
      ),
      maxInFlightRequests: positive(
        number(codex.max_in_flight_requests, 128),
        "runtimes.codex.max_in_flight_requests",
      ),
      allowNonAtomicWake: boolean(codex.allow_non_atomic_wake, false),
      allowActiveTurnSteering: boolean(codex.allow_active_turn_steering, false),
      autoResumeDormantThreads: boolean(codex.auto_resume_dormant_threads, false),
    },
  };
}

export function paths(): RuntimePaths {
  const defaults = defaultLocations(),
    base = process.env.ACS_HOME ?? defaults.dataDirectory,
    config = loadConfig();
  return {
    data:
      process.env.ACS_STORAGE_PATH ??
      (process.env.ACS_HOME ? `${base}/acs.db` : config.storage.path),
    runtime:
      process.env.ACS_CONTROL_SOCKET ??
      (process.env.ACS_HOME ? defaults.runtimeSocket : config.daemon.controlSocket),
    token: `${base}/control.token`,
    bridgeToken: `${base}/bridge.token`,
    secret: `${base}/secret.key`,
    stateDirectory: `${base}/state`,
    daemonRecord: `${base}/state/daemon.json`,
    lifecycleLock: `${base}/state/lifecycle.lock`,
    logDirectory: `${base}/logs`,
    daemonLog: `${base}/logs/daemon.log`,
    installRecord: `${base}/install.json`,
  };
}
export function parseListen(value: string) {
  const match = value.match(/^(127\.0\.0\.1|localhost):(\d+)$/) ?? value.match(/^(\[::1\]):(\d+)$/);
  if (!match) throw new Error("VALIDATION_FAILED: A2A listener must be loopback host:port");
  const host = match.at(1),
    rawPort = match.at(2);
  if (!host || !rawPort) throw new Error("VALIDATION_FAILED: invalid daemon.a2a_listen");
  return {
    hostname: host === "[::1]" ? "::1" : host,
    port: positive(Number(rawPort), "daemon.a2a_listen"),
  };
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown, name: string): ObjectValue {
  if (!isObject(value)) throw new Error(`VALIDATION_FAILED: ${name} must be a table`);
  return value;
}
function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function section(parent: ObjectValue, name: string, allowed: string[]) {
  const value = parent[name] === undefined ? {} : object(parent[name], name);
  keys(value, allowed, name);
  return value;
}
function keys(value: ObjectValue, allowed: string[], name: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`VALIDATION_FAILED: unknown ${name}.${unknown}`);
}
function string(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("VALIDATION_FAILED: expected string");
  return value;
}
function number(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("VALIDATION_FAILED: expected number");
  return value;
}
function boolean(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("VALIDATION_FAILED: expected boolean");
  return value;
}
function positive(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000_000)
    throw new Error(`VALIDATION_FAILED: invalid ${name}`);
  return value;
}
function socketPath(value: string) {
  const maxBytes = process.platform === "linux" ? 107 : 103;
  if (Buffer.byteLength(value) > maxBytes)
    throw new Error(`VALIDATION_FAILED: daemon.control_socket exceeds ${maxBytes} bytes`);
  return value;
}
function auto(value: string, fallback: string) {
  return value === "auto" ? fallback : value;
}
function isLogLevel(value: string): value is AcsConfig["daemon"]["logLevel"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
