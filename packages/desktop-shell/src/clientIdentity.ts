import type { SpaceAppId } from "@space/shared/appScope";
import type { ClientIdentity } from "@space/shared/appVersion";
import { linuxInstallSource, withInstallSource } from "@space/shared/installSource";

/**
 * REL-CD-29: the identity a desktop app (Badger, Parrot) states on every API call, worked out once by the main process
 * and handed to the window through this synchronous channel (read once by the preload), so both processes state the
 * same build.
 */
export const CLIENT_IDENTITY_CHANNEL = "sf-client-identity";

const RELEASE_VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]*)?$/;

/**
 * The system a desktop app runs on, as the platform layer names it (`getDesktopPlatform().id`, PLAT-DESK-03): the app's
 * main process asks the platform layer and hands the id in, so nothing here looks at the OS itself.
 */
export type DesktopSystem = "linux" | "windows" | "macos";

/**
 * `<app>/desktop/<version>` for an installed build; the version carries how it was installed: on Linux the packaging
 * (`parrot/desktop/0.1.3+flatpak`, `+appimage`, `+system`), on Windows and macOS the system (`+windows`, `+macos`,
 * WEB-ADMIN-39), so the admin site tells the three apart. An unpackaged run (a dev or e2e launch, where Electron reports
 * "0.0" or the workspace's version) states nothing: it is never refused for its version and never counted.
 */
export const desktopClientIdentity = (build: {
  app: SpaceAppId;
  version: string;
  packaged: boolean;
  os: DesktopSystem;
  env: Readonly<Record<string, string | undefined>>;
}): ClientIdentity | null => {
  if (!build.packaged || !RELEASE_VERSION.test(build.version)) return null;
  const source = build.os === "linux" ? linuxInstallSource(build.env) : build.os;
  return { app: build.app, platform: "desktop", version: withInstallSource(build.version, source) };
};
