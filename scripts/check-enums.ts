import ts from "typescript";

const failures: string[] = [];
for await (const file of new Bun.Glob("{apps,contracts,packages,scripts,tests}/**/*.ts").scan({
  cwd: import.meta.dir + "/..",
})) {
  if (file.includes("/profiles/") && file.includes("/generated/")) continue;
  const source = await Bun.file(import.meta.dir + "/../" + file).text(),
    tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isEnumDeclaration(node))
      for (const member of node.members)
        if (!member.initializer || !ts.isStringLiteral(member.initializer))
          failures.push(
            `${file}:${tree.getLineAndCharacterOfPosition(member.getStart()).line + 1}`,
          );
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
if (failures.length)
  throw new Error(`Enums must use explicit string values:\n${failures.join("\n")}`);
console.log("String enums OK");
