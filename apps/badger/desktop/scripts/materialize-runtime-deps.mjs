import { access, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getPrunableRuntimePaths, shouldMaterializeRuntimeDep } from "./materialize-runtime-deps-lib.mjs";
import { resolvePackageTarget } from "./package-targets.mjs";

// The platform whose prebuilds survive pruning. package.mjs names the target
// through SF_PACKAGE_TARGET so Linux can materialize the Windows prebuild; a
// bare run (no variable) keeps prebuilds for the host it runs on.
const targetPlatform = process.env.SF_PACKAGE_TARGET
  ? resolvePackageTarget(process.env.SF_PACKAGE_TARGET).nodePlatform
  : process.platform;
// A materialized package is pruned for exactly one platform; this marker lets
// a later run for another target restore the pruned prebuilds from the bun store.
const MATERIALIZED_MARKER = ".sf-materialized-platform";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const appRequire = createRequire(join(appDir, "package.json"));
const packageJsonPath = join(appDir, "package.json");
const nodeModulesDir = join(appDir, "node_modules");
const workspaceRootNodeModulesDir = resolve(appDir, "..", "..", "..", "node_modules");
const bunStoreDir = join(workspaceRootNodeModulesDir, ".bun");

const findPackageDirFromEntry = async (entryPath) => {
  let currentDir = dirname(entryPath);
  while (currentDir.startsWith(nodeModulesDir)) {
    const packageJsonPath = join(currentDir, "package.json");
    try {
      await access(packageJsonPath);
      return currentDir;
    } catch {
      // Keep walking up.
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
};

const findPackageDirInBunStore = async (pkgName, versionHint) => {
  const bunPkgName = pkgName.replace("/", "+");
  const entries = await readdir(bunStoreDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${bunPkgName}@`))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (!dirs.length) return null;
  const cleanedHint = (versionHint ?? "").replace(/^[~^]/, "");
  const candidate =
    dirs.find((name) => (cleanedHint ? name.startsWith(`${bunPkgName}@${cleanedHint}`) : false)) ?? dirs[0];
  const sourceDir = join(bunStoreDir, candidate, "node_modules", ...pkgName.split("/"));
  try {
    await access(join(sourceDir, "package.json"));
    return sourceDir;
  } catch {
    return null;
  }
};

const ensureRealPackage = async (pkgName, versionHint) => {
  if (!pkgName) return;

  // The bun store holds the pristine package; a previously materialized copy
  // in node_modules is already pruned for one platform and must not be a source.
  let sourceDir = await findPackageDirInBunStore(pkgName, versionHint);
  if (!sourceDir) {
    try {
      sourceDir = dirname(appRequire.resolve(`${pkgName}/package.json`));
    } catch {
      try {
        const entryPath = appRequire.resolve(pkgName);
        sourceDir = await findPackageDirFromEntry(entryPath);
      } catch {
        sourceDir = null;
      }
    }
  }
  if (!sourceDir) return;

  const targetDir = join(nodeModulesDir, ...pkgName.split("/"));

  await mkdir(dirname(targetDir), { recursive: true });

  let shouldCopy = true;
  try {
    const stat = await lstat(targetDir);
    if (stat.isSymbolicLink()) {
      shouldCopy = true;
    } else {
      const marker = await readFile(join(targetDir, MATERIALIZED_MARKER), "utf8").catch(() => null);
      shouldCopy = marker?.trim() !== targetPlatform;
    }
  } catch {
    shouldCopy = true;
  }

  if (shouldCopy) {
    await rm(targetDir, { recursive: true, force: true });
    await cp(sourceDir, targetDir, { recursive: true, dereference: true });
    console.log(`[package] materialized ${pkgName}`);
  }

  // node-addon-api is better-sqlite3's only dependency and holds C++ headers for
  // from-source builds. The packaged app loads a prebuild, so the dependency is
  // dropped and electron-builder does not try to collect it.
  if (pkgName === "better-sqlite3") {
    const targetPackageJsonPath = join(targetDir, "package.json");
    const targetPackageJson = JSON.parse(await readFile(targetPackageJsonPath, "utf8"));
    if (targetPackageJson.dependencies) {
      delete targetPackageJson.dependencies["node-addon-api"];
    }
    await writeFile(targetPackageJsonPath, `${JSON.stringify(targetPackageJson, null, 2)}\n`, "utf8");
  }

  for (const relativePath of getPrunableRuntimePaths(pkgName, targetPlatform)) {
    await rm(join(targetDir, relativePath), { recursive: true, force: true });
  }
  await writeFile(join(targetDir, MATERIALIZED_MARKER), `${targetPlatform}\n`, "utf8");
};

const run = async () => {
  const rootPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const runtimeDeps = Object.entries(rootPackage.dependencies ?? {});
  for (const [dep, version] of runtimeDeps) {
    if (!shouldMaterializeRuntimeDep(dep)) continue;
    await ensureRealPackage(dep, typeof version === "string" ? version : undefined);
  }
};

run().catch((error) => {
  console.error("[package] failed to materialize runtime dependencies");
  console.error(error);
  process.exit(1);
});
