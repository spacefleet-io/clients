import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

type SliceManifest = {
  moduleId?: string;
  artifacts?: Array<{ path?: string }>;
};

export type SlicePackagingGuardOptions = {
  slicesRoot: string;
  targetApp?: "badger" | "parrot";
};

const CORE_ONLY_ARTIFACT_PATTERNS = [/ffmpeg/i, /ffprobe/i];

const parseManifest = (path: string): SliceManifest | null => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SliceManifest;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

const getExpectedModulesForApp = (app: NonNullable<SlicePackagingGuardOptions["targetApp"]>) => {
  if (app === "badger") return new Set(["badger"]);
  return new Set(["parrot"]);
};

export const validateRuntimeSlicePackaging = (options: SlicePackagingGuardOptions): string[] => {
  const slicesRoot = resolvePath(options.slicesRoot);
  const modulesRoot = joinPath(slicesRoot, "modules");
  const errors: string[] = [];
  if (!existsSync(modulesRoot)) return errors;

  const moduleDirs = readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (options.targetApp) {
    const expected = getExpectedModulesForApp(options.targetApp);
    for (const moduleDir of moduleDirs) {
      if (expected.has(moduleDir)) continue;
      errors.push(`unexpected module slice for app ${options.targetApp}: ${moduleDir}`);
    }
  }

  for (const moduleDir of moduleDirs) {
    const manifestPath = joinPath(modulesRoot, moduleDir, "manifest.json");
    const manifest = parseManifest(manifestPath);
    if (!manifest) {
      errors.push(`invalid or missing manifest: modules/${moduleDir}/manifest.json`);
      continue;
    }
    const moduleId = String(manifest.moduleId ?? "").trim();
    if (!moduleId) {
      errors.push(`manifest missing moduleId: modules/${moduleDir}/manifest.json`);
      continue;
    }
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    if (moduleId !== "core") {
      for (const artifact of artifacts) {
        const artifactPath = String(artifact?.path ?? "");
        if (CORE_ONLY_ARTIFACT_PATTERNS.some((pattern) => pattern.test(artifactPath))) {
          errors.push(`non-core module ${moduleId} includes core-only artifact: ${artifactPath}`);
        }
      }
    }
  }

  return errors;
};

export const getDefaultSlicesRoot = (repoRoot = process.cwd()) =>
  resolvePath(repoRoot, "apps/runtime/slices");
