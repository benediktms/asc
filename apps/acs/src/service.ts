import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function persistentEnvironment(environment: Record<string, string>, cwd = process.cwd()) {
  const normalized = { ...environment };
  for (const key of [
    "CODEX_HOME",
    "ACS_HOME",
    "ACS_CONFIG_PATH",
    "ACS_CONTROL_SOCKET",
    "ACS_STORAGE_PATH",
    "ACS_CODEX_SOCKET",
  ])
    if (normalized[key]) normalized[key] = resolve(cwd, normalized[key]);
  if (normalized.ACS_CODEX_BINARY?.includes("/"))
    normalized.ACS_CODEX_BINARY = resolve(cwd, normalized.ACS_CODEX_BINARY);
  return normalized;
}

export function launchAgent(options: {
  command: string[];
  environment: Record<string, string>;
  log: string;
}) {
  return {
    Label: "local.asc.daemon",
    ProgramArguments: [...options.command, "daemon", "start"],
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    EnvironmentVariables: options.environment,
    StandardOutPath: options.log,
    StandardErrorPath: options.log,
  };
}

export async function installService(options: {
  command: string[];
  environment: Record<string, string>;
  home: string;
  uid: number;
  stopUnmanagedDaemon: () => Promise<void>;
  launchctl?: typeof launchctl;
}) {
  const control = options.launchctl ?? launchctl,
    path = `${options.home}/Library/LaunchAgents/local.asc.daemon.plist`,
    log = `${options.home}/Library/Logs/asc.log`,
    domain = `gui/${options.uid}`,
    target = `${domain}/local.asc.daemon`,
    plist = Bun.spawnSync(["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-"], {
      stdin: Buffer.from(JSON.stringify(launchAgent({ ...options, log }))),
    });
  if (!plist.success) throw new Error(plist.stderr.toString());
  const content = plist.stdout.toString(),
    changed = !existsSync(path) || readFileSync(path, "utf8") !== content,
    loaded = control(["print", target]).success;
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  if (changed) writeFileSync(path, content, { mode: 0o600 });
  if (!loaded) await options.stopUnmanagedDaemon();
  if (loaded && changed) requireSuccess(control(["bootout", target]));
  if (!loaded || changed) {
    for (let attempt = 0; ; attempt++) {
      const result = control(["bootstrap", domain, path]);
      if (result.success) break;
      if (!loaded || !changed || attempt === 49)
        throw new Error(result.error || "Service bootstrap failed");
      await Bun.sleep(100);
    }
  } else requireSuccess(control(["kickstart", "-k", target]));
}

function launchctl(args: string[]) {
  const result = Bun.spawnSync(["/bin/launchctl", ...args]);
  return { success: result.success, error: result.stderr.toString() };
}

function requireSuccess(result: ReturnType<typeof launchctl>) {
  if (!result.success) throw new Error(result.error || "launchctl failed");
}
