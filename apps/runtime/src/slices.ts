import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { APP_IDS, type AppId } from "./types";

export type RuntimeModuleStatus = "idle" | "running" | "degraded" | "error" | "paused";

export type RuntimeSliceManifest = {
  sliceId: string;
  version: string;
  runtimeApiVersion: string;
  moduleId: "core" | AppId;
  entrypoint: string;
  platform: string;
  artifacts: Array<{ path: string; sha256: string }>;
};

export type RuntimeModuleRecord = {
  app: AppId;
  installed: boolean;
  ready: boolean;
  status: RuntimeModuleStatus;
  compatibility: "compatible" | "incompatible_api" | "invalid_manifest" | "missing_slice";
  sliceId: string | null;
  sliceVersion: string | null;
  loadError: { code: string; message: string } | null;
};

const DEFAULT_MODULE_RECORD = (app: AppId): RuntimeModuleRecord => ({
  app,
  installed: false,
  ready: false,
  status: "idle",
  compatibility: "missing_slice",
  sliceId: null,
  sliceVersion: null,
  loadError: null,
});

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseManifest = (raw: unknown): RuntimeSliceManifest | null => {
  const obj = asObject(raw);
  if (!obj) return null;
  const sliceId = asString(obj.sliceId);
  const version = asString(obj.version);
  const runtimeApiVersion = asString(obj.runtimeApiVersion);
  const moduleId = asString(obj.moduleId);
  const entrypoint = asString(obj.entrypoint);
  const platform = asString(obj.platform);
  const artifactsRaw = Array.isArray(obj.artifacts) ? obj.artifacts : null;
  if (!sliceId || !version || !runtimeApiVersion || !moduleId || !entrypoint || !platform || !artifactsRaw) return null;
  if (!["core", ...APP_IDS].includes(moduleId)) return null;
  const artifacts: Array<{ path: string; sha256: string }> = [];
  for (const artifact of artifactsRaw) {
    const artifactObj = asObject(artifact);
    if (!artifactObj) return null;
    const path = asString(artifactObj.path);
    const sha256 = asString(artifactObj.sha256);
    if (!path || !sha256) return null;
    artifacts.push({ path, sha256 });
  }
  return {
    sliceId,
    version,
    runtimeApiVersion,
    moduleId: moduleId as "core" | AppId,
    entrypoint,
    platform,
    artifacts,
  };
};

export const discoverRuntimeModules = ({
  slicesRoot,
  runtimeApiVersion,
}: {
  slicesRoot: string;
  runtimeApiVersion: string;
}): Map<AppId, RuntimeModuleRecord> => {
  const modules = new Map<AppId, RuntimeModuleRecord>(APP_IDS.map((app) => [app, DEFAULT_MODULE_RECORD(app)]));
  const modulesRoot = joinPath(slicesRoot, "modules");
  if (!existsSync(modulesRoot)) return modules;

  for (const dirent of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = joinPath(modulesRoot, dirent.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let parsed: RuntimeSliceManifest | null = null;
    try {
      parsed = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.moduleId === "core") {
      if (APP_IDS.includes(dirent.name as AppId)) {
        const app = dirent.name as AppId;
        modules.set(app, {
          app,
          installed: true,
          ready: false,
          status: "error",
          compatibility: "invalid_manifest",
          sliceId: null,
          sliceVersion: null,
          loadError: {
            code: "invalid_manifest",
            message: `Invalid module manifest at ${manifestPath}`,
          },
        });
      }
      continue;
    }

    const app = parsed.moduleId;
    const compatible = parsed.runtimeApiVersion === runtimeApiVersion;
    modules.set(app, {
      app,
      installed: true,
      ready: compatible,
      status: compatible ? "idle" : "degraded",
      compatibility: compatible ? "compatible" : "incompatible_api",
      sliceId: parsed.sliceId,
      sliceVersion: parsed.version,
      loadError: compatible
        ? null
        : {
            code: "version_conflict",
            message: `Incompatible runtime API version for ${parsed.sliceId}: expected ${runtimeApiVersion}, got ${parsed.runtimeApiVersion}`,
          },
    });
  }

  return modules;
};
