// Songs kept on a device for offline play (PAR-OFFL-01/02/03): what the user asked to keep, which stored copy of each
// song that means, and what to fetch or delete so the device matches. Pure rules shared by the phone and the desktop;
// each app owns the storage (the phone's download engine, the desktop's kept-files folder) and calls `planKept` after
// every library load, so songs added to a kept album or playlist arrive on their own and removed songs leave.
import { anyOnDevice } from "@space/shared/offlineReach";
import { pickPlayableFile, type TrackFileRow } from "./catalog";

export type KeptKind = "song" | "album" | "playlist";

/**
 * One "Save offline" the user turned on. `choice` is the copy picked when there was a real choice. `except` = songs of a
 * kept album or playlist the user removed one by one on "Manage offline content" (OFFL-MANAGE-01); the entry stays kept,
 * so songs added to it later still arrive.
 */
export type KeptEntry = { kind: KeptKind; id: string; choice: string | null; keptAt: number; except?: string[] };

/** What the device remembers (per device, PAR-OFFL-02 notes): the kept list in the order it was kept. */
export type KeptState = { version: 1; entries: KeptEntry[] };

export const EMPTY_KEPT_STATE: KeptState = { version: 1, entries: [] };

/** The library as keeping reads it; each app answers from its decrypted library database. */
export type KeepLibrary = {
  albumTrackIds: (albumId: string) => readonly string[];
  playlistTrackIds: (playlistId: string) => readonly string[];
  trackFiles: (trackId: string) => readonly TrackFileRow[];
};

/** A copy the user can pick for an album, a playlist or a song: one format, with the space it would take. */
export type KeepCopyChoice = { key: string; label: string; lossless: boolean; bitrateKbps: number | null; songs: number; bytes: number };

const KINDS: readonly KeptKind[] = ["song", "album", "playlist"];

/** The stored kept list, or an empty one for anything unreadable (a first run, a damaged file). */
export const parseKeptState = (raw: string | null | undefined): KeptState => {
  if (!raw) return EMPTY_KEPT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<KeptState>;
    if (!Array.isArray(parsed.entries)) return EMPTY_KEPT_STATE;
    const entries = parsed.entries.filter(
      (entry): entry is KeptEntry =>
        Boolean(entry) &&
        KINDS.includes(entry.kind) &&
        typeof entry.id === "string" &&
        (entry.choice === null || typeof entry.choice === "string") &&
        typeof entry.keptAt === "number" &&
        (entry.except === undefined || (Array.isArray(entry.except) && entry.except.every((id) => typeof id === "string")))
    );
    return { version: 1, entries };
  } catch {
    return EMPTY_KEPT_STATE;
  }
};

export const isKept = (state: KeptState, kind: KeptKind, id: string) => state.entries.some((entry) => entry.kind === kind && entry.id === id);

/** Turn keeping on (no-op when already kept: the choice cannot change in place, PAR-OFFL-02). */
export const keepEntry = (state: KeptState, kind: KeptKind, id: string, choice: string | null, now: number): KeptState =>
  isKept(state, kind, id) ? state : { version: 1, entries: [...state.entries, { kind, id, choice, keptAt: now }] };

export const unkeepEntry = (state: KeptState, kind: KeptKind, id: string): KeptState => ({
  version: 1,
  entries: state.entries.filter((entry) => !(entry.kind === kind && entry.id === id)),
});

/**
 * Remove songs from what is kept (OFFL-MANAGE-01). `from: "library"` drops songs kept on their own and leaves the songs
 * out of kept albums; `{ playlist }` leaves them out of that kept playlist only. Other kept items that hold a song keep
 * it on the device. An album or playlist with every song left out stops being kept. `whole` names kept albums and
 * playlists (in that scope) to stop keeping outright, songs with no playable file included: the bin on an album or a
 * playlist row lists only the songs on the device, so leaving those out would keep the item with an `except` list.
 */
export const leaveOutSongs = (
  state: KeptState,
  library: Pick<KeepLibrary, "albumTrackIds" | "playlistTrackIds">,
  trackIds: readonly string[],
  from: "library" | { playlist: string },
  whole: ReadonlyArray<{ kind: "album" | "playlist"; id: string }> = []
): KeptState => {
  const gone = new Set(trackIds);
  const inScope = (entry: KeptEntry) => (from === "library" ? entry.kind !== "playlist" : entry.kind === "playlist" && entry.id === from.playlist);
  const unsaved = (entry: KeptEntry) => whole.some((item) => item.kind === entry.kind && item.id === entry.id);
  const entries: KeptEntry[] = [];
  for (const entry of state.entries) {
    if (!inScope(entry)) {
      entries.push(entry);
      continue;
    }
    if (unsaved(entry)) continue;
    if (entry.kind === "song") {
      if (!gone.has(entry.id)) entries.push(entry);
      continue;
    }
    const songs = keptTrackIds(library, { kind: entry.kind, id: entry.id });
    const hits = songs.filter((trackId) => gone.has(trackId));
    if (hits.length === 0) {
      entries.push(entry);
      continue;
    }
    const except = [...new Set([...(entry.except ?? []), ...hits])];
    if (songs.every((trackId) => except.includes(trackId))) continue;
    entries.push({ ...entry, except });
  }
  return { version: 1, entries };
};

