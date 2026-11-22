// "Save offline" (PAR-OFFL-01/02/03): the shared keeping loop (`createParrotKeeping` in `@space/parrot-core`,
// the phone runs the same one) with the kept list in `kept.json` and the songs in `@space/parrot-ingest`'s sealed kept
// files. A desktop has no metered connection to wait out, so "Wi-Fi only" reads as "whenever online" here (agent
// reading in PAR-OFFL-03): the kept files have no `mayDownload` gate.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createParrotKeeping, keptTrackIds, type KeptStatus, type ParrotKeeping } from "@space/parrot-core";
import { getParrotFile, parrotKeepLibrary, type ParrotKeptFiles, type ParrotLibraryDb } from "@space/parrot-ingest";
import type { ParrotKeptSizes } from "../shared/ipc";

/** The computer's Manage offline content removes whole kept items (`unkeep`), never single songs (`leaveOut`, phone only). */
export type DesktopKeeping = Omit<ParrotKeeping, "keptFileId" | "notify" | "leaveOut"> & {
  /** The kept file to play for a song file, when the song is kept here (it may be another copy than the one asked). */
  playableFileId(fileId: string): string;
  /** Whether the song plays from this computer (no connection used, so no copy to pick: PAR-PLAY-02). */
  isKept(trackId: string): boolean;
  /** Settings › Manage offline content (OFFL-MANAGE-01): each kept item's song files, and the bytes each kept file takes here. */
  sizes(): ParrotKeptSizes;
};

export const createDesktopKeeping = async (input: {
  dir: string;
  files: ParrotKeptFiles;
  library: () => ParrotLibraryDb | null;
  /** Called when the kept list or a download changed (main sends it to the window). */
  onChange: (status: KeptStatus) => void;
  /** Called when the kept list goes from empty to not empty or back (main keeps or drops its library copy). */
  onKeptAny?: (any: boolean) => void;
  now?: () => number;
  log: (line: string) => void;
}): Promise<DesktopKeeping> => {
  const statePath = join(input.dir, "kept.json");
  const keeping = await createParrotKeeping({
    storage: {
      read: () => fs.readFile(statePath, "utf8"),
      write: async (text) => {
        await fs.mkdir(input.dir, { recursive: true });
        await fs.writeFile(`${statePath}.tmp`, text);
        await fs.rename(`${statePath}.tmp`, statePath);
      },
      remove: () => fs.rm(statePath, { force: true }),
    },
    files: {
      fileIds: () => input.files.fileIds(),
      keep: async (row, cancelled) => {
        const db = input.library();
        const file = db ? getParrotFile(db, row.id) : null;
        if (!file) {
          input.log(`[kept] file ${row.id} is not in the library any more`);
          return false;
        }
        return input.files.keep(file, cancelled);
      },
      remove: (ids) => input.files.remove(ids),
      clear: () => input.files.clear(),
    },
    library: () => {
      const db = input.library();
      return db ? parrotKeepLibrary(db) : null;
    },
    onChange: input.onChange,
    onKeptAny: input.onKeptAny,
    now: input.now,
    log: input.log,
  });
  return {
    status: keeping.status,
    keep: keeping.keep,
    unkeep: keeping.unkeep,
    choices: keeping.choices,
    reconcile: keeping.reconcile,
    clear: keeping.clear,
    playableFileId: (fileId) => {
      const db = input.library();
      const file = db ? getParrotFile(db, fileId) : null;
      return (file && keeping.keptFileId(file.trackId)) ?? fileId;
    },
    isKept: (trackId) => keeping.keptFileId(trackId) != null,
    sizes: () => {
      const status = keeping.status();
      const db = input.library();
      const library = db ? parrotKeepLibrary(db) : null;
      const fileOf = new Map(status.songs.map((song) => [song.trackId, song.fileId]));
      const entries = status.entries.map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        fileIds: library
          ? [...new Set(keptTrackIds(library, entry).flatMap((trackId) => fileOf.get(trackId) ?? []))].sort()
          : [],
      }));
      const bytes = Object.fromEntries(input.files.fileIds().map((fileId) => [fileId, input.files.storedBytes(fileId)]));
      return { entries, bytes };
    },
  };
};
