import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, launchAgent, persistentEnvironment } from "../apps/acs/src/service";

test("persistent runtime paths are absolute", () => {
  expect(
    persistentEnvironment(
      {
        ACS_HOME: ".acs",
        ACS_CONFIG_PATH: "config.toml",
        ACS_STORAGE_PATH: "data/acs.db",
        ACS_CONTROL_SOCKET: "run/control.sock",
        ACS_CODEX_BINARY: "codex",
      },
      "/work/repo",
    ),
  ).toMatchObject({
    ACS_HOME: "/work/repo/.acs",
    ACS_CONFIG_PATH: "/work/repo/config.toml",
    ACS_STORAGE_PATH: "/work/repo/data/acs.db",
    ACS_CONTROL_SOCKET: "/work/repo/run/control.sock",
    ACS_CODEX_BINARY: "codex",
  });
});

test("login service preserves executable arguments and the bridge socket environment", () => {
  const agent = launchAgent({
    command: ["/Applications/ACS & Tools/acs"],
    environment: { ACS_CONTROL_SOCKET: "/private/tmp/acs/control.sock" },
    log: "/Users/example/Library/Logs/acs.log",
  });
  expect(agent.ProgramArguments).toEqual(["/Applications/ACS & Tools/acs", "daemon", "start"]);
  expect(agent.EnvironmentVariables.ACS_CONTROL_SOCKET).toBe("/private/tmp/acs/control.sock");
  expect(agent.KeepAlive).toBe(true);
  expect(agent.RunAtLoad).toBe(true);
  if (process.platform === "darwin") {
    const encoded = Bun.spawnSync(["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-"], {
      stdin: Buffer.from(JSON.stringify(agent)),
    });
    expect(encoded.exitCode).toBe(0);
    const decoded = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], {
      stdin: encoded.stdout,
    });
    expect(decoded.exitCode).toBe(0);
    expect(JSON.parse(decoded.stdout.toString())).toEqual(agent);
  }
});

test.skipIf(process.platform !== "darwin")(
  "init migrates an unmanaged daemon and restarts an unchanged service",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "acs-service-")),
      success = { success: true, error: "" },
      failure = { success: false, error: "not loaded" },
      actions: string[] = [];
    let loaded = false;
    const launchctl = (command: string[]) => {
      const operation = command.join(" ");
      actions.push(operation);
      if (command[0] === "print")
        return command[1] === "gui/999/local.acs.daemon" && loaded ? success : failure;
      if (command[0] === "bootstrap") loaded = true;
      return success;
    };
    try {
      const options = {
        home,
        launchctl,
        uid: 999,
        command: ["/Applications/acs"],
        environment: { ACS_CONTROL_SOCKET: "/tmp/test-acs.sock" },
        stopUnmanagedDaemon: async () => {
          actions.push("stop unmanaged");
        },
      };
      await installService(options);
      expect(actions).toEqual([
        "print gui/999/local.acs.daemon",
        "print gui/999/local.asc.daemon",
        "stop unmanaged",
        `bootstrap gui/999 ${home}/Library/LaunchAgents/local.acs.daemon.plist`,
      ]);
      actions.length = 0;
      await installService(options);
      expect(actions).toEqual([
        "print gui/999/local.acs.daemon",
        "print gui/999/local.asc.daemon",
        "kickstart -k gui/999/local.acs.daemon",
      ]);
    } finally {
      rmSync(home, { recursive: true });
    }
  },
);

for (const legacyLoaded of [false, true]) {
  test.skipIf(process.platform !== "darwin")(
    `init retires the legacy service (loaded: ${legacyLoaded})`,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "acs-service-")),
        legacyPath = join(home, "Library/LaunchAgents/local.asc.daemon.plist"),
        actions: string[] = [];
      mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
      writeFileSync(legacyPath, "legacy plist");
      try {
        await installService({
          home,
          uid: 999,
          command: ["/Applications/acs"],
          environment: {},
          stopUnmanagedDaemon: async () => {
            actions.push("stop unmanaged");
          },
          launchctl: (args) => {
            actions.push(args.join(" "));
            return {
              success:
                args[0] !== "print" || (args[1] === "gui/999/local.asc.daemon" && legacyLoaded),
              error: "not loaded",
            };
          },
        });
        expect(actions).toEqual([
          "print gui/999/local.acs.daemon",
          "print gui/999/local.asc.daemon",
          ...(legacyLoaded ? ["bootout gui/999/local.asc.daemon"] : []),
          "stop unmanaged",
          `bootstrap gui/999 ${home}/Library/LaunchAgents/local.acs.daemon.plist`,
        ]);
        expect(existsSync(legacyPath)).toBe(false);
      } finally {
        rmSync(home, { recursive: true });
      }
    },
  );
}

test.skipIf(process.platform !== "darwin")(
  "init aborts when the legacy service cannot stop",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "acs-service-")),
      legacyPath = join(home, "Library/LaunchAgents/local.asc.daemon.plist"),
      actions: string[] = [];
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(legacyPath, "legacy plist");
    try {
      await expect(
        installService({
          home,
          uid: 999,
          command: ["/Applications/acs"],
          environment: {},
          stopUnmanagedDaemon: async () => {
            actions.push("stop unmanaged");
          },
          launchctl: (args) => {
            actions.push(args.join(" "));
            return {
              success: args[0] === "print" && args[1] === "gui/999/local.asc.daemon",
              error: "bootout denied",
            };
          },
        }),
      ).rejects.toThrow("bootout denied");
      expect(actions).toEqual([
        "print gui/999/local.acs.daemon",
        "print gui/999/local.asc.daemon",
        "bootout gui/999/local.asc.daemon",
      ]);
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(join(home, "Library/LaunchAgents/local.acs.daemon.plist"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true });
    }
  },
);
