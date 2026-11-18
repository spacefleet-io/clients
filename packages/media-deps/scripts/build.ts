import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  archiveFileName,
  buildManifest,
  computeRecipeHash,
  createArchive,
  createBuildPlan,
  forgeAuthFromEnv,
  getPackageRoot,
  loadTarget,
  packageVersion,
  sha256File,
  verifyTarget,
  writeManifest,
} from "../src/index";
import { SHA256_SUFFIX } from "../src/registry";
import { parseArgs } from "./_args";

/**
 * Builds one target's bundle: docker build -> manifest -> tar.gz (+ .sha256) -> verify.
 * Heavy: wrap with the host's heavy-process lock. Output: packages/media-deps/out/<target>/.
 * Env: MEDIA_DEPS_GH_TOKEN or GH_TOKEN, only while the spacefleet-io forks are private (read access).
 * Usage: bun scripts/build.ts --target linux-x64 [--skip-verify]
 */
const args = parseArgs(process.argv.slice(2));
const targetId = typeof args.target === "string" ? args.target : "linux-x64";
const target = await loadTarget(targetId);
const packageRoot = getPackageRoot();
const outDir = path.join(packageRoot, "out", target.id);
const dockerOut = path.join(packageRoot, "out", `${target.id}.docker`);

rmSync(outDir, { recursive: true, force: true });
rmSync(dockerOut, { recursive: true, force: true });
mkdirSync(dockerOut, { recursive: true });

const plan = createBuildPlan(target, { outputDir: dockerOut, packageRoot, forgeAuth: forgeAuthFromEnv() });
console.info(`[media-deps:build] ${target.id} recipe ${computeRecipeHash(target).slice(0, 12)}`);
const code = await new Promise<number>((resolve, reject) => {
  const child = spawn(plan.command, plan.args, { stdio: "inherit", env: { ...process.env, ...plan.env } });
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
if (code !== 0) throw new Error(`build_failed:${code}`);

// The recipe's output root IS the bundle (bin/, and per OS lib/, the player app, …).
mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(dockerOut)) renameSync(path.join(dockerOut, entry), path.join(outDir, entry));
rmSync(dockerOut, { recursive: true, force: true });

const recipeHash = computeRecipeHash(target);
const manifest = await buildManifest(outDir, target, recipeHash);
writeManifest(outDir, manifest);
const archivePath = path.join(outDir, archiveFileName(target));
await createArchive(outDir, archivePath);
const sha256 = await sha256File(archivePath);
writeFileSync(`${archivePath}${SHA256_SUFFIX}`, `${sha256}  ${archiveFileName(target)}\n`);
console.info(`[media-deps:build] ${archivePath} sha256=${sha256} version=${packageVersion(recipeHash)}`);

if (args["skip-verify"] === true) process.exit(0);
const result = await verifyTarget({
  bundleDir: outDir,
  target,
  hostPlatform: process.platform,
  oscScript: path.resolve(packageRoot, "..", "mpv", "resources", "osc", "sf.lua"),
});
if (!result.ok) {
  console.error(`[media-deps:build] verification failed:\n${result.failures.join("\n")}`);
  process.exit(1);
}
