import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decryptBytesToBytes, encryptBytesToBytes } from "@space/library-db-runtime/crypto";
import { downloadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import { TRACK_FILES_SQL, toTrackFileRow, type KeepLibrary, type RawTrackFileRow } from "@space/parrot-core";
import { listParrotPlaylists, type ParrotLibraryDb, type ParrotLibraryFile } from "./library";

/**
 * Songs kept on the computer for offline play (PAR-OFFL-03). A kept file is its SFV1 chunk objects exactly as stored,
 * still sealed with the library key (as Badger's phone downloads, OFFL-FILE-03, and the desktop's kept covers), under
 * `dir/objects/<sha256(objectKey)>.sealed`; `dir/files.json` lists the files whose every chunk is here. The player
 * reads a kept chunk from disk before asking the storage. A copy of the library itself, sealed the same way, lets the
 * app open the library with no connection.
 */
export type ParrotKeptFiles = {
  /** Ids of the files fully on this computer. */
  fileIds(): string[];
  /** Bytes a kept file takes (its sealed chunks). */
  storedBytes(fileId: string): number;
  /** Downloads the chunks not here yet, then lists the file as kept. `stop()` true = give up quietly (unkept meanwhile). */
  keep(file: ParrotLibraryFile, stop: () => boolean): Promise<boolean>;
  /** Forgets files; a chunk another kept file still lists stays. */
  remove(fileIds: readonly string[]): Promise<void>;
  /** A kept chunk's sealed bytes, or null when it is not kept here. */
  readSealed(objectKey: string): Promise<Uint8Array | null>;
  /** Forgets everything kept (sign-out). */
  clear(): Promise<void>;
};

type Manifest = Record<string, { objectKeys: string[]; bytes: number }>;

const objectFile = (dir: string, objectKey: string) => path.join(dir, "objects", `${crypto.createHash("sha256").update(objectKey).digest("hex")}.sealed`);

export const createParrotKeptFiles = async (input: {
  dir: string;
  token: () => string;
  clientType: string;
  appId: Parameters<typeof downloadStorageObjectViaTunnel>[3];
  download?: typeof downloadStorageObjectViaTunnel;
  log?: (message: string) => void;
}): Promise<ParrotKeptFiles> => {
  const download = input.download ?? downloadStorageObjectViaTunnel;
  const log = input.log ?? (() => {});
  const manifestPath = path.join(input.dir, "files.json");
  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    manifest = {};
  }
  const save = async () => {
    await fs.mkdir(input.dir, { recursive: true });
    const temp = `${manifestPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(manifest));
    await fs.rename(temp, manifestPath);
  };

  return {
    fileIds: () => Object.keys(manifest),
    storedBytes: (fileId) => manifest[fileId]?.bytes ?? 0,
    keep: async (file, stop) => {
      await fs.mkdir(path.join(input.dir, "objects"), { recursive: true });
      let bytes = 0;
      for (const chunk of file.chunks) {
        if (stop()) return false;
        const target = objectFile(input.dir, chunk.objectKey);
        const size = await fs.stat(target).then(
          (stat) => stat.size,
          () => -1
        );
        if (size >= 0) {
          bytes += size;
          continue;
        }
        // `export` downloads stay allowed once the account is unpaid, as Badger's downloads (#145).
        const sealed = await download(input.token(), chunk.objectKey, { clientType: input.clientType, purpose: "export" }, input.appId);
        const temp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temp, sealed);
        await fs.rename(temp, target);
        bytes += sealed.length;
      }
      if (stop()) return false;
      manifest[file.id] = { objectKeys: file.chunks.map((chunk) => chunk.objectKey), bytes };
      await save();
      log(`[kept] file ${file.id} kept: ${file.chunks.length} chunks, ${bytes} bytes`);
      return true;
    },
    remove: async (fileIds) => {
      const doomed = fileIds.filter((id) => manifest[id]);
      if (doomed.length === 0) return;
      const keys = new Set(doomed.flatMap((id) => manifest[id]!.objectKeys));
      for (const id of doomed) delete manifest[id];
      for (const entry of Object.values(manifest)) for (const key of entry.objectKeys) keys.delete(key);
      await save();
      await Promise.all([...keys].map((key) => fs.rm(objectFile(input.dir, key), { force: true })));
      log(`[kept] removed ${doomed.length} files, ${keys.size} chunks deleted`);
    },
    readSealed: async (objectKey) => {
      try {
        return new Uint8Array(await fs.readFile(objectFile(input.dir, objectKey)));
      } catch {
        return null;
      }
    },
    clear: async () => {
      manifest = {};
      await fs.rm(input.dir, { recursive: true, force: true });
    },
  };
};

/** Seals the library's bytes with the library key into `dir`, so it opens with no connection (PAR-OFFL-03). */
export const saveParrotLibraryCopy = async (dir: string, keyBase64: string, dbBytes: Uint8Array, version: number | null) => {
  await fs.mkdir(dir, { recursive: true });
  const sealed = await encryptBytesToBytes(keyBase64, dbBytes);
  const target = path.join(dir, "library.sealed");
  await fs.writeFile(`${target}.tmp`, sealed);
  await fs.rename(`${target}.tmp`, target);
  await fs.writeFile(path.join(dir, "library.json"), JSON.stringify({ version }));
};

/** The library copy kept here, opened with the library key; null when none is kept or it cannot be opened. */
export const openParrotLibraryCopy = async (dir: string, keyBase64: string): Promise<{ dbBytes: Uint8Array; version: number | null } | null> => {
  try {
    const sealed = new Uint8Array(await fs.readFile(path.join(dir, "library.sealed")));
    const { version } = JSON.parse(await fs.readFile(path.join(dir, "library.json"), "utf8")) as { version: number | null };
    return { dbBytes: await decryptBytesToBytes(keyBase64, sealed), version };
  } catch {
    return null;
  }
};

/** The library as the keeping rules read it (`planKept` in `@space/parrot-core`). */
export const parrotKeepLibrary = (db: ParrotLibraryDb): KeepLibrary => {
  const playlists = new Map(listParrotPlaylists(db).map((playlist) => [playlist.id, playlist.trackIds]));
  const albumTracks = db.prepare("SELECT id FROM tracks WHERE album_id = ?");
  const trackFiles = db.prepare(TRACK_FILES_SQL);
  return {
    albumTrackIds: (albumId) => (albumTracks.all(albumId) as Array<{ id: string }>).map((row) => row.id),
    playlistTrackIds: (playlistId) => playlists.get(playlistId) ?? [],
    trackFiles: (trackId) => (trackFiles.all(trackId) as RawTrackFileRow[]).map(toTrackFileRow),
  };
};
