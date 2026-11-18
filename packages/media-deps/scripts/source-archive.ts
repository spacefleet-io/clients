import path from "node:path";
import { buildSourceArchive, forgeAuthFromEnv, getPackageRoot, githubTokenFromEnv, loadTarget, publishBundle, sha256File, sourceArchiveFileName } from "../src/index";
import { SHA256_SUFFIX } from "../src/registry";
import { parseArgs } from "./_args";

/**
 * Builds the corresponding-source archive of one target (the exact pinned trees of every library, the recipe, the
 * feature list and SOURCES.json) into out/<target>/, and with --publish uploads it next to the bundle.
 * Env: MEDIA_DEPS_GH_TOKEN or GH_TOKEN: read the forks while they are private; contents write on
 * spacefleet-io/media-deps for --publish.
 * Usage: bun scripts/source-archive.ts --target linux-x64 [--publish]
 */
const args = parseArgs(process.argv.slice(2));
const target = await loadTarget(typeof args.target === "string" ? args.target : "linux-x64");
const archivePath = path.join(getPackageRoot(), "out", target.id, sourceArchiveFileName(target));
const { version, recipeHash } = await buildSourceArchive({ target, archivePath, forgeAuth: forgeAuthFromEnv() });
const sha256 = await sha256File(archivePath);
await Bun.write(`${archivePath}${SHA256_SUFFIX}`, `${sha256}  ${sourceArchiveFileName(target)}\n`);
console.info(`[media-deps:source] ${archivePath} sha256=${sha256} version=${version}`);

if (args.publish === true) {
  const token = githubTokenFromEnv();
  if (!token) throw new Error("MEDIA_DEPS_GH_TOKEN (or GH_TOKEN) is required with --publish");
  const result = await publishBundle({ target, recipeHash, archivePath, fileName: sourceArchiveFileName(target), token });
  console.info(`[media-deps:source] ${result.status} ${result.url} sha256=${result.sha256}`);
}
