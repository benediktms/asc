const allowed: Record<string, readonly string[]> = {
    "@a2a-js/": ["packages/protocol-a2a/"],
    "@modelcontextprotocol/": ["packages/bridge-mcp-codex/"],
    "codex-protocol-generated": ["packages/runtime-codex/src/protocol-codec.ts"],
    "bun:": ["packages/storage-sqlite/", "packages/runtime-codex/", "apps/acs/"],
  },
  pureRoots = ["contracts/", "packages/domain/", "packages/ports/", "packages/application/"];

const failures: string[] = [];
for await (const file of new Bun.Glob("{apps,contracts,packages}/**/*.ts").scan({
  cwd: import.meta.dir + "/..",
})) {
  const source = await Bun.file(import.meta.dir + "/../" + file).text();
  if (pureRoots.some((root) => file.startsWith(root)) && /\bBun\b/.test(source))
    failures.push(`${file}: Bun global`);
  if (
    file.startsWith("packages/domain/") &&
    /\b(?:fetch|Request|Response|Headers|WebSocket)\b/.test(source)
  )
    failures.push(`${file}: HTTP global`);
  for (const match of source.matchAll(
    /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const specifier = match.at(1);
    if (!specifier) continue;
    if (pureRoots.some((root) => file.startsWith(root)) && specifier.startsWith("node:"))
      failures.push(`${file}: ${specifier}`);
    if (
      ["packages/application/", "packages/protocol-a2a/"].some((root) => file.startsWith(root)) &&
      (specifier.includes("storage-sqlite") || specifier.startsWith("node:"))
    )
      failures.push(`${file}: ${specifier}`);
    if (
      ["packages/bridge-mcp-codex/", "packages/protocol-control/"].some((root) =>
        file.startsWith(root),
      ) &&
      specifier.includes("storage-sqlite")
    )
      failures.push(`${file}: ${specifier}`);
    for (const [marker, roots] of Object.entries(allowed))
      if (specifier.includes(marker) && !roots.some((root) => file.startsWith(root)))
        failures.push(`${file}: ${specifier}`);
  }
}
if (failures.length) throw new Error(`Import boundary violations:\n${failures.join("\n")}`);
console.log("Import boundaries OK");