const FORMAT_BY_SUBTYPE: Record<string, string> = {
  mpeg: "MP3",
  mp3: "MP3",
  flac: "FLAC",
  "x-flac": "FLAC",
  mp4: "M4A",
  aac: "AAC",
  "x-m4a": "M4A",
  ogg: "Ogg",
  opus: "Opus",
  wav: "WAV",
  "x-wav": "WAV",
  aiff: "AIFF",
  "x-aiff": "AIFF",
  "x-dsf": "DSD",
  "x-dff": "DSD",
};

/** "MP3", "FLAC", "M4A", "ALAC": the format a copy is listed by in the question (PAR-OFFL-02 notes). */
export const copyFormatName = (mime: string): string => {
  if (/;\s*codecs="?alac/i.test(mime)) return "ALAC";
  const sub = mime.split("/")[1]?.split(";")[0]?.toLowerCase() ?? "";
  return FORMAT_BY_SUBTYPE[sub] ?? (sub.replace(/^x-/, "").toUpperCase() || "Audio");
};

/** Identity of a copy across songs: its format, and its bitrate for a lossy one (a lossless copy has no bitrate step). */
export const copyKey = (file: Pick<TrackFileRow, "mime" | "lossless" | "bitrateKbps">) =>
  `${copyFormatName(file.mime)}:${file.lossless ? "lossless" : `${file.bitrateKbps ?? 0}k`}`;

const copyLabel = (file: Pick<TrackFileRow, "mime" | "lossless" | "bitrateKbps">) =>
  file.lossless || !file.bitrateKbps ? copyFormatName(file.mime) : `${copyFormatName(file.mime)} ${file.bitrateKbps} kbps`;

/**
 * The file kept for one song: the best file of the chosen copy when the song has it, else the song's best copy; never
 * the light copy while an original exists (PAR-OFFL-02, PAR-FMT-01).
 */
export const pickKeptFile = <T extends TrackFileRow>(files: readonly T[], choice: string | null): T | null => {
  if (choice) {
    const chosen = files.filter((file) => !file.lightCopy && copyKey(file) === choice);
    const best = pickPlayableFile(chosen);
    if (best) return best;
  }
  return pickPlayableFile([...files]);
};

/**
 * The copies to ask about when keeping these songs, best first: one entry per format besides the light copy, with how
 * many of the songs have it and the space keeping it would take (songs without it count with their best copy). A real
 * choice is two or more entries; with one or none, nothing is asked (PAR-OFFL-02).
 */
export const keepCopyChoices = (library: Pick<KeepLibrary, "trackFiles">, trackIds: readonly string[]): KeepCopyChoice[] => {
  const unique = [...new Set(trackIds)];
  const byKey = new Map<string, { sample: TrackFileRow; tracks: Set<string> }>();
  for (const trackId of unique) {
    for (const file of library.trackFiles(trackId)) {
      if (file.lightCopy) continue;
      const key = copyKey(file);
      const slot = byKey.get(key) ?? { sample: file, tracks: new Set<string>() };
      slot.tracks.add(trackId);
      byKey.set(key, slot);
    }
  }
  const choices = [...byKey.entries()].map(([key, { sample, tracks }]) => ({
    key,
    label: copyLabel(sample),
    lossless: sample.lossless,
    bitrateKbps: sample.lossless ? null : sample.bitrateKbps,
    songs: tracks.size,
    bytes: unique.reduce((sum, trackId) => sum + (pickKeptFile(library.trackFiles(trackId), key)?.sizeBytes ?? 0), 0),
  }));
  return choices.sort(
    (a, b) => Number(b.lossless) - Number(a.lossless) || (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0) || a.label.localeCompare(b.label)
  );
};

/** The songs one kept entry holds right now: the album's or playlist's current songs (less any left out), or the song itself. */
export const keptTrackIds = (
  library: Pick<KeepLibrary, "albumTrackIds" | "playlistTrackIds">,
  entry: Pick<KeptEntry, "kind" | "id"> & { except?: readonly string[] }
) => {
  if (entry.kind === "song") return [entry.id];
  const songs = entry.kind === "album" ? library.albumTrackIds(entry.id) : library.playlistTrackIds(entry.id);
  return entry.except?.length ? songs.filter((trackId) => !entry.except?.includes(trackId)) : [...songs];
};

/** One song the device should hold: the file kept for it and the kept entries that hold it. */
export type KeptSong = { trackId: string; file: TrackFileRow; holders: KeptEntry[] };

export type KeptPlan = {
  /** Every song the device should hold, by track id. */
  songs: Map<string, KeptSong>;
  /** Files to download (not on the device yet). */
  fetch: TrackFileRow[];
  /** File ids on the device that no kept entry holds any more: delete them. */
  remove: string[];
};

/**
 * Match the device to the kept list. A song stays while any kept entry holds it; a song held by entries with different
 * choices keeps the copy already on the device, else the earliest kept entry's copy (PAR-OFFL-02 notes). A song with
 * no stored file is skipped. `onDevice` = file ids stored (or downloading) on the device.
 */
export const planKept = (state: KeptState, library: KeepLibrary, onDevice: ReadonlySet<string>): KeptPlan => {
  const holdersByTrack = new Map<string, KeptEntry[]>();
  const ordered = [...state.entries].sort((a, b) => a.keptAt - b.keptAt);
  for (const entry of ordered) {
    for (const trackId of keptTrackIds(library, entry)) {
      const holders = holdersByTrack.get(trackId) ?? [];
      if (!holders.includes(entry)) holders.push(entry);
      holdersByTrack.set(trackId, holders);
    }
  }
  const songs = new Map<string, KeptSong>();
  for (const [trackId, holders] of holdersByTrack) {
    const files = library.trackFiles(trackId);
    const candidates = holders.map((holder) => pickKeptFile(files, holder.choice)).filter((file): file is TrackFileRow => file !== null);
    const file = candidates.find((candidate) => onDevice.has(candidate.id)) ?? candidates[0];
    if (file) songs.set(trackId, { trackId, file, holders });
  }
  const wanted = new Set([...songs.values()].map((song) => song.file.id));
  const fetchIds = new Set<string>();
  const fetch: TrackFileRow[] = [];
  for (const song of songs.values()) {
    if (onDevice.has(song.file.id) || fetchIds.has(song.file.id)) continue;
    fetchIds.add(song.file.id);
    fetch.push(song.file);
  }
  return { songs, fetch, remove: [...onDevice].filter((id) => !wanted.has(id)) };
};

/** The space one kept album, playlist or song takes on the device: its songs' kept files (PAR-OFFL-01). */
export const keptEntryBytes = (plan: Pick<KeptPlan, "songs">, library: Pick<KeepLibrary, "albumTrackIds" | "playlistTrackIds">, entry: Pick<KeptEntry, "kind" | "id">) =>
  [...new Set(keptTrackIds(library, entry))].reduce((sum, trackId) => sum + (plan.songs.get(trackId)?.file.sizeBytes ?? 0), 0);

/** How far a kept entry is: songs whose kept file is complete on the device, out of the songs it holds. */
export const keptEntryProgress = (
  plan: Pick<KeptPlan, "songs">,
  library: Pick<KeepLibrary, "albumTrackIds" | "playlistTrackIds">,
  entry: Pick<KeptEntry, "kind" | "id">,
  completed: ReadonlySet<string>
) => {
  const songs = [...new Set(keptTrackIds(library, entry))].map((trackId) => plan.songs.get(trackId)).filter((song) => song !== undefined);
  return { done: songs.filter((song) => completed.has(song.file.id)).length, total: songs.length };
};

/**
 * What still plays with no connection (PAR-OFFL-04): a song whose kept file is complete on this device, and an album,
 * an artist or a playlist holding at least one such song. Everything else is greyed out and does not play while the
 * device is offline. `songs` is the library's songs with their album and artist.
 */
export const offlineReach = (
  onDevice: ReadonlySet<string>,
  songs: ReadonlyArray<{ id: string; albumId?: string | null; artistId?: string | null }>
): OfflineReach => {
  const albums = new Set<string>();
  const artists = new Set<string>();
  for (const song of songs) {
    if (!onDevice.has(song.id)) continue;
    if (song.albumId) albums.add(song.albumId);
    if (song.artistId) artists.add(song.artistId);
  }
  return {
    song: (trackId: string) => onDevice.has(trackId),
    album: (id: string) => albums.has(id),
    artist: (id: string) => artists.has(id),
    playlist: (trackIds: readonly string[]) => anyOnDevice(onDevice, trackIds),
  };
};

/** Whether each kind of library item still plays while the device is offline. */
export type OfflineReach = {
  song: (trackId: string) => boolean;
  album: (id: string) => boolean;
  artist: (id: string) => boolean;
  playlist: (trackIds: readonly string[]) => boolean;
};
