import { chmodSync, statSync } from "node:fs";

/**
 * The POSIX half of `PathLayer.restrictFileToOwner` / `restrictDirToOwner`,
 * shared by the Linux and macOS layers (Windows has its own, ACL based).
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const GROUP_OTHER_BITS = 0o077;

/** chmod 0600, then read the mode back: a filesystem that ignores chmod (FAT, some network shares) must not pass. */
export const restrictFileToOwnerPosix = (path: string): void => {
  chmodSync(path, FILE_MODE);
  const mode = statSync(path).mode & 0o777;
  if ((mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(`cannot make ${path} owner-only: its mode is ${mode.toString(8)} after chmod 600`);
  }
};

/** chmod 0700 only when group/other can reach the directory, then read the mode back. */
export const restrictDirToOwnerPosix = (path: string): void => {
  if ((statSync(path).mode & GROUP_OTHER_BITS) !== 0) chmodSync(path, DIR_MODE);
  const mode = statSync(path).mode & 0o777;
  if ((mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(`cannot make ${path} owner-only: its mode is ${mode.toString(8)} after chmod 700`);
  }
};
