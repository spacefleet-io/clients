/**
 * ACCT-PAIR-07: where Badger and Parrot on one computer find each other. One folder per user (and per kind of build),
 * shared by both apps and readable by this user only: each signed-in app's status file, the per-user secret and, on
 * Linux and macOS, each app's socket. On Windows each app listens on a named pipe whose name is derived from that
 * folder, so a development build never answers a release build.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SpaceAppId } from "@space/shared/appScope";

/** The hidden start: the sister app was launched only to answer one same-device sign-in. */
export const SIBLING_SIGN_IN_ARG = "--sibling-sign-in";

/** The platform layer's owner-only helpers (`PathLayer.restrictFileToOwner` / `restrictDirToOwner`). */
export type SiblingOwnerOnly = { file: (path: string) => void; dir: (path: string) => void };

export type SiblingPlace = {
  dir: string;
  ownerOnly: SiblingOwnerOnly;
  /**
   * Listen on a named pipe instead of a socket file in `dir` (Windows). The app says so from its platform layer
   * (`getDesktopPlatform().id`): this package never looks at the OS itself.
   */
  namedPipe: boolean;
};

/** POSIX owner-only modes, for callers without a platform layer at hand. */
export const posixOwnerOnly: SiblingOwnerOnly = {
  file: (path) => chmodSync(path, 0o600),
  dir: (path) => chmodSync(path, 0o700),
};

/** `<per-user data folder>/SpaceFleet/sibling`, `sibling-dev` for development builds; `SF_SIBLING_DIR` wins (tests). */
export const resolveSiblingDir = (options: {
  userDataBase: (env: NodeJS.ProcessEnv) => string;
  dev: boolean;
  env?: NodeJS.ProcessEnv;
}): string => {
  const env = options.env ?? process.env;
  const forced = env.SF_SIBLING_DIR?.trim();
  if (forced) return forced;
  return join(options.userDataBase(env), "SpaceFleet", options.dev ? "sibling-dev" : "sibling");
};

export const siblingSocketPath = (place: SiblingPlace, app: SpaceAppId): string => {
  if (!place.namedPipe) return join(place.dir, `${app}.sock`);
  const scope = createHash("sha256").update(place.dir.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\spacefleet-sibling-${app}-${scope}`;
};

export const isSiblingSignInLaunch = (argv: readonly string[]): boolean => argv.includes(SIBLING_SIGN_IN_ARG);

/**
 * How the sister app starts this app: the AppImage file rather than its temporary mount (gone once the app quits),
 * and the app folder or script after the Electron binary in a development run.
 */
export const siblingLaunchTarget = (input: {
  execPath: string;
  argv: readonly string[];
  defaultApp: boolean;
  env: NodeJS.ProcessEnv;
}): { exePath: string; args: string[] } => {
  const appImage = input.env.APPIMAGE?.trim();
  if (appImage) return { exePath: appImage, args: [] };
  const script = input.defaultApp ? input.argv.slice(1).find((arg) => !arg.startsWith("-")) : undefined;
  return { exePath: input.execPath, args: script ? [script] : [] };
};

export const prepareSiblingDir = (place: SiblingPlace): void => {
  mkdirSync(place.dir, { recursive: true, mode: 0o700 });
  place.ownerOnly.dir(place.dir);
};

/**
 * Writes `content` into a new owner-only temporary file next to `path`, flushed to disk, and returns its path; the
 * caller renames or links it into place.
 */
export const writeOwnerOnlyTemp = (place: SiblingPlace, path: string, content: string): string => {
  prepareSiblingDir(place);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    place.ownerOnly.file(temp);
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(fd);
  return temp;
};

/** Owner-only, replaced in one step: a reader never sees half a file. */
export const writeOwnerOnlyFile = (place: SiblingPlace, path: string, content: string): void => {
  const temp = writeOwnerOnlyTemp(place, path, content);
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
};
