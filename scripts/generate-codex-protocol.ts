import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  committedOutput = join(root, "packages/runtime-codex/profiles/codex-app-server-v1/generated"),
  temporary = mkdtempSync(join(tmpdir(), "acs-codex-protocol-")),
  check = process.argv.includes("--check"),
  output = check ? join(temporary, "output") : committedOutput;
const source = join(temporary, "src"),
  schema = join(temporary, "schema");
const command = process.env.ACS_CODEX_BINARY ?? "codex";

try {
  for (const args of [
    ["app-server", "generate-ts", "--experimental", "--out", source],
    ["app-server", "generate-json-schema", "--experimental", "--out", schema],
  ]) {
    const result = Bun.spawnSync([command, ...args]);
    if (!result.success)
      throw new Error(result.stderr.toString() || `codex ${args.join(" ")} failed`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, "src"), { recursive: true });
  mkdirSync(join(output, "schema", "v1"), { recursive: true });
  mkdirSync(join(output, "schema", "v2"), { recursive: true });
  const queue = [
    "InitializeResponse.ts",
    "ResponseItem.ts",
    "v2/ThreadInjectItemsParams.ts",
    "v2/ThreadLoadedListResponse.ts",
    "v2/ThreadListParams.ts",
    "v2/ThreadListResponse.ts",
    "v2/ThreadReadParams.ts",
    "v2/ThreadReadResponse.ts",
    "v2/ThreadStartParams.ts",
    "v2/ThreadStartResponse.ts",
    "v2/TurnStartParams.ts",
    "v2/TurnStartResponse.ts",
    "v2/ThreadItem.ts",
    "v2/ThreadStatus.ts",
    "v2/ItemCompletedNotification.ts",
    "v2/TurnCompletedNotification.ts",
  ];
  const copied = new Set<string>();
  while (queue.length) {
    const file = queue.pop();
    if (!file) break;
    if (copied.has(file)) continue;
    copied.add(file);
    const input = join(source, file),
      content = readFileSync(input, "utf8"),
      target = join(output, "src", file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(input, target);
    for (const match of content.matchAll(/from\s+"(.+)"/g)) {
      const dependency = match.at(1);
      if (dependency?.startsWith("."))
        queue.push(`${relative(source, resolve(dirname(input), dependency))}.ts`);
    }
  }
  for (const file of [
    "ClientRequest.json",
    "ServerNotification.json",
    "v1/InitializeParams.json",
    "v1/InitializeResponse.json",
    "v2/ThreadInjectItemsParams.json",
    "v2/ThreadLoadedListParams.json",
    "v2/ThreadLoadedListResponse.json",
    "v2/ThreadListParams.json",
    "v2/ThreadListResponse.json",
    "v2/ThreadReadParams.json",
    "v2/ThreadReadResponse.json",
    "v2/ThreadStartParams.json",
    "v2/ThreadStartResponse.json",
    "v2/TurnStartParams.json",
    "v2/TurnStartResponse.json",
    "v2/TurnInterruptParams.json",
    "v2/TurnInterruptResponse.json",
    "v2/ItemCompletedNotification.json",
    "v2/TurnCompletedNotification.json",
  ]) {
    const target = join(output, "schema", file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(schema, file), target);
  }
  const version = Bun.spawnSync([command, "--version"]);
  if (!version.success) throw new Error("could not read Codex version");
  writeFileSync(
    join(output, "CODEX_VERSION"),
    version.stdout
      .toString()
      .trim()
      .replace(/^codex-cli\s+/, "") + "\n",
  );
  console.log(
    `Vendored ${copied.size} generated TypeScript files for ${readFileSync(join(output, "CODEX_VERSION"), "utf8").trim()}`,
  );
  if (check) {
    const difference = Bun.spawnSync(["diff", "-ru", committedOutput, output]);
    if (!difference.success)
      throw new Error(
        difference.stdout.toString() ||
          difference.stderr.toString() ||
          "generated Codex protocol differs from committed output",
      );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
