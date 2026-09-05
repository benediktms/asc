import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RuntimePaths } from "../packages/config/src/index";
import {
  daemonIdentity,
  installSelf,
  readDaemonRecord,
  removeStaleRuntime,
  rotateLog,
  uninstallSelf,
  withLifecycleLock,
  writeDaemonRecord,
  type DaemonRecord,
  type ProcessPort,
} from "../apps/acs/src/lifecycle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon lifecycle", () => {
  test("requires PID, start marker, executable, and daemon command before signalling", () => {
    const record = daemonRecord(),
      matching = fakeProcesses({
        executable: "/opt/acs/acs",
        start: "boot-ticks-42",
        command: "/opt/acs/acs daemon run --instance expected",
      });
    expect(daemonIdentity(record, matching)).toBe(true);
    expect(
      daemonIdentity(record, fakeProcesses({ ...matching.description, start: "reused-pid" })),
    ).toBe(false);
    expect(
      daemonIdentity(record, fakeProcesses({ ...matching.description, command: "unrelated" })),
    ).toBe(false);
  });

  test("serializes concurrent lifecycle mutations", async () => {
    const root = temporary("acs-lock-"),
      lock = join(root, "lifecycle.lock"),
      events: string[] = [];
    const first = withLifecycleLock(lock, async () => {
        events.push("first-enter");
        await Bun.sleep(75);
        events.push("first-exit");
      }),
      second = withLifecycleLock(lock, async () => events.push("second-enter"));
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  test("persists private process records and refuses non-socket stale runtime paths", () => {
    const root = temporary("acs-record-"),
      paths = testPaths(root),
      record = daemonRecord();
    writeDaemonRecord(paths.daemonRecord, record);
    expect(readDaemonRecord(paths.daemonRecord)).toEqual(record);
    writeFileSync(paths.runtime, "not a socket");
    expect(() => removeStaleRuntime(paths)).toThrow("refusing to remove a non-socket");
    expect(existsSync(paths.runtime)).toBe(true);
  });

  test("rotates bounded local logs", () => {
    const root = temporary("acs-log-"),
      log = join(root, "daemon.log");
    writeFileSync(log, "current");
    writeFileSync(`${log}.1`, "previous");
    rotateLog(log, 1, 2);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("current");
    expect(readFileSync(`${log}.2`, "utf8")).toBe("previous");
  });
});

describe("self installation", () => {
  test("installs atomically to a version directory and preserves data on uninstall", () => {
    const root = temporary("acs-install-"),
      prefix = join(root, "prefix"),
      data = join(root, "data"),
      source = join(root, "release-acs"),
      record = join(data, "install.json");
    mkdirSync(prefix, { mode: 0o700 });
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(source, "binary", { mode: 0o700 });
    writeFileSync(join(data, "keep.db"), "important");
    const installed = installSelf(source, prefix, record, "test-target");
    expect(resolve(dirname(installed.executable), readlinkSync(installed.executable))).toBe(
      installed.destination,
    );
    expect(readFileSync(installed.destination, "utf8")).toBe("binary");
    const removed = uninstallSelf(record);
    expect(removed.preservedData).toBe(data);
    expect(existsSync(join(data, "keep.db"))).toBe(true);
    expect(existsSync(installed.executable)).toBe(false);
  });

  test("refuses shared prefixes and unowned PATH entries", () => {
    const root = temporary("acs-unsafe-install-"),
      source = join(root, "acs"),
      data = join(root, "install.json");
    writeFileSync(source, "binary");
    chmodSync(root, 0o777);
    expect(() => installSelf(source, join(root, "prefix"), data, "test")).toThrow(
      "group/world writable",
    );
    chmodSync(root, 0o700);
    const prefix = join(root, "prefix");
    mkdirSync(join(prefix, "bin"), { recursive: true, mode: 0o700 });
    symlinkSync("/usr/bin/true", join(prefix, "bin", "acs"));
    expect(() => installSelf(source, prefix, data, "test")).toThrow("unowned symlink");
  });
});

function temporary(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function daemonRecord(): DaemonRecord {
  return {
    pid: 42,
    instanceId: "expected",
    executable: "/opt/acs/acs",
    processStart: "boot-ticks-42",
    startedAt: "2026-09-05T00:00:00.000Z",
    version: "0.1.0",
  };
}

function fakeProcesses(description: ReturnType<ProcessPort["describe"]>): ProcessPort & {
  description: NonNullable<ReturnType<ProcessPort["describe"]>>;
} {
  const defined = required(description);
  return {
    description: defined,
    describe: () => defined,
    signal: () => undefined,
  };
}

function testPaths(root: string): RuntimePaths {
  return {
    data: join(root, "acs.db"),
    runtime: join(root, "control.sock"),
    token: join(root, "control.token"),
    bridgeToken: join(root, "bridge.token"),
    secret: join(root, "secret.key"),
    stateDirectory: join(root, "state"),
    daemonRecord: join(root, "state", "daemon.json"),
    lifecycleLock: join(root, "state", "lifecycle.lock"),
    logDirectory: join(root, "logs"),
    daemonLog: join(root, "logs", "daemon.log"),
    installRecord: join(root, "install.json"),
  };
}

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("expected value");
  return value;
}
