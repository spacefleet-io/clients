import { existsSync, mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createRequire } from "node:module";

const moduleRequire = createRequire(import.meta.url);

const resolveElectronUserDataPath = (): string | null => {
  try {
    const electron = moduleRequire("electron") as { app?: { getPath?: (name: string) => string } };
    const value = electron?.app?.getPath?.("userData");
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  } catch {
    // Non-electron runtime.
  }
  return null;
};

export const getUserDataPath = () => {
  const explicit = process.env.SF_USER_DATA_PATH?.trim();
  if (explicit) return explicit;
  const electronUserData = resolveElectronUserDataPath();
  if (electronUserData) return electronUserData;
  return joinPath(process.cwd(), ".sf-user-data");
};

export const ensureUserDataPath = () => {
  const dir = getUserDataPath();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

