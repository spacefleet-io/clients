// The keeping loop of "Save offline" (PAR-OFFL-01/02/03), one for every Parrot app that keeps songs
// offline: the kept list (remembered per device), and the runs that make the device hold exactly the songs it names,
// downloading what is missing and deleting what no kept item holds any more. The rules are ./offline's; each app gives
// its own storage for the list (the desktop's kept.json, the phone's AsyncStorage) and its own kept files (the
// desktop's sealed kept files, the phone's native download engine). Nothing downloads unless the user kept something
// (OFFL-AUTO-01).
import type { TrackFileRow } from "./catalog";
import {
  EMPTY_KEPT_STATE,
  keepCopyChoices,
  keepEntry,
  keptEntryBytes,
  keptEntryProgress,
  keptTrackIds,
  parseKeptState,
  planKept,
  unkeepEntry,
  type KeepCopyChoice,
  type KeepLibrary,
  type KeptEntry,
  type KeptKind,
  type KeptPlan,
  type KeptState,
} from "./offline";

/**
 * What is kept on this device, for the screens: each kept album, playlist or song with the space its songs take and how
 * many of them are complete here, every song the kept list holds (and whether its file is complete here), and whether
 * a download is under way.
 */
export type KeptStatus = {
  entries: Array<KeptEntry & { bytes: number; done: number; total: number }>;
  songs: Array<{ trackId: string; fileId: string; onDevice: boolean }>;
  downloading: boolean;
};

export const KEPT_KINDS: readonly KeptKind[] = ["song", "album", "playlist"];
export const isKeptKind = (value: unknown): value is KeptKind => KEPT_KINDS.includes(value as KeptKind);

/**
 * The open library as keeping reads it, built from rows read once per load (a device whose database answers
 * asynchronously, like the phone's): each song's album, the playlists' songs and every stored file.
 */
export const keepLibraryFromRows = (input: {
  tracks: ReadonlyArray<{ id: string; albumId: string }>;
  playlists: ReadonlyArray<{ id: string; trackIds: readonly string[] }>;
  files: readonly TrackFileRow[];
}): KeepLibrary => {
  const albums = new Map<string, string[]>();
  for (const track of input.tracks) {
    const list = albums.get(track.albumId);
    if (list) list.push(track.id);
    else albums.set(track.albumId, [track.id]);
  }
  const files = new Map<string, TrackFileRow[]>();
  for (const file of input.files) {
    const list = files.get(file.trackId);
    if (list) list.push(file);
    else files.set(file.trackId, [file]);
  }
  const playlists = new Map(input.playlists.map((playlist) => [playlist.id, playlist.trackIds]));
  return {
    albumTrackIds: (albumId) => albums.get(albumId) ?? [],
    playlistTrackIds: (playlistId) => playlists.get(playlistId) ?? [],
    trackFiles: (trackId) => files.get(trackId) ?? [],
  };
};

/** Where a device remembers its kept list (one text). */
export type KeptListStorage = {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  remove(): Promise<void>;
};

/** The device's kept song files. */
export type KeptFileStore = {
  /** The kept files on the device: complete, or still downloading on a device that queues downloads. */
  fileIds(): readonly string[];
  /** The complete ones; leave it out when `fileIds` only lists complete files. */
  completeIds?(): readonly string[];
  /**
   * Whether songs may download now. `byHand` = the run follows the user keeping something; otherwise it follows a
   * library load, whose downloads (songs later added to a kept album or playlist) go over Wi-Fi only (PAR-OFFL-01).
   * False = the songs wait for a later run. Left out = always.
   */
  mayDownload?(byHand: boolean): Promise<boolean>;
  /**
   * Gets one song's file onto the device (downloads it, or hands it to the device's download queue). Resolves false
   * when it gave up quietly because `cancelled()` turned true; throws when it cannot (offline, storage full), which
   * stops the run until the next one.
   */
  keep(file: TrackFileRow, cancelled: () => boolean): Promise<boolean>;
  /** Deletes files; called only with files no kept item holds. */
  remove(ids: string[]): Promise<void>;
  /** Deletes every kept file (sign-out). */
  clear(): Promise<void>;
};

export type ParrotKeeping = {
  status(): KeptStatus;
  keep(kind: KeptKind, id: string, choice: string | null): Promise<KeptStatus>;
  unkeep(kind: KeptKind, id: string): Promise<KeptStatus>;
  /** The copies to ask about; two or more is a real choice (PAR-OFFL-02). */
  choices(kind: KeptKind, id: string): KeepCopyChoice[];
  /**
   * Makes the device match the kept list after a library load (songs added to a kept album or playlist download,
   * removed ones are deleted). One run at a time; a call during a run runs once more after it.
   */
  reconcile(): Promise<void>;
  /** The complete kept file of a song, when the song is kept here (it may be another copy than the one asked). */
  keptFileId(trackId: string): string | null;
  /** The device's files changed on their own (a queued download finished): the screens get a fresh status. */
  notify(): void;
  /** Sign-out: forget the kept list and every kept file. */
  clear(): Promise<void>;
};

