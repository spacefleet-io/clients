import type { DesktopPlatform, PlatformId } from "@space/desktop-platform-contract";
import { platform as linux } from "@space/desktop-platform-linux";
import { platform as macos } from "@space/desktop-platform-macos";
import { platform as windows } from "@space/desktop-platform-windows";

export type * from "@space/desktop-platform-contract";
export {
  advertisedHardwareEncoders,
  bundledBinDirs,
  depsDirName,
  firstExisting,
  normalizeGpuVendor,
  pickHardwareEncoder,
} from "@space/desktop-platform-contract";

let forced: DesktopPlatform | null = null;

const HOST_PLATFORM_IDS: Partial<Record<NodeJS.Platform, PlatformId>> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

/**
 * The id of the OS this process runs on, WITHOUT requiring an implementation
 * package for it. Use this when only the host's name is needed (e.g. choosing
 * which per-OS setup script applies); it never throws for linux/windows/macos.
 * Throws only for an OS the contract has no id for at all.
 */
export const getHostPlatformId = (platform: NodeJS.Platform = process.platform): PlatformId => {
  const id = HOST_PLATFORM_IDS[platform];
  if (!id) throw new Error(`Unknown host OS "${platform}" (expected linux, win32 or darwin)`);
  return id;
};

/**
 * The platform implementation of the OS this process runs on. This module and
 * the `@space/desktop-platform-*` packages are the ONLY code allowed to look
 * at the OS (`tests/tools/no_os_branching.test.ts` enforces it). Adding an OS
 * is a new implementation package plus one case here.
 *
 * Throws when this OS has no implementation, at the first call rather than at
 * import so a bundle that is only type-checked or inspected still loads.
 */
export const getDesktopPlatform = (): DesktopPlatform => {
  if (forced) return forced;
  switch (process.platform) {
    case "linux":
      return linux;
    case "win32":
      return windows;
    case "darwin":
      return macos;
    default:
      throw new Error(
        `The ${HOST_PLATFORM_IDS[process.platform] ?? process.platform} host OS (process.platform "${process.platform}") ` +
          `has no desktop platform implementation: only linux, windows and macos are implemented, so this OS is unsupported until ` +
          `an @space/desktop-platform-<os> package exists and is registered in packages/desktop-platform/src/index.ts.`,
      );
  }
};

/** Test seam: pin the platform (or `null` to go back to the host's). */
export const setDesktopPlatformForTests = (platform: DesktopPlatform | null): void => {
  forced = platform;
};
