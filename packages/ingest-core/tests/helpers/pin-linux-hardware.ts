import { platform as linux } from "@space/desktop-platform-linux";

/**
 * The VAAPI / QSV / NVENC recipes, probes and CPU fallbacks in mediaProcessor
 * are OS-neutral code fed by Linux DATA: the Linux platform's encoder policy
 * and its `deviceFor("vaapi")` render-node lookup (which honours
 * `SF_VAAPI_DEVICE`). Tests of that code pin the REAL Linux hardware layer
 * (not a mock, not the dev host's own) so they hold on every host OS.
 *
 * Dynamic import of `@space/desktop-platform` (a module-loading boundary, not a
 * runtime-selected path): after `vi.resetModules()` it pins the SAME instance
 * the next `import("../src/mediaProcessor")` resolves. Call it in `beforeEach`.
 */
export const pinLinuxHardware = async (): Promise<void> => {
  const { getDesktopPlatform, setDesktopPlatformForTests } = await import("@space/desktop-platform");
  setDesktopPlatformForTests({ ...getDesktopPlatform(), hardware: linux.hardware });
};
