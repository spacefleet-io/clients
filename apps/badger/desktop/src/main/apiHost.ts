import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { currentDesktopBuildEnv, isDesktopDevBuild } from "../shared/devBuild";
import { getUserDataPath } from "./userDataPath";

const DEV_API_BASE_URL = "http://127.0.0.1:3000";
const CONFIG_FILENAME = "runtime-config.json";

type RuntimeConfig = {
  customApiBaseUrl?: string | null;
};

const normalizeApiBaseUrl = (value: string | null | undefined): string | null => {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const getConfigPath = () => join(getUserDataPath(), CONFIG_FILENAME);

const readRuntimeConfig = (): RuntimeConfig => {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as RuntimeConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
};

const writeRuntimeConfig = (config: RuntimeConfig) => {
  const configPath = getConfigPath();
  try {
    if (!existsSync(dirname(configPath))) return;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch {
    // Ignore write errors; runtime override still works for current process.
  }
};

const resolveDefaultApiBaseUrl = () => {
  if (process.env.SF_DEV_SERVER_URL?.trim()) {
    return DEV_API_BASE_URL;
  }
  return PRODUCTION_API_BASE_URL;
};

/**
 * Whether this build has the server picker (ACCT-AUTH-09): development builds only, the same build-time switch that
 * makes it trust every environment's ticket key (META-ANON-07). A release build talks to the production API.
 */
export const serverPickerAllowed = (): boolean => isDesktopDevBuild(currentDesktopBuildEnv());

/** The picked server, or null. A release build ignores a stored value (a stale one from an old dev install included). */
export const getCustomApiBaseUrl = (): string | null => {
  if (!serverPickerAllowed()) return null;
  const config = readRuntimeConfig();
  return normalizeApiBaseUrl(config.customApiBaseUrl);
};

export const getApiBaseUrl = (): string => {
  const fromEnv = normalizeApiBaseUrl(process.env.SF_API_BASE_URL);
  if (fromEnv) return fromEnv;
  const custom = getCustomApiBaseUrl();
  if (custom) return custom;
  return resolveDefaultApiBaseUrl();
};

export const initializeApiBaseUrl = (): string => {
  const baseUrl = getApiBaseUrl();
  // Propagate the resolved URL so that shared packages (e.g. @space/library-db-runtime)
  // that read SF_API_BASE_URL also use the correct dev/prod API.
  if (!process.env.SF_API_BASE_URL?.trim()) {
    process.env.SF_API_BASE_URL = baseUrl;
  }
  return baseUrl;
};

export const setCustomApiBaseUrl = (value: string | null): { apiBaseUrl: string; customApiBaseUrl: string | null } => {
  return setCustomHosts({ apiBaseUrl: value });
};

export const setCustomHosts = (values: {
  apiBaseUrl?: string | null;
}): {
  apiBaseUrl: string;
  customApiBaseUrl: string | null;
} => {
  // A release build has no picker: nothing is stored, and the answer is the production API it keeps using.
  if (serverPickerAllowed()) {
    const normalizedApi = values.apiBaseUrl === undefined ? undefined : normalizeApiBaseUrl(values.apiBaseUrl);
    const config = readRuntimeConfig();
    if (normalizedApi !== undefined) {
      config.customApiBaseUrl = normalizedApi;
    }
    writeRuntimeConfig(config);
  }

  const apiBaseUrl = getApiBaseUrl();
  process.env.SF_API_BASE_URL = apiBaseUrl;
  return {
    apiBaseUrl,
    customApiBaseUrl: getCustomApiBaseUrl(),
  };
};

/**
 * Metadata service base URL set by the environment (`SF_METADATA_URL`: tests, a self-hosted service), or null for
 * the renderer's own default (`resolveMetadataUrl`: build-time `VITE_METADATA_URL`, else the metadata service of the API the tickets come from, META-ANON-08).
 */
export const getMetadataUrlOverride = (): string | null => normalizeApiBaseUrl(process.env.SF_METADATA_URL);

export const getDefaultApiBaseUrl = () => PRODUCTION_API_BASE_URL;
export const getResolvedDefaultApiBaseUrl = () => resolveDefaultApiBaseUrl();
