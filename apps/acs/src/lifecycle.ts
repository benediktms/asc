import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimePaths } from "../../../packages/config/src/index";

export const VERSION = "0.1.0";

export interface DaemonRecord {
  pid: number;
  instanceId: string;
  executable: string;
  processStart: string;
  startedAt: string;
  version: string;
}

export interface ProcessPort {
  describe(pid: number): { executable: string; start: string; command: string } | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export const nativeProcesses: ProcessPort = {
  describe(pid) {
    try {
      if (process.platform === "linux") {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
            close = stat.lastIndexOf(")"),
            fields = stat.slice(close + 2).split(" "),
            start = fields.at(19),
            command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
          if (close >= 0 && start && command)
            return { executable: realpathSync(`/proc/${pid}/exe`), start, command };
        } catch {
          // Minimal containers may hide procfs; use the portable ps fallback below.
        }
      }
      const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="]);
      if (!result.success) return undefined;
      const output = result.stdout.toString().trim(),
        match = output.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
      if (!match) return undefined;
      const command = match[2] ?? "",
        daemonMarker = command.indexOf(" daemon run"),
        executable = daemonMarker > 0 ? command.slice(0, daemonMarker) : command.split(/\s+/).at(0);
      return executable
        ? { executable: safeRealpath(executable), start: match[1] ?? "", command }
        : undefined;
    } catch {
      return undefined;
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

export function daemonIdentity(record: DaemonRecord, processes: ProcessPort = nativeProcesses) {
  const actual = processes.describe(record.pid);
  return Boolean(
    actual &&
    actual.start === record.processStart &&
    sameExecutable(actual.executable, record.executable) &&
    actual.command.includes("daemon") &&
    actual.command.includes("run"),
  );
}

export function readDaemonRecord(path: string): DaemonRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) return undefined;
    if (
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.instanceId !== "string" ||
      typeof value.executable !== "string" ||
      typeof value.processStart !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.version !== "string"
    )
      return undefined;
    return {
      pid: value.pid,
      instanceId: value.instanceId,
      executable: value.executable,
      processStart: value.processStart,
      startedAt: value.startedAt,
      version: value.version,
    };
  } catch {
    return undefined;
  }
}

export function writeDaemonRecord(path: string, record: DaemonRecord) {
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export async function withLifecycleLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dirname(path));
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (!isFsCode(error, "EEXIST")) throw error;
      const age = lockAge(path);
      if (age > 30_000) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error("DAEMON_BUSY: lifecycle operation in progress", { cause: error });
      await Bun.sleep(25);
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

export function removeStaleRuntime(paths: RuntimePaths) {
  if (existsSync(paths.runtime)) {
    const value = lstatSync(paths.runtime);
    if (!value.isSocket())
      throw new Error("DAEMON_UNSAFE_SOCKET: refusing to remove a non-socket runtime path");
    unlinkSync(paths.runtime);
  }
  if (existsSync(paths.daemonRecord)) unlinkSync(paths.daemonRecord);
}

export function spawnDaemon(paths: RuntimePaths) {
  mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(paths.logDirectory);
  if (pathExists(paths.daemonLog)) {
    const log = lstatSync(paths.daemonLog);
    if (!log.isFile() || (process.getuid && log.uid !== process.getuid()))
      throw new Error("DAEMON_UNSAFE_LOG: refusing an unowned or non-regular log path");
    chmodSync(paths.daemonLog, 0o600);
  }
  rotateLog(paths.daemonLog);
  const descriptor = openSync(paths.daemonLog, "a", 0o600),
    instanceId = randomUUID(),
    command = selfCommand(["daemon", "run", "--instance", instanceId]),
    child = Bun.spawn(command, {
      env: { ...process.env, ACS_MANAGED_DAEMON: "1" },
      stdin: "ignore",
      stdout: descriptor,
      stderr: descriptor,
    });
  child.unref();
  closeSync(descriptor);
  if (!child.pid) throw new Error("DAEMON_START_FAILED: child PID unavailable");
  return { pid: child.pid, instanceId };
}

