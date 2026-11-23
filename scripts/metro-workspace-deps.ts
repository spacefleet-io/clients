/**
 * Static check shared by the React Native apps' Metro tests (Badger and Parrot phone).
 *
 * Both apps' metro.config.js block every workspace package's own node_modules (a second React or React Native copy in
 * one bundle crashes at launch), so a third-party runtime dependency of a workspace package the app bundles must be
 * installed in the app's own node_modules or hoisted to the repo root. Bun's isolated linker installs it only under the
 * workspace package, so the app must declare it itself.
 */
import fs from "fs";
import path from "path";

/** Export subpaths the phone apps never import: they run on servers only. */
const SERVER_ONLY_EXPORT = /^\.\/server(?:\/|$)/;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

type PackageJson = { exports?: unknown; main?: string; dependencies?: Record<string, string> };

/**
 * Bare package names imported by the source files reachable from a workspace package's non-server exports, or null when
 * the package declares no TypeScript/JavaScript entry to walk from (then every dependency counts).
 */
export function metroReachableImports(pkgDir: string, pkg: PackageJson): Set<string> | null {
  const targets = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  const exportsField = pkg.exports ?? pkg.main;
  const entries =
    exportsField && typeof exportsField === "object" && Object.keys(exportsField).every((key) => key.startsWith("."))
      ? Object.entries(exportsField).flatMap(([key, value]) => (SERVER_ONLY_EXPORT.test(key) ? [] : targets(value)))
      : targets(exportsField);
  const queue = entries.filter((entry) => /\.[cm]?[jt]sx?$/.test(entry)).map((entry) => path.resolve(pkgDir, entry));
  if (queue.length === 0) return null;
  const seen = new Set<string>();
  const imports = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const [, specifier] of fs.readFileSync(file, "utf-8").matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)) {
      if (specifier!.startsWith(".")) {
        const base = path.resolve(path.dirname(file), specifier!);
        const resolved = SOURCE_EXTENSIONS.map((ext) => base + ext).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved) queue.push(resolved);
      } else {
        imports.add(specifier!.split("/").slice(0, specifier!.startsWith("@") ? 2 : 1).join("/"));
      }
    }
  }
  return imports;
}

/**
 * Third-party runtime dependencies (`<workspace pkg> -> <dep>`) of the workspace packages an app bundles (followed
 * transitively through `@space/*` runtime dependencies) that Metro cannot resolve from the app's node_modules or the
 * repo root's. A dependency imported only behind a server-only export never reaches Metro and is skipped.
 */
export function unresolvableWorkspaceRuntimeDeps(mobileRoot: string, repoRoot: string, workspaceDeps: string[], log: (line: string) => void = () => {}): string[] {
  const readPkg = (dir: string): PackageJson => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  const workspacePkgDirs = new Map<string, string>();
  const queue = [...workspaceDeps];
  while (queue.length > 0) {
    const dep = queue.shift()!;
    if (workspacePkgDirs.has(dep)) continue;
    const pkgDir = path.join(repoRoot, "packages", dep.replace("@space/", ""));
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) continue;
    workspacePkgDirs.set(dep, pkgDir);
    for (const child of Object.keys(readPkg(pkgDir).dependencies ?? {})) {
      if (child.startsWith("@space/")) queue.push(child);
    }
  }
  const missing: string[] = [];
  for (const [dep, pkgDir] of workspacePkgDirs) {
    const pkg = readPkg(pkgDir);
    const bundled = metroReachableImports(pkgDir, pkg);
    for (const thirdParty of Object.keys(pkg.dependencies ?? {})) {
      if (thirdParty.startsWith("@space/")) continue;
      if (bundled && !bundled.has(thirdParty)) {
        log(`pkg=${dep} dep=${thirdParty} skipped: not imported from any app-bundled entry`);
        continue;
      }
      const resolvable = [path.join(mobileRoot, "node_modules"), path.join(repoRoot, "node_modules")].some((root) =>
        fs.existsSync(path.join(root, thirdParty, "package.json")),
      );
      log(`pkg=${dep} dep=${thirdParty} resolvable=${resolvable}`);
      if (!resolvable) missing.push(`${dep} -> ${thirdParty}`);
    }
  }
  return missing;
}
