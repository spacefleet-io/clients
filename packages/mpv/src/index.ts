import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type Env = Record<string, string | undefined>;

type ResolveOptions = {
  appRoot?: string;
  cwd?: string;
  env?: Env;
};

const getEnv = (options?: ResolveOptions) => options?.env ?? process.env;

const getCwd = (options?: ResolveOptions) => options?.cwd ?? process.cwd();

const resolveFromAncestors = (start: string, relativePath: string, depth = 5) => {
  let current = start;
  for (let i = 0; i < depth; i += 1) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

export const getMpvPackageRoot = () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "..", "..");
};

export const getMpvUiResourcesRoot = () => path.join(getMpvPackageRoot(), "resources");

const resolveFirstExisting = (candidates: string[]) => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
};

export const resolveMpvOscScript = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_OSC_SCRIPT?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const cwd = getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "osc", "sf.lua"),
    path.join(appRoot, "resources", "mpv", "osc", "sf.lua"),
    path.join(appRoot, "..", "resources", "mpv", "osc", "sf.lua"),
    path.join(getMpvUiResourcesRoot(), "osc", "sf.lua"),
    path.join(cwd, "packages", "mpv", "resources", "osc", "sf.lua"),
    resolveFromAncestors(cwd, path.join("packages", "mpv", "resources", "osc", "sf.lua")),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export const resolveMpvOscSelectScript = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_OSC_SELECT_SCRIPT?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const cwd = getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "osc", "sf-select.lua"),
    path.join(appRoot, "resources", "mpv", "osc", "sf-select.lua"),
    path.join(appRoot, "..", "resources", "mpv", "osc", "sf-select.lua"),
    path.join(getMpvUiResourcesRoot(), "osc", "sf-select.lua"),
    path.join(cwd, "packages", "mpv", "resources", "osc", "sf-select.lua"),
    resolveFromAncestors(cwd, path.join("packages", "mpv", "resources", "osc", "sf-select.lua")),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export const resolveMpvTog4in1Script = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_OSC_TOG4IN1_SCRIPT?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const cwd = getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "osc", "tog4in1", "tog4in1.lua"),
    path.join(appRoot, "resources", "mpv", "osc", "tog4in1", "tog4in1.lua"),
    path.join(appRoot, "..", "resources", "mpv", "osc", "tog4in1", "tog4in1.lua"),
    path.join(getMpvUiResourcesRoot(), "osc", "tog4in1", "tog4in1.lua"),
    path.join(cwd, "packages", "mpv", "resources", "osc", "tog4in1", "tog4in1.lua"),
    resolveFromAncestors(cwd, path.join("packages", "mpv", "resources", "osc", "tog4in1", "tog4in1.lua")),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export const resolveMpvTog4in1FontsDir = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_OSC_TOG4IN1_FONTS?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const cwd = getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "osc", "tog4in1", "fonts"),
    path.join(appRoot, "resources", "mpv", "osc", "tog4in1", "fonts"),
    path.join(appRoot, "..", "resources", "mpv", "osc", "tog4in1", "fonts"),
    path.join(getMpvUiResourcesRoot(), "osc", "tog4in1", "fonts"),
    path.join(cwd, "packages", "mpv", "resources", "osc", "tog4in1", "fonts"),
    resolveFromAncestors(cwd, path.join("packages", "mpv", "resources", "osc", "tog4in1", "fonts")),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export const resolveMpvInputConf = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_INPUT_CONF?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const cwd = getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "osc", "input.conf"),
    path.join(appRoot, "resources", "mpv", "osc", "input.conf"),
    path.join(appRoot, "..", "resources", "mpv", "osc", "input.conf"),
    path.join(getMpvUiResourcesRoot(), "osc", "input.conf"),
    path.join(cwd, "packages", "mpv", "resources", "osc", "input.conf"),
    resolveFromAncestors(cwd, path.join("packages", "mpv", "resources", "osc", "input.conf")),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export const resolveMpvIcon = (options?: ResolveOptions) => {
  const env = getEnv(options);
  const fromEnv = env.SF_MPV_ICON?.trim();
  const appRoot = env.SF_APP_ROOT?.trim() ?? options?.appRoot ?? getCwd(options);
  const candidates = [
    fromEnv,
    // Packaged: SF_APP_ROOT is <resources>/app.asar; extraResources sit beside it.
    path.join(appRoot, "..", "mpv", "icons", "spacebadger.png"),
    path.join(appRoot, "resources", "mpv", "icons", "spacebadger.png"),
    path.join(appRoot, "..", "resources", "mpv", "icons", "spacebadger.png"),
    path.join(getMpvUiResourcesRoot(), "icons", "spacebadger.png"),
    path.join(getCwd(options), "packages", "mpv", "resources", "icons", "spacebadger.png"),
  ].filter(Boolean) as string[];
  return resolveFirstExisting(candidates);
};

export * from "./external";