export async function awaitProcess(
  pid: number,
  timeoutMs: number,
  alive: (pid: number) => boolean,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

export function socketAccepts(path: string, timeoutMs = 250) {
  return new Promise<boolean>((resolveSocket) => {
    let settled = false;
    const socket = createConnection(path),
      finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolveSocket(value);
      },
      timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function createRecord(pid: number, instanceId: string, processes = nativeProcesses) {
  const described = processes.describe(pid);
  if (!described) throw new Error("DAEMON_START_FAILED: unable to inspect child process");
  return {
    pid,
    instanceId,
    executable: described.executable,
    processStart: described.start,
    startedAt: new Date().toISOString(),
    version: VERSION,
  } satisfies DaemonRecord;
}

export function installSelf(
  source: string,
  prefix: string,
  installRecord: string,
  target = `${process.platform}-${process.arch}`,
) {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("UNSUPPORTED_PLATFORM: ASC installation supports macOS and Linux");
  const root = resolve(prefix),
    bin = join(root, "bin"),
    versions = join(root, "lib", "acs", "versions"),
    directory = join(versions, VERSION, target),
    destination = join(directory, "acs"),
    link = join(bin, "acs");
  assertPrivatePrefix(root);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(bin);
  assertPrivateDirectory(directory);
  if (pathExists(link)) {
    const existing = lstatSync(link);
    if (!existing.isSymbolicLink())
      throw new Error("UNSAFE_INSTALL: refusing to replace a non-symlink PATH entry");
    const existingTarget = resolve(bin, readlinkSync(link));
    if (!existsSync(join(dirname(existingTarget), ".acs-owned")))
      throw new Error("UNSAFE_INSTALL: refusing to replace an unowned symlink");
  }
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, destination);
  writeFileSync(join(directory, ".acs-owned"), `${VERSION}\n`, { mode: 0o600 });
  const temporaryLink = `${link}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(relative(bin, destination), temporaryLink);
  renameSync(temporaryLink, link);
  atomicWrite(
    installRecord,
    `${JSON.stringify({ executable: link, destination, prefix: root })}\n`,
    0o600,
  );
  return { executable: link, destination, prefix: root };
}

export function uninstallSelf(installRecord: string) {
  const installation = readInstallRecord(installRecord);
  if (!installation) throw new Error("NOT_INSTALLED: no ASC installation record found");
  const expectedBin = join(installation.prefix, "bin", "acs"),
    expectedVersions = join(installation.prefix, "lib", "acs", "versions"),
    destinationRelative = relative(expectedVersions, installation.destination);
  if (
    resolve(installation.executable) !== resolve(expectedBin) ||
    destinationRelative === ".." ||
    destinationRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(destinationRelative)
  )
    throw new Error("UNSAFE_UNINSTALL: installation record points outside its prefix");
  const marker = join(dirname(installation.destination), ".acs-owned");
  if (!existsSync(marker))
    throw new Error("UNSAFE_UNINSTALL: installation ownership marker missing");
  if (pathExists(installation.executable)) {
    const link = lstatSync(installation.executable);
    if (!link.isSymbolicLink())
      throw new Error("UNSAFE_UNINSTALL: PATH entry is not an ASC-owned symlink");
    const resolved = resolve(
      dirname(installation.executable),
      readlinkSync(installation.executable),
    );
    if (resolved !== installation.destination)
      throw new Error("UNSAFE_UNINSTALL: PATH symlink no longer targets this installation");
    unlinkSync(installation.executable);
  }
  rmSync(dirname(installation.destination), { recursive: true });
  unlinkSync(installRecord);
  return { removed: installation.destination, preservedData: dirname(installRecord) };
}

export function installedExecutable(installRecord: string) {
  const record = readInstallRecord(installRecord);
  if (!record || !pathExists(record.executable))
    throw new Error("NOT_INSTALLED: run `acs install` before installing the MCP bridge");
  const entry = lstatSync(record.executable),
    target = entry.isSymbolicLink()
      ? resolve(dirname(record.executable), readlinkSync(record.executable))
      : undefined;
  if (!target || target !== record.destination || !existsSync(join(dirname(target), ".acs-owned")))
    throw new Error("UNSAFE_INSTALL: stable executable path no longer matches its ASC record");
  return record.executable;
}

export function rotateLog(path: string, maxBytes = 5 * 1024 * 1024, retained = 3) {
  if (!existsSync(path) || statSync(path).size < maxBytes) return;
  const oldest = `${path}.${retained}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = retained - 1; index >= 1; index--) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

function readInstallRecord(path: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(value) ||
      typeof value.executable !== "string" ||
      typeof value.destination !== "string" ||
      typeof value.prefix !== "string"
    )
      return undefined;
    return {
      executable: value.executable,
      destination: value.destination,
      prefix: value.prefix,
    };
  } catch {
    return undefined;
  }
}

function assertPrivatePrefix(path: string) {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  assertPrivateDirectory(candidate);
}

function assertPrivateDirectory(path: string) {
  const value = statSync(path);
  if (!value.isDirectory()) throw new Error(`UNSAFE_INSTALL: ${path} is not a directory`);
  if (process.getuid && value.uid !== process.getuid())
    throw new Error(`UNSAFE_INSTALL: ${path} is not owned by the current user`);
  if ((value.mode & 0o022) !== 0)
    throw new Error(`UNSAFE_INSTALL: ${path} is group/world writable`);
}

function selfCommand(arguments_: string[]) {
  return basename(process.execPath).startsWith("bun")
    ? [process.execPath, Bun.main, ...arguments_]
    : [process.execPath, ...arguments_];
}

function atomicWrite(path: string, content: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

function sameExecutable(left: string, right: string) {
  return safeRealpath(left) === safeRealpath(right);
}

function safeRealpath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function lockAge(path: string) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isFsCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code;
}

function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
