import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const BADGER_MAIN_ENTRY_ALLOWED_LOCAL_IMPORTS = new Set([
  "./apiHost",
  "./appIdentity",
  "./appWindowVisibility",
  "./deviceSettingsIpc",
  "./e2ePerfProbe",
  "./electronPerformance",
  "./escapeKeyForward",
  "./externalMpv",
  "./ffmpegIpc",
  "./ffmpegRuntimeBridge",
  "./fileSystem",
  "./handoffIpc",
  "./libraryDbIpc",
  "./libraryDbRuntimeProxy",
  "./libraryDbAccessor",
  "./logger",
  "./mediaCrypto",
  "./mediaIngest",
  "./missing-binaries",
  "./mpvProcessGroup",
  "./notifications",
  "./packagedRuntime",
  "./pairingIpc",
  "./playbackIpc",
  "./playbackSaturation",
  "./playbackRuntimeBridge",
  "./playbackServer",
  "./playbackThrottle",
  "./protocolLink",
  "./rendererFlush",
  "./runtimeOwnerSecret",
  "./runtimeSpawnEnv",
  "./secondInstanceHandler",
  "./sessionIpc",
  "./storageTraffic",
  "./toolAccessIpc",
  "./uiStrings",
  "./updater",
  "./uploadPlaybackPolicy",
]);

export const BADGER_MAIN_ENTRY_FORBIDDEN_LOCAL_IMPORTS = new Set([
  "./db",
  "./libraryDb",
  "./libraryDbStorage",
  "./crypto",
  "./storage",
  "./api",
]);

const extractImportSpecifiers = (source: string) => {
  const regex = /^\s*import[\s\S]*?from\s+["']([^"']+)["'];?\s*$/gm;
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const specifier = String(match[1] ?? "").trim();
    if (specifier.length > 0) specifiers.push(specifier);
  }
  return specifiers;
};

export const validateBadgerMainEntryImports = (source: string): string[] => {
  const imports = extractImportSpecifiers(source);
  const errors: string[] = [];
  for (const specifier of imports) {
    if (!specifier.startsWith("./")) continue;
    if (BADGER_MAIN_ENTRY_FORBIDDEN_LOCAL_IMPORTS.has(specifier)) {
      errors.push(`forbidden import in main entry: ${specifier}`);
      continue;
    }
    if (!BADGER_MAIN_ENTRY_ALLOWED_LOCAL_IMPORTS.has(specifier)) {
      errors.push(`non-allowlisted local import in main entry: ${specifier}`);
    }
  }
  return errors;
};

export const validateBadgerMainEntryFromFile = (filePath: string) => {
  const source = readFileSync(filePath, "utf8");
  return validateBadgerMainEntryImports(source);
};

export const getDefaultBadgerMainEntryPath = (repoRoot = process.cwd()) =>
  existsSync(resolvePath(repoRoot, "src/main/index.ts"))
    ? resolvePath(repoRoot, "src/main/index.ts")
    : resolvePath(repoRoot, "apps/badger/desktop/src/main/index.ts");
