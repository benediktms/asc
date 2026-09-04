import ts from "typescript";

const failures: string[] = [];
for await (const file of new Bun.Glob("{apps,contracts,packages,scripts,tests}/**/*.ts").scan({
  cwd: import.meta.dir + "/..",
})) {
  if (file.startsWith("packages/codex-protocol-generated/")) continue;
  const source = await Bun.file(import.meta.dir + "/../" + file).text(),
    tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) && ts.isAsExpression(node.expression))
      failures.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
if (failures.length)
  throw new Error(`Nested type assertions are forbidden:\n${failures.join("\n")}`);
console.log("No nested type assertions");
