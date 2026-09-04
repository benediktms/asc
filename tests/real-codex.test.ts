import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntimeAdapter } from "../packages/runtime-codex/src/index";
import { CodexAppServerClient } from "../packages/runtime-codex/src/app-server-client";

test.skipIf(process.env.ACS_REAL_CODEX !== "1")(
  "discovers two loaded threads from an isolated real Codex app-server",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-real-codex-")),
      socket = join(root, "app.sock"),
      child = Bun.spawn(
        ["./node_modules/.bin/codex", "app-server", "--listen", `unix://${socket}`],
        {
          env: { ...process.env, CODEX_HOME: root },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await Bun.sleep(50);
      if (!existsSync(socket)) throw new Error(await new Response(child.stderr).text());
      const setup = new CodexAppServerClient(socket);
      await setup.start();
      await setup.startThread({ cwd: root, ephemeral: false });
      await setup.startThread({ cwd: root, ephemeral: false });
      const adapter = new CodexRuntimeAdapter(socket);
      await adapter.start({
        installationId: "ins_real_codex",
        instanceId: "real-codex-test",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        clock: { now: () => new Date().toISOString() },
        assertBindingFence: async () => ({ valid: true }),
      });
      const page = await adapter.listSessions({ limit: 10 });
      expect(page.sessions).toHaveLength(2);
      expect(page.sessions.every((session) => session.availability === "idle")).toBe(true);
      await adapter.stop({ reason: "shutdown" });
      setup.close();
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
