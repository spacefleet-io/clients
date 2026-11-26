import type { PlatformId } from "./types";

export type { PlatformId };

export const HOST_PLATFORM_IDS: Partial<Record<NodeJS.Platform, PlatformId>> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

/**
 * The id of the OS this process runs on, WITHOUT requiring an implementation
 * package for it. Use this when only the host's name is needed (e.g. choosing
 * which per-OS setup script applies); it never throws for linux/windows/macos.
 * Throws only for an OS the contract has no id for at all. It does no I/O, so a
 * tool that only needs the name (the CLI, DEV-CLI-01) gets it through
 * `@space/desktop-platform-contract/host` without depending on the platform
 * implementations.
 */
export const getHostPlatformId = (platform: NodeJS.Platform = process.platform): PlatformId => {
  const id = HOST_PLATFORM_IDS[platform];
  if (!id) throw new Error(`Unknown host OS "${platform}" (expected linux, win32 or darwin)`);
  return id;
};
