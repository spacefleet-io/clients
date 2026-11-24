/**
 * A desktop app's name and Electron userData dir, the same resolution for Badger and Parrot (REL-FAM-03).
 *
 * The release dir is the one the app's existing installs use, so nobody is signed out by an update:
 * - `{ legacyDir }`: the platform layer's choice (Badger): `legacyDir` below appData on Linux and Windows,
 *   `<productName>` on macOS (PLAT-DESK-07).
 * - `{ everyOs }`: that one folder below appData on every OS, macOS included (Parrot: `spaceparrot`, the folder every
 *   Parrot install has used).
 *
 * A development build keeps the same dir with `-dev` appended, and `SF_USER_DATA_PATH` overrides both
 * (`resolveUserDataDir`, PLAT-DESK-14).
 */
import { resolveUserDataDir } from "./userDataDir";

/** The part of the desktop platform layer (`@space/desktop-platform`) the identity needs. */
export type AppIdentityPlatform = {
  paths: { appUserDataDir(options: { appData: string; productName: string; legacyDir: string[] }): string };
  shell: { appName(options: { productName: string; legacyName: string }): string };
};

export type AppIdentityNames = { productName: string; legacyName: string };

export type AppUserDataLocation = { legacyDir: readonly string[] } | { everyOs: string };

/** What an app declares once; `resolveAppIdentity` turns it into the name and dir for this computer and build. */
export type AppIdentitySpec = { names: AppIdentityNames; userData: AppUserDataLocation };

export type AppIdentity = { name: string; userDataDir: string };

export const resolveAppIdentity = (input: AppIdentitySpec & {
  platform: AppIdentityPlatform;
  appData: string;
  env: NodeJS.ProcessEnv;
  devBuild: boolean;
}): AppIdentity => {
  const { platform, appData, names, userData } = input;
  // `everyOs` goes through the layer too, so the path is joined the way the OS joins it: one folder named the same as
  // the legacy dir (Linux, Windows) and as the product (macOS) is that folder on every OS.
  const releaseDir = "everyOs" in userData
    ? platform.paths.appUserDataDir({ appData, productName: userData.everyOs, legacyDir: [userData.everyOs] })
    : platform.paths.appUserDataDir({ appData, productName: names.productName, legacyDir: [...userData.legacyDir] });
  return {
    name: platform.shell.appName(names),
    userDataDir: resolveUserDataDir({ releaseDir, env: input.env, devBuild: input.devBuild }),
  };
};