export const createParrotKeeping = async (input: {
  storage: KeptListStorage;
  files: KeptFileStore;
  /** The open library as keeping reads it; null while none is open. */
  library: () => KeepLibrary | null;
  /** Called when the kept list or a download changed. */
  onChange: (status: KeptStatus) => void;
  /** Called when the kept list goes from empty to not empty or back (the app keeps or drops its library copy). */
  onKeptAny?: (any: boolean) => void;
  now?: () => number;
  log: (line: string) => void;
}): Promise<ParrotKeeping> => {
  const { files, log } = input;
  const now = input.now ?? Date.now;
  let state: KeptState = parseKeptState(await input.storage.read().catch(() => null));
  log(`[kept] ${state.entries.length} kept item(s), ${files.fileIds().length} file(s) on this device`);

  const completeIds = () => new Set(files.completeIds?.() ?? files.fileIds());
  const plan = (): { plan: KeptPlan; library: KeepLibrary } | null => {
    const library = input.library();
    return library ? { plan: planKept(state, library, new Set(files.fileIds())), library } : null;
  };

  let downloading = false;
  const status = (): KeptStatus => {
    const planned = plan();
    if (!planned) return { entries: state.entries.map((entry) => ({ ...entry, bytes: 0, done: 0, total: 0 })), songs: [], downloading };
    const complete = completeIds();
    const songs = [...planned.plan.songs.values()].map((song) => ({ trackId: song.trackId, fileId: song.file.id, onDevice: complete.has(song.file.id) }));
    return {
      entries: state.entries.map((entry) => ({
        ...entry,
        bytes: keptEntryBytes(planned.plan, planned.library, entry),
        ...keptEntryProgress(planned.plan, planned.library, entry, complete),
      })),
      songs,
      downloading: downloading || songs.some((song) => !song.onDevice && files.fileIds().includes(song.fileId)),
    };
  };
  const changed = () => input.onChange(status());

  const save = async (next: KeptState) => {
    const hadAny = state.entries.length > 0;
    state = next;
    await input.storage.write(JSON.stringify(state));
    if (hadAny !== state.entries.length > 0) input.onKeptAny?.(state.entries.length > 0);
  };

  const runOnce = async (byHand: boolean) => {
    const planned = plan();
    if (!planned) return log("[kept] reconcile skipped: no library open");
    const { remove, fetch } = planned.plan;
    log(`[kept] reconcile${byHand ? " (kept by hand)" : ""}: ${planned.plan.songs.size} song(s) kept, ${fetch.length} to download, ${remove.length} to delete`);
    if (remove.length > 0) {
      await files.remove(remove);
      log(`[kept] deleted ${remove.length} file(s) no kept item holds: ${remove.join(", ")}`);
      changed();
    }
    if (fetch.length === 0) return;
    if (files.mayDownload && !(await files.mayDownload(byHand))) {
      log(`[kept] ${fetch.length} song(s) wait: ${byHand ? "the network does not allow downloads" : "songs added later download over Wi-Fi only"}`);
      return;
    }
    for (const file of fetch) {
      // Unkept while waiting (or the library changed): skip it, the next run sees the new plan.
      const stillWanted = () => {
        const current = plan();
        return current !== null && [...current.plan.songs.values()].some((song) => song.file.id === file.id);
      };
      if (!stillWanted()) continue;
      downloading = true;
      changed();
      const started = now();
      try {
        const kept = await files.keep(file, () => !stillWanted());
        log(kept ? `[kept] song ${file.trackId} kept (${file.id}, ${file.sizeBytes} bytes) in ${now() - started} ms` : `[kept] song ${file.trackId} unkept during its download`);
      } catch (error) {
        // Offline or the storage refused: the next run tries again.
        log(`[kept] could not keep ${file.id}: ${error instanceof Error ? error.message : String(error)}; stopping until the next load`);
        downloading = false;
        changed();
        return;
      }
      downloading = false;
      changed();
    }
  };

  let running: Promise<void> | null = null;
  let again: { byHand: boolean } | null = null;
  const reconcile = (byHand: boolean): Promise<void> => {
    if (running) {
      again = { byHand: byHand || (again?.byHand ?? false) };
      return running;
    }
    running = (async () => {
      let next: { byHand: boolean } | null = { byHand };
      while (next) {
        again = null;
        await runOnce(next.byHand);
        next = again;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    status,
    keep: async (kind, id, choice) => {
      await save(keepEntry(state, kind, id, choice, now()));
      log(`[kept] keep ${kind} ${id}${choice ? ` as ${choice}` : ""}`);
      void reconcile(true);
      return status();
    },
    unkeep: async (kind, id) => {
      await save(unkeepEntry(state, kind, id));
      log(`[kept] remove ${kind} ${id} from this device`);
      void reconcile(true);
      return status();
    },
    choices: (kind, id) => {
      const library = input.library();
      return library ? keepCopyChoices(library, keptTrackIds(library, { kind, id })) : [];
    },
    reconcile: () => reconcile(false),
    keptFileId: (trackId) => {
      const kept = plan()?.plan.songs.get(trackId)?.file.id;
      return kept && completeIds().has(kept) ? kept : null;
    },
    notify: changed,
    clear: async () => {
      const hadAny = state.entries.length > 0;
      state = EMPTY_KEPT_STATE;
      await files.clear();
      await input.storage.remove();
      log("[kept] kept list and kept files removed");
      changed();
      if (hadAny) input.onKeptAny?.(false);
    },
  };
};
