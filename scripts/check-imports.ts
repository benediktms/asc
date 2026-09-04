const allowed = {
  "@a2a-js/": ["packages/protocol-a2a/"],
  "@modelcontextprotocol/": ["packages/bridge-mcp-codex/"],
  "codex-protocol-generated": ["packages/runtime-codex/"],
  "bun:": ["packages/storage-sqlite/", "packages/runtime-codex/", "apps/acs/"],
} as const;

const failures: string[] = [];
for await (const file of new Bun.Glob("{apps,packages}/**/*.ts").scan({
  cwd: import.meta.dir + "/..",
})) {
  const source = await Bun.file(import.meta.dir + "/../" + file).text();
  for (const match of source.matchAll(/(?:from\s+|import\s+)["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    for (const [marker, roots] of Object.entries(allowed))
      if (specifier.includes(marker) && !roots.some((root) => file.startsWith(root)))
        failures.push(`${file}: ${specifier}`);
  }
}
if (failures.length) throw new Error(`Import boundary violations:\n${failures.join("\n")}`);
console.log("Import boundaries OK");
