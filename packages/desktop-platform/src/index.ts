import type { DesktopPlatform } from "@space/desktop-platform-contract";
import { platform as linux } from "@space/desktop-platform-linux";
import { platform as macos } from "@space/desktop-platform-macos";
import { platform as windows } from "@space/desktop-platform-windows";
import { HOST_PLATFORM_IDS } from "@space/desktop-platform-contract/host";

export type * from "@space/desktop-platform-contract";
export {
  advertisedHardwareEncoders,
  bundledBinDirs,
  depsDirName,
  firstExisting,
  normalizeGpuVendor,
  pickHardwareEncoder,
} from "@space/desktop-platform-contract";
export { getHostPlatformId } from "@space/desktop-platform-contract/host";

let forced: DesktopPlatform | null = null;

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
