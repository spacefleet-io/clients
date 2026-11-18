import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getUserDataPath } from "./userDataPath";

const DEFAULT_API_BASE_URL = "https://api.spacebadger.io";
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

export const getCustomApiBaseUrl = (): string | null => {
  const config = readRuntimeConfig();
  return normalizeApiBaseUrl(config.customApiBaseUrl);
};

export const getApiBaseUrl = (): string => {
  const fromEnv = normalizeApiBaseUrl(process.env.SF_API_BASE_URL);
  if (fromEnv) return fromEnv;
  const custom = getCustomApiBaseUrl();
  if (custom) return custom;
  return DEFAULT_API_BASE_URL;
};

export const setCustomApiBaseUrl = (value: string | null): { apiBaseUrl: string; customApiBaseUrl: string | null } => {
  const normalized = normalizeApiBaseUrl(value);
  const config = readRuntimeConfig();
  config.customApiBaseUrl = normalized;
  writeRuntimeConfig(config);

  const apiBaseUrl = getApiBaseUrl();
  return {
    apiBaseUrl,
    customApiBaseUrl: normalized,
  };
};

export const getDefaultApiBaseUrl = () => DEFAULT_API_BASE_URL;
