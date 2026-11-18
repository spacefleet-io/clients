import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDeps } from "../packages/media-deps/src/registry";
import { hostTarget } from "../packages/media-deps/src/targets";

/**
 * Fetches the published media-deps bundle (ffmpeg, ffprobe, mpv + their libraries) for one target into
 * vendor/deps/<target>/{bin/,deps-manifest.json}. Idempotent; verifies sha256; caches downloads
 * in ~/.cache/spacefleet/deps. Usage: bun scripts/fetch-deps.ts [--target <id>] (packages/media-deps/recipes/<id>, e.g. linux-x64, android-arm)
 */
const argv = process.argv.slice(2);
const flag = argv.indexOf("--target");
const requested = flag >= 0 ? argv[flag + 1] : undefined;
if (flag >= 0 && !requested) throw new Error("--target needs a value");
// Dev tooling, not product code: the host picks its own target from the recipes' `nodePlatform`.
const targetId = requested ?? (await hostTarget(process.platform, process.arch)).id;

await fetchDeps({
  targetId,
  repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
});
