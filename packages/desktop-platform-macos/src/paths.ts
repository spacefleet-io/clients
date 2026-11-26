import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PathLayer } from "@space/desktop-platform-contract";
import { restrictDirToOwnerPosix, restrictFileToOwnerPosix } from "@space/desktop-platform-contract";

/** `~/Library/Application Support`: where macOS wants app-created data that must persist (PLAT-DESK-07). */
const applicationSupport = () => join(homedir(), "Library", "Application Support");

export const macosPaths: PathLayer = {
  // Persistent so the runtime's requeued jobs survive a reboot (RT-LIFE-04, PLAT-DESK-07).
  runtimeDataDir: (env = process.env) => env.SPACEFLEET_RUNTIME_DATA_DIR?.trim() || join(applicationSupport(), "SpaceFleet", "runtime"),
  // Owner-only: it holds keys and databases. macOS never had another default location, so nothing is carried over.
  prepareRuntimeDataDir: ({ env = process.env } = {}) => {
    const dir = macosPaths.runtimeDataDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  },
  restrictFileToOwner: restrictFileToOwnerPosix,
  restrictDirToOwner: restrictDirToOwnerPosix,
  userDataBase: () => applicationSupport(),
  // Electron's userData is `<appData>/<product name>`: ~/Library/Application Support/Badger (PLAT-DESK-07). macOS has
  // no earlier install whose directory must be kept.
  appUserDataDir: ({ appData, productName }) => join(appData, productName),
  trashPaths: (filename) => [join(homedir(), ".Trash", basename(filename))],
};
