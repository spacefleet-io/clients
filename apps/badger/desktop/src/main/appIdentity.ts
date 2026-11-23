/**
 * The app's name and Electron userData dir, per OS through the platform layer.
 *
 * The product is "Badger" on every OS. Linux and Windows keep their data in
 * `<appData>/@sf/desktop` (the dir existing installs use; the Linux safeStorage
 * keyring entry "<name> Safe Storage" is keyed by the app name). macOS keeps it
 * in `~/Library/Application Support/Badger` (REL-MAC-05, PLAT-DESK-07); Macs that
 * ran a pre-2026-11-12 "SpaceBadger" test build sign in again (no Mac release
 * existed before). A development build (`electron-vite dev`, test builds) keeps its data next to it, in the same dir
 * with `-dev` appended (`@sf/desktop-dev`, `Badger-dev`): it talks to another server than the release build, and
 * sharing the dir mixed the two servers' sessions and libraries (PLAT-DESK-14). `SF_USER_DATA_PATH` overrides the dir
 * on every OS (lanes, e2e).
 */
import type { DesktopPlatform } from "@space/desktop-platform";
import { resolveUserDataDir } from "@space/desktop-shell/main-shell";

export const APP_NAMES = { productName: "Badger", legacyName: "Badger" } as const;
export const LEGACY_USER_DATA_DIR = ["@sf", "desktop"];

export const resolveAppIdentity = (
  platform: Pick<DesktopPlatform, "paths" | "shell">,
  appData: string,
  env: NodeJS.ProcessEnv,
  devBuild: boolean,
): { name: string; userDataDir: string } => {
  const releaseDir = platform.paths.appUserDataDir({
    appData,
    productName: APP_NAMES.productName,
    legacyDir: LEGACY_USER_DATA_DIR,
  });
  return {
    name: platform.shell.appName(APP_NAMES),
    userDataDir: resolveUserDataDir({ releaseDir, env, devBuild }),
  };
};
