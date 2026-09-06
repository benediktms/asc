import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLocations, loadConfig } from "../packages/config/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("configuration", () => {
  test("uses XDG locations on Linux", () => {
    expect(
      defaultLocations(
        {
          HOME: "/home/agent",
          XDG_CONFIG_HOME: "/config",
          XDG_DATA_HOME: "/data",
          XDG_RUNTIME_DIR: "/run/user/42",
        },
        "linux",
        42,
      ),
    ).toEqual({
      configDirectory: "/config/acs",
      dataDirectory: "/data/acs",
      runtimeSocket: "/run/user/42/acs/control.sock",
    });
  });
  test("loads typed TOML and rejects unknown or non-loopback settings", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-config-"));
    roots.push(root);
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      '[daemon]\na2a_listen = "127.0.0.1:9000"\n[security]\nmax_parts = 8\nmax_text_part_bytes = 1024\n[delivery]\nworker_concurrency = 4\nmax_queued_delivery_intents = 12\n[runtimes.codex]\nmax_in_flight_requests = 64\n',
    );
    const config = loadConfig(path);
    expect(config.delivery.workerConcurrency).toBe(4);
    expect(config.delivery.maxQueuedDeliveryIntents).toBe(12);
    expect(config.security.maxParts).toBe(8);
    expect(config.security.maxTextPartBytes).toBe(1024);
    expect(config.codex.maxInFlightRequests).toBe(64);
    for (const removed of [
      '[delivery]\ndefault_mode = "append_context"\n',
      "[runtimes.codex]\nallow_non_atomic_wake = true\n",
      "[runtimes.codex]\nallow_active_turn_steering = true\n",
    ]) {
      writeFileSync(path, removed);
      expect(() => loadConfig(path)).toThrow("unknown");
    }
    writeFileSync(path, "[daemon]\nunknown = true\n");
    expect(() => loadConfig(path)).toThrow("unknown daemon.unknown");
    writeFileSync(path, '[daemon]\na2a_listen = "0.0.0.0:9000"\n');
    expect(() => loadConfig(path)).toThrow("loopback");
    writeFileSync(path, `[daemon]\ncontrol_socket = "/${"x".repeat(200)}"\n`);
    expect(() => loadConfig(path)).toThrow("daemon.control_socket exceeds");
    writeFileSync(path, '[runtimes.codex]\nconnection = "stdio"\n');
    expect(() => loadConfig(path)).toThrow("invalid runtimes.codex.connection");
    writeFileSync(path, '[daemon]\nlog_level = "verbose"\n');
    expect(() => loadConfig(path)).toThrow("invalid daemon.log_level");
    writeFileSync(path, '[daemon]\nlog_format = "xml"\n');
    expect(() => loadConfig(path)).toThrow("invalid daemon.log_format");
  });
});
