import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { Env, PathLayer } from "@space/desktop-platform-contract";
import { readEnv } from "./env";
import { restrictFileToOwnerWindows } from "./ownerOnly";

/** `%LOCALAPPDATA%`, else `~\AppData\Local`. */
const localAppData = (env: Env): string => readEnv(env, "LOCALAPPDATA")?.trim() || win32.join(homedir(), "AppData", "Local");

export const windowsPaths: PathLayer = {
  runtimeDataDir: (env = process.env) =>
    readEnv(env, "SPACEFLEET_RUNTIME_DATA_DIR")?.trim() || win32.join(localAppData(env), "SpaceFleet", "runtime"),
  // %LOCALAPPDATA% is persistent and private to the user (its ACL): creating the dir is all it takes.
  prepareRuntimeDataDir: ({ env = process.env } = {}) => {
    const dir = windowsPaths.runtimeDataDir(env);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  restrictFileToOwner: (path) => restrictFileToOwnerWindows(path),
  // The dir sits under %LOCALAPPDATA% (user-private by its ACL); the secret files in it get their own ACL.
  restrictDirToOwner: () => {},
  userDataBase: (env = process.env) => localAppData(env),
  // Existing installs keep their directory.
  appUserDataDir: ({ appData, legacyDir }) => win32.join(appData, ...legacyDir),
  // The Recycle Bin renames what it keeps ($R…): no plain path tells a deleted file apart.
  trashPaths: () => [],
};
