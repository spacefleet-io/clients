import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkSourceArchives, loadTarget, loadTargets, packageVersion, computeRecipeHash, releaseFiles, releasesToken, sourceArchiveFileName } from "../src/index";
import { parseArgs } from "./_args";

/**
 * Release gate: fails (exit 1) when the corresponding-source archive of the media-deps this checkout bundles is
 * not published in its GitHub release. A desktop release must never ship GPL/LGPL binaries without it.
 * With --download <dir>, also downloads each archive into <dir> (keeping its release file name,
 * `media-deps-<target>-source.tar.gz`) so the release flow attaches it next to the installers (REL-DEPS-06).
 * Usage: bun scripts/check-source-archive.ts [--target linux-x64[,windows-x64]] [--download <dir>]   (default: every target)
 */
const args = parseArgs(process.argv.slice(2));
const targetIds = typeof args.target === "string" ? args.target.split(",") : (await loadTargets()).map((target) => target.id);
const { ok, results } = await checkSourceArchives({ targetIds });
for (const result of results) {
  console.info(`[media-deps:release-check] ${result.target} ${result.version}: source archive ${result.published ? "present" : "MISSING"} (${result.url})`);
}
if (!ok) {
  console.error("[media-deps:release-check] refusing to release: publish the missing source archive (deps-build workflow) first");
  process.exit(1);
}
if (typeof args.download === "string") {
  const dir = args.download;
  mkdirSync(dir, { recursive: true });
  const token = releasesToken();
  for (const result of results) {
    const target = await loadTarget(result.target);
    const files = releaseFiles({ target, version: packageVersion(computeRecipeHash(target)), token });
    const file = path.join(dir, sourceArchiveFileName(target));
    try {
      writeFileSync(file, await files.get(sourceArchiveFileName(target)));
    } catch (error) {
      console.error(`[media-deps:release-check] download failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    console.info(`[media-deps:release-check] downloaded ${file}`);
  }
}
