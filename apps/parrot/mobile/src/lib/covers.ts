// Album covers on the phone (PAR-META-04: the picture built into the music files, stored by the import). A cover is a
// sealed object in the user's own storage (PAR-COPY-01): it is downloaded once, opened with the library key and kept
// in the app's private cache folder as a file React Native's <Image> shows. A cover's key is a random name whose
// content never changes, so a kept file never goes stale. Lists never wait for covers: each tile asks for its own
// picture, a few downloads run at a time (`@space/parrot-core`'s cover cache, shared with the web player), and the
// drawn picture shows until it is there. The folder holds at most `maxBytes` (PAR-COPY-01: the local copy is bounded
// by bytes, kept across restarts, cleared on sign-out): a cover shown marks its file as just used once per run, and
// after each download the least recently shown covers past the bound are deleted and forgotten, so the next look
// fetches them from the user's storage again (never looked up anew). The device parts (download, open, files) are
// passed in, so the rules here run in unit tests.

import { createParrotCoverCache, PARROT_COVER_KEEP_BYTES, parrotCoversToDrop, type ParrotKeptCover } from "@space/parrot-core";

export type PhoneCoverFiles = {
  exists(path: string): Promise<boolean>;
  mkdir(dir: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Renames a file, replacing what is there. */
  move(from: string, to: string): Promise<void>;
  /** Deletes a file; a missing one is no error. */
  remove(path: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
  /** The files in `dir` with their size and when each was last used (ms); none when it is missing. */
  list(dir: string): Promise<ParrotKeptCover[]>;
  /** Marks a file as just used. */
  touch(path: string): Promise<void>;
};

export type PhoneCovers = {
  /** The `file://` address of the album cover stored under `objectKey`; null when there is none or it cannot be had. */
  uriFor(objectKey: string | null | undefined): Promise<string | null>;
  /** The address of a cover already kept in this run, answered at once (a tile shows it without fading in); else null. */
  kept(objectKey: string | null | undefined): string | null;
  /** A kept cover whose picture would not load: its file is deleted and the cover fetched once more. */
  refetch(objectKey: string | null | undefined): Promise<string | null>;
  /** Sign-out: every kept cover goes. */
  clear(): Promise<void>;
};

/** The kept file's name: the cover's random key, made safe for a file name. */
export const phoneCoverFileName = (objectKey: string) => `${objectKey.replace(/[^A-Za-z0-9._-]/g, "_")}.img`;

/** The picture a tile shows over its drawing: the album's cover unless that one failed to load (`failedUri`). */
export const phoneCoverFace = (uri: string | null | undefined, failedUri: string | null) => (uri && uri !== failedUri ? uri : null);

export const createPhoneCovers = (input: {
  dir: string;
  /** Bytes of covers kept on disk; defaults to `PARROT_COVER_KEEP_BYTES.phone`. */
  maxBytes?: number;
  files: PhoneCoverFiles;
  download(objectKey: string): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
  log(event: string, payload: Record<string, unknown>): void;
}): PhoneCovers => {
  const pathFor = (objectKey: string) => `${input.dir}/${phoneCoverFileName(objectKey)}`;
  const maxBytes = input.maxBytes ?? PARROT_COVER_KEEP_BYTES.phone;
  // The keys behind the file names seen in this run, so a dropped file's address is forgotten too.
  const keyOf = new Map<string, string>();
  // Files already marked as used in this run: a tile showing again costs no file write.
  const touched = new Set<string>();
  const markShown = (objectKey: string) => {
    if (touched.has(objectKey)) return;
    touched.add(objectKey);
    input.files.touch(pathFor(objectKey)).catch(() => undefined);
  };
  // One trim at a time, after each cover written.
  let trimming = Promise.resolve();
  const trim = (justKept: string) => {
    trimming = trimming.then(async () => {
      const kept = (await input.files.list(input.dir)).filter((file) => file.name.endsWith(".img"));
      const drop = parrotCoversToDrop(kept, maxBytes, phoneCoverFileName(justKept));
      for (const name of drop) {
        await input.files.remove(`${input.dir}/${name}`);
        const objectKey = keyOf.get(name);
        if (objectKey) {
          cache.forget(objectKey);
          touched.delete(objectKey);
        }
      }
      if (drop.length) input.log("parrot.cover.dropped", { kept: kept.length, dropped: drop.length, maxBytes });
    });
    return trimming.catch((error: unknown) =>
      input.log("parrot.cover.trim-failed", { message: error instanceof Error ? error.message : String(error) })
    );
  };
  const cache = createParrotCoverCache({
    async fetch(objectKey) {
      const path = pathFor(objectKey);
      keyOf.set(phoneCoverFileName(objectKey), objectKey);
      if (await input.files.exists(path)) markShown(objectKey);
      else {
        const started = Date.now();
        const sealed = await input.download(objectKey);
        const bytes = await input.open(sealed);
        await input.files.mkdir(input.dir);
        // Written under a temporary name and renamed once whole: a write cut short (the app killed, a full disk)
        // never leaves a broken picture under the name `exists` answers for.
        await input.files.writeBytes(`${path}.part`, bytes);
        await input.files.move(`${path}.part`, path);
        input.log("parrot.cover.kept", { objectKey, sealed: sealed.byteLength, bytes: bytes.byteLength, ms: Date.now() - started });
        await trim(objectKey);
      }
      return `file://${path}`;
    },
    // A failure is tried again on the next look; a kept file is answered at once from then on.
    failed: (objectKey, error) =>
      input.log("parrot.cover.failed", { objectKey, message: error instanceof Error ? error.message : String(error) }),
  });

  return {
    uriFor: (objectKey) => {
      if (!objectKey) return Promise.resolve(null);
      if (cache.peek(objectKey)) markShown(objectKey);
      return cache.load(objectKey);
    },
    kept: (objectKey) => {
      const uri = objectKey ? cache.peek(objectKey) : null;
      if (uri) markShown(objectKey!);
      return uri;
    },
    refetch: async (objectKey) => {
      if (!objectKey) return null;
      cache.forget(objectKey);
      touched.delete(objectKey);
      await input.files.remove(pathFor(objectKey));
      input.log("parrot.cover.refetch", { objectKey });
      return cache.load(objectKey);
    },
    clear: async () => {
      cache.release();
      touched.clear();
      keyOf.clear();
      await input.files.removeDir(input.dir);
    },
  };
};

/** Where the screens' pictures ask for covers: the open library's cache, set by `lib/library`; none in unit tests. */
let source: Pick<PhoneCovers, "uriFor" | "kept" | "refetch"> | null = null;

export const setPhoneCoverSource = (next: Pick<PhoneCovers, "uriFor" | "kept" | "refetch"> | null) => {
  source = next;
};

export const phoneCoverSource = () => source;
