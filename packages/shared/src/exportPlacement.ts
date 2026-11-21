// ---------------------------------------------------------------------------
// Move a finished export into the user's folder under a name nobody holds
// (OFFL-FILE-02, #618) without ever overwriting a file (OFFL-SAFE-01: the
// final name only ever holds a complete file).
//
// Node-only (fs). The file is built in a staging folder on the same disk as
// `destDir`, then:
//   1. list `destDir`, pick a free name compared without letter case
//      (`resolveOfflineFilenameCollision`);
//   2. hard-link the staged file to that name: `link` fails with EEXIST when
//      the name appeared since the listing (another app, another process, a
//      case-only twin on a case-insensitive disk), so we list again and retry;
//   3. on disks without hard links (FAT32/exFAT USB drives, some network
//      shares) claim the name with an exclusive create (`wx`, same EEXIST
//      retry), then rename the staged file over that claim.
// Exports of one runtime are serialised per folder, so two titles finishing
// together never pick the same name even on a case-sensitive Linux disk.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOfflineFilenameCollision } from "./offlineFilename";

export type PlaceExportFileOptions = {
  /** The complete staged file; on the same disk as `destDir`. Gone on success. */
  sourcePath: string;
  destDir: string;
  /** Safe name (OFFL-FILE-02) before any collision suffix. */
  desiredName: string;
  log?: (line: string) => void;
  /** Test seams. */
  readdir?: (dir: string) => Promise<string[]>;
  link?: (existingPath: string, newPath: string) => Promise<void>;
};

const MAX_ATTEMPTS = 20;

// Errors of a disk or OS that cannot hard-link here; anything else (EACCES, ENOSPC, ENOENT) is a real failure.
const NO_HARD_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"]);

const folderQueues = new Map<string, Promise<void>>();

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

export const placeExportFile = async (options: PlaceExportFileOptions): Promise<string> => {
  const { sourcePath, destDir, desiredName } = options;
  const log = options.log ?? (() => {});
  const readdir = options.readdir ?? ((dir: string) => fs.readdir(dir));
  const link = options.link ?? ((from: string, to: string) => fs.link(from, to));

  // One placement at a time per folder in this process. The key ignores letter case: Windows and macOS paths do.
  const key = resolve(destDir).toLowerCase();
  const previous = folderQueues.get(key) ?? Promise.resolve();
  const { promise: done, resolve: release } = Promise.withResolvers<void>();
  const mine = previous.then(() => done);
  folderQueues.set(key, mine);
  await previous;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const name = resolveOfflineFilenameCollision(desiredName, new Set(await readdir(destDir)));
      const target = join(destDir, name);
      try {
        await link(sourcePath, target);
        await fs.rm(sourcePath, { force: true });
        log(`[export-placement] placed via link attempt=${attempt} name=${JSON.stringify(name)}`);
        return target;
      } catch (err) {
        const code = errorCode(err);
        if (code === "EEXIST") {
          log(`[export-placement] name taken since listing, retrying attempt=${attempt} name=${JSON.stringify(name)}`);
          continue;
        }
        if (!code || !NO_HARD_LINK_CODES.has(code)) throw err;
        log(`[export-placement] no hard links here (${code}), claiming ${JSON.stringify(name)} exclusively`);
      }
      try {
        await (await fs.open(target, "wx")).close();
      } catch (err) {
        if (errorCode(err) === "EEXIST") {
          log(`[export-placement] exclusive claim lost, retrying attempt=${attempt} name=${JSON.stringify(name)}`);
          continue;
        }
        throw err;
      }
      try {
        await fs.rename(sourcePath, target);
      } catch (err) {
        await fs.rm(target, { force: true });
        throw err;
      }
      log(`[export-placement] placed via exclusive claim attempt=${attempt} name=${JSON.stringify(name)}`);
      return target;
    }
    throw new Error(`EXPORT_NAME_UNAVAILABLE:${desiredName}`);
  } finally {
    release();
    if (folderQueues.get(key) === mine) folderQueues.delete(key);
  }
};
