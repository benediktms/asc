import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const [beforeArg, afterArg] = process.argv.slice(2);
if (!beforeArg || !afterArg)
  throw new Error("usage: bun run codex:diff -- <before-generated-dir> <after-generated-dir>");
const before = resolve(beforeArg),
  after = resolve(afterArg),
  beforeFiles = jsonFiles(before),
  afterFiles = jsonFiles(after),
  paths = new Set([...beforeFiles, ...afterFiles]);
const changes: string[] = [];
for (const path of [...paths].toSorted()) {
  if (!beforeFiles.has(path)) changes.push(`added ${path}`);
  else if (!afterFiles.has(path)) changes.push(`removed ${path}`);
  else {
    const left = canonicalJson(join(before, path)),
      right = canonicalJson(join(after, path));
    if (left !== right) changes.push(`changed ${path}`);
  }
}
console.log(changes.length ? changes.join("\n") : "No JSON schema changes");
process.exitCode = changes.length ? 1 : 0;

function jsonFiles(root: string): Set<string> {
  const found = new Set<string>(),
    visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".json")) found.add(relative(root, path));
      }
    };
  visit(root);
  return found;
}
function canonicalJson(path: string): string {
  return JSON.stringify(JSON.parse(readFileSync(path, "utf8")));
}
