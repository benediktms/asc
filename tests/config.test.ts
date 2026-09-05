import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/config/src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("configuration", () => {
  test("loads typed TOML and rejects unknown or non-loopback settings", () => {
    const root = mkdtempSync(join(tmpdir(), "acs-config-"));
    roots.push(root);
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      '[daemon]\na2a_listen = "127.0.0.1:9000"\n[delivery]\nworker_concurrency = 4\n[runtimes.codex]\nmax_in_flight_requests = 64\n',
    );
    const config = loadConfig(path);
    expect(config.delivery.workerConcurrency).toBe(4);
    expect(config.codex.maxInFlightRequests).toBe(64);
    writeFileSync(path, "[daemon]\nunknown = true\n");
    expect(() => loadConfig(path)).toThrow("unknown daemon.unknown");
    writeFileSync(path, '[daemon]\na2a_listen = "0.0.0.0:9000"\n');
    expect(() => loadConfig(path)).toThrow("loopback");
  });
});
