import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../packages/runtime-codex/profiles/compatibility-manifest.json" with { type: "json" };
import clientRequest from "../packages/runtime-codex/profiles/codex-app-server-v1/generated/schema/ClientRequest.json" with { type: "json" };
import serverNotification from "../packages/runtime-codex/profiles/codex-app-server-v1/generated/schema/ServerNotification.json" with { type: "json" };

const digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(clientRequest))
    .update("\0")
    .update(JSON.stringify(serverNotification))
    .digest("hex")}`,
  profile = manifest.profiles.at(0);
if (!profile) throw new Error("Codex compatibility manifest has no profiles");
if (profile.generation.schemaDigest !== digest)
  throw new Error(
    `Codex schema digest mismatch: manifest=${profile.generation.schemaDigest} actual=${digest}`,
  );
const generatedVersion = readFileSync(
  resolve(
    import.meta.dir,
    "../packages/runtime-codex/profiles/codex-app-server-v1/generated/CODEX_VERSION",
  ),
  "utf8",
).trim();
if (generatedVersion !== profile.generation.generatorVersion)
  throw new Error(
    `Codex generator version mismatch: manifest=${profile.generation.generatorVersion} generated=${generatedVersion}`,
  );
const lock = readFileSync(resolve(import.meta.dir, "../bun.lock"), "utf8");
if (!lock.includes(`"${profile.generation.sourcePackageDigest}"`))
  throw new Error("Codex source package digest is not present in bun.lock");
console.log(`Verified ${profile.profileId} (${digest})`);
