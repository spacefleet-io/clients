/**
 * Static check shared by the React Native apps' Metro tests (Badger and Parrot phone).
 *
 * Both apps' metro.config.js block every workspace package's own node_modules (a second React or React Native copy in
 * one bundle crashes at launch), so a third-party runtime dependency of a workspace package the app bundles must be
 * installed in the app's own node_modules or hoisted to the repo root. Bun's isolated linker installs it only under the
 * workspace package, so the app must declare it itself.
 *
 * Only code Metro bundles counts: the walk starts at the `@space/*` entry points the app's own source imports (the
 * exact subpath, so `@space/ingest-core/subtitleLanguageDetection` never pulls in the ingest's Node code) and follows
 * relative and `@space/*` imports from there.
 */
import fs from "fs";
import path from "path";

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** App folders Metro never bundles: native projects, test suites, release tooling. */
const NON_BUNDLED_DIRS = new Set(["node_modules", "android", "ios", "tests", "__tests__", "scripts", "fastlane", "vendor"]);
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

type PackageJson = { exports?: unknown; main?: string; dependencies?: Record<string, string> };

const packageName = (specifier: string): string => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

const importSpecifiers = (file: string): string[] => [...fs.readFileSync(file, "utf-8").matchAll(IMPORT_SPECIFIER)].map(([, s]) => s!);

/** The app's own bundled source files: its root entry files and everything under its folders but tests and native projects. */
function appSourceFiles(dir: string, root = true): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return NON_BUNDLED_DIRS.has(entry.name) || entry.name.startsWith(".") || entry.name.startsWith("e2e") ? [] : appSourceFiles(full, false);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !(root && entry.name.endsWith(".config.js")) ? [full] : [];
  });
}

/**
 * The source files a `@space/*` specifier (`@space/x` or `@space/x/sub`) enters a workspace package through, or null
 * when the package declares no TypeScript/JavaScript entry for it (then every dependency of the package counts).
 */
function entryFiles(pkgDir: string, pkg: PackageJson, specifier: string): string[] | null {
  const targets = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  const subpath = `.${specifier.slice(packageName(specifier).length)}`;
  const exportsField = pkg.exports ?? pkg.main;
  let found: string[];
  if (exportsField && typeof exportsField === "object" && Object.keys(exportsField).every((key) => key.startsWith("."))) {
    const map = exportsField as Record<string, unknown>;
    if (subpath in map) found = targets(map[subpath]);
    else {
      // A pattern export (`"./runtime/*": "./src/runtime/*.ts"`): its `*` is the rest of the subpath.
      const pattern = Object.keys(map).find((key) => key.includes("*") && subpath.startsWith(key.slice(0, key.indexOf("*"))) && subpath.endsWith(key.slice(key.indexOf("*") + 1)));
      const star = pattern ? subpath.slice(pattern.indexOf("*"), subpath.length - (pattern.length - pattern.indexOf("*") - 1)) : "";
      found = pattern ? targets(map[pattern]).map((target) => target.replace("*", star)) : [];
    }
  } else found = subpath === "." ? targets(exportsField) : [subpath];
  const files = found.filter((entry) => SOURCE_FILE.test(entry)).map((entry) => path.resolve(pkgDir, entry));
  return files.length > 0 ? files : null;
}

/**
 * Third-party runtime dependencies (`<workspace pkg> -> <dep>`) of the workspace packages an app bundles that Metro
 * cannot resolve from the app's node_modules or the repo root's. Only `@space/*` packages in `workspaceDeps` (the
 * app's runtime dependencies) are entered from the app's source; others are reached through their imports.
 */
export function unresolvableWorkspaceRuntimeDeps(mobileRoot: string, repoRoot: string, workspaceDeps: string[], log: (line: string) => void = () => {}): string[] {
  const pkgCache = new Map<string, PackageJson | null>();
  const readPkg = (name: string): PackageJson | null => {
    if (!pkgCache.has(name)) {
      const file = path.join(repoRoot, "packages", name.replace("@space/", ""), "package.json");
      pkgCache.set(name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null);
    }
    return pkgCache.get(name)!;
  };

  // Per bundled workspace package: the bare packages its reachable files import (null: no entry to walk, all count).
  const bundledImports = new Map<string, Set<string> | null>();
  const seenSpecifiers = new Set<string>();
  const seenFiles = new Set<string>();
  const specifiers = appSourceFiles(mobileRoot)
    .flatMap(importSpecifiers)
    .filter((specifier) => workspaceDeps.includes(packageName(specifier)));
  while (specifiers.length > 0) {
    const specifier = specifiers.shift()!;
    if (seenSpecifiers.has(specifier)) continue;
    seenSpecifiers.add(specifier);
    const name = packageName(specifier);
    const pkg = readPkg(name);
    if (!pkg) continue;
    const pkgDir = path.join(repoRoot, "packages", name.replace("@space/", ""));
    const entries = entryFiles(pkgDir, pkg, specifier);
    if (!bundledImports.has(name)) bundledImports.set(name, new Set());
    if (entries === null) {
      log(`pkg=${name} entry=${specifier} has no source entry: every dependency counts`);
      bundledImports.set(name, null);
      continue;
    }
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seenFiles.has(file) || !fs.existsSync(file)) continue;
      seenFiles.add(file);
      for (const imported of importSpecifiers(file)) {
        if (imported.startsWith(".")) {
          const base = path.resolve(path.dirname(file), imported);
          const resolved = SOURCE_EXTENSIONS.map((ext) => base + ext).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
          if (resolved) queue.push(resolved);
        } else if (imported.startsWith("@space/")) {
          specifiers.push(imported);
        } else {
          bundledImports.get(name)?.add(packageName(imported));
        }
      }
    }
  }

  const missing: string[] = [];
  for (const [name, bundled] of bundledImports) {
    for (const thirdParty of Object.keys(readPkg(name)!.dependencies ?? {})) {
      if (thirdParty.startsWith("@space/")) continue;
      if (bundled && !bundled.has(thirdParty)) {
        log(`pkg=${name} dep=${thirdParty} skipped: not imported from any app-bundled entry`);
        continue;
      }
      const resolvable = [path.join(mobileRoot, "node_modules"), path.join(repoRoot, "node_modules")].some((root) =>
        fs.existsSync(path.join(root, thirdParty, "package.json")),
      );
      log(`pkg=${name} dep=${thirdParty} resolvable=${resolvable}`);
      if (!resolvable) missing.push(`${name} -> ${thirdParty}`);
    }
  }
  return missing;
}
