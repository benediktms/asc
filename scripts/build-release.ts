import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"],
  targetIndex = process.argv.indexOf("--target"),
  requested = targetIndex < 0 ? undefined : process.argv.at(targetIndex + 1),
  selected = requested ? [requested] : targets;

if (requested && !targets.includes(requested)) throw new Error(`unsupported target: ${requested}`);

for (const target of selected) {
  const output = join(root, "dist", "release", target);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const executable = join(output, "acs"),
    build = Bun.spawnSync([
      "bun",
      "build",
      join(root, "apps/acs/src/main.ts"),
      "--compile",
      `--target=${target}`,
      `--outfile=${executable}`,
    ]);
  if (!build.success) throw new Error(build.stderr.toString() || `build failed for ${target}`);
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES"])
    copyFileSync(join(root, file), join(output, file));
  const files = ["acs", "LICENSE", "THIRD_PARTY_NOTICES"],
    sums = files
      .map(
        (file) =>
          `${createHash("sha256")
            .update(readFileSync(join(output, file)))
            .digest("hex")}  ${file}`,
      )
      .join("\n");
  writeFileSync(join(output, "SHA256SUMS"), `${sums}\n`);
  console.log(output);
}
