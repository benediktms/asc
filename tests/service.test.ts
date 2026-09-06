import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installService, launchAgent } from "../apps/acs/src/service";

test("login service preserves executable arguments and the bridge socket environment", () => {
  const agent = launchAgent({
    command: ["/Applications/ASC & Tools/acs"],
    environment: { ACS_CONTROL_SOCKET: "/private/tmp/acs/control.sock" },
    log: "/Users/example/Library/Logs/asc.log",
  });
  expect(agent.ProgramArguments).toEqual(["/Applications/ASC & Tools/acs", "daemon", "start"]);
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
      if (command[0] === "print") return loaded ? success : failure;
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
        "print gui/999/local.asc.daemon",
        "stop unmanaged",
        `bootstrap gui/999 ${home}/Library/LaunchAgents/local.asc.daemon.plist`,
      ]);
      actions.length = 0;
      await installService(options);
      expect(actions).toEqual([
        "print gui/999/local.asc.daemon",
        "kickstart -k gui/999/local.asc.daemon",
      ]);
    } finally {
      rmSync(home, { recursive: true });
    }
  },
);
