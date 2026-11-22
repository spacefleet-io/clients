/**
 * @test-id PARROT-CORE-OFFLINE-001
 * @level unit
 * @why Keeping on a device downloads songs and deletes them without asking again (PAR-OFFL-01): a wrong plan deletes a
 *   song the user still keeps, downloads the light copy, or asks about a choice that is not one. The phone and the
 *   desktop both run these rules (PAR-OFFL-03), so they are pinned here once.
 * @covers packages/parrot-core/src/offline.ts
 * @req PAR-OFFL-01[parrot]
 * @req PAR-OFFL-02[parrot]
 * @req PAR-OFFL-03[parrot]
 * @req PAR-OFFL-04[parrot]
 * @req OFFL-MANAGE-01[parrot]
 */
import { describe, expect, it } from "bun:test";
import type { TrackFileRow } from "../src/catalog";
import {
  copyFormatName,
  EMPTY_KEPT_STATE,
  isKept,
  keepCopyChoices,
  keepEntry,
  keptEntryBytes,
  keptEntryProgress,
  keptTrackIds,
  leaveOutSongs,
  offlineReach,
  parseKeptState,
  pickKeptFile,
  planKept,
  unkeepEntry,
  type KeepLibrary,
  type KeptEntry,
} from "../src/offline";

const file = (id: string, trackId: string, over: Partial<TrackFileRow> = {}): TrackFileRow => ({
  id,
  trackId,
  mime: "audio/mpeg",
  lossless: false,
  bitrateKbps: 320,
  sizeBytes: 100,
  lightCopy: false,
  createdAt: 1,
  ...over,
});

const flac = (id: string, trackId: string, sizeBytes = 300) => file(id, trackId, { mime: "audio/flac", lossless: true, bitrateKbps: null, sizeBytes });
const mp3 = (id: string, trackId: string, sizeBytes = 100) => file(id, trackId, { sizeBytes });
const light = (id: string, trackId: string) => file(id, trackId, { mime: "audio/mp4", bitrateKbps: 128, sizeBytes: 40, lightCopy: true });

const makeLibrary = (albums: Record<string, string[]>, playlists: Record<string, string[]>, files: TrackFileRow[]): KeepLibrary => ({
  albumTrackIds: (id) => albums[id] ?? [],
  playlistTrackIds: (id) => playlists[id] ?? [],
  trackFiles: (trackId) => files.filter((f) => f.trackId === trackId),
});

const log = (label: string, value: unknown) => console.info(`[offline.test] ${label}`, JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.keys()] : v)));

describe("kept list", () => {
  it("keeps, refuses to change a choice in place, and unkeeps", () => {
    let state = keepEntry(EMPTY_KEPT_STATE, "album", "a1", "FLAC:lossless", 10);
    state = keepEntry(state, "album", "a1", "MP3:320k", 20);
    log("state", state);
    expect(state.entries).toEqual([{ kind: "album", id: "a1", choice: "FLAC:lossless", keptAt: 10 }]);
    expect(isKept(state, "album", "a1")).toBe(true);
    expect(isKept(state, "playlist", "a1")).toBe(false);
    state = unkeepEntry(state, "album", "a1");
    expect(state.entries).toEqual([]);
  });

  it("reads a stored list and drops anything damaged", () => {
    expect(parseKeptState(null)).toEqual(EMPTY_KEPT_STATE);
    expect(parseKeptState("{oops")).toEqual(EMPTY_KEPT_STATE);
    const raw = JSON.stringify({
      version: 1,
      entries: [{ kind: "song", id: "t1", choice: null, keptAt: 1 }, { kind: "artist", id: "x", choice: null, keptAt: 2 }, null],
    });
    expect(parseKeptState(raw).entries).toEqual([{ kind: "song", id: "t1", choice: null, keptAt: 1 }]);
  });
});

describe("which copy is kept (PAR-OFFL-02)", () => {
  it("keeps the best copy, never the light copy while an original exists", () => {
    const files = [light("l", "t"), mp3("m", "t"), flac("f", "t")];
    expect(pickKeptFile(files, null)?.id).toBe("f");
    expect(pickKeptFile([light("l", "t"), mp3("m", "t")], null)?.id).toBe("m");
    expect(pickKeptFile([light("l", "t")], null)?.id).toBe("l");
  });

  it("keeps the chosen copy, and a song without it keeps its best copy", () => {
    expect(pickKeptFile([flac("f", "t"), mp3("m", "t")], "MP3:320k")?.id).toBe("m");
    expect(pickKeptFile([flac("f", "t"), light("l", "t")], "MP3:320k")?.id).toBe("f");
    expect(pickKeptFile([flac("f", "t")], "M4A:128k")?.id).toBe("f");
  });

  it("asks only when there is more than one copy besides the light one, listing format and space", () => {
    const library = makeLibrary({}, {}, [flac("f1", "t1", 300), mp3("m1", "t1", 100), light("l1", "t1"), flac("f2", "t2", 200), light("l2", "t2")]);
    const choices = keepCopyChoices(library, ["t1", "t2", "t1"]);
    log("choices", choices);
    expect(choices).toEqual([
      { key: "FLAC:lossless", label: "FLAC", lossless: true, bitrateKbps: null, songs: 2, bytes: 500 },
      // t2 has no MP3: it counts with its best copy (the FLAC), never its light copy.
      { key: "MP3:320k", label: "MP3 320 kbps", lossless: false, bitrateKbps: 320, songs: 1, bytes: 300 },
    ]);
    const single = makeLibrary({}, {}, [flac("f1", "t1"), light("l1", "t1"), flac("f1b", "t1")]);
    expect(keepCopyChoices(single, ["t1"]).length).toBe(1);
  });

  it("names formats the way the question lists them", () => {
    expect(copyFormatName("audio/mpeg")).toBe("MP3");
    expect(copyFormatName("audio/x-flac")).toBe("FLAC");
    expect(copyFormatName("audio/mp4")).toBe("M4A");
    expect(copyFormatName("audio/mp4; codecs=alac")).toBe("ALAC");
    expect(copyFormatName("audio/x-weird")).toBe("WEIRD");
  });
});

describe("matching the device to the kept list (PAR-OFFL-01)", () => {
  const files = [flac("f1", "t1"), mp3("m1", "t1"), flac("f2", "t2"), mp3("m3", "t3"), flac("f4", "t4")];

  it("fetches a kept album's songs, then a song added later, and deletes a song removed from it", () => {
    const albums: Record<string, string[]> = { a: ["t1", "t2"] };
    const state = keepEntry(EMPTY_KEPT_STATE, "album", "a", null, 1);
    const first = planKept(state, makeLibrary(albums, {}, files), new Set());
    log("first", { fetch: first.fetch.map((f) => f.id), remove: first.remove });
    expect(first.fetch.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(first.remove).toEqual([]);

    albums.a = ["t1", "t4"];
    const later = planKept(state, makeLibrary(albums, {}, files), new Set(["f1", "f2"]));
    log("later", { fetch: later.fetch.map((f) => f.id), remove: later.remove });
    expect(later.fetch.map((f) => f.id)).toEqual(["f4"]);
    expect(later.remove).toEqual(["f2"]);
  });

  it("keeps a song another kept entry still holds, and turning keeping off removes only what nothing holds", () => {
    let state = keepEntry(EMPTY_KEPT_STATE, "playlist", "gym", null, 1);
    state = keepEntry(state, "song", "t3", null, 2);
    const library = makeLibrary({}, { gym: ["t1", "t3"] }, files);
    const onDevice = new Set(["f1", "m3"]);
    const off = planKept(unkeepEntry(state, "playlist", "gym"), library, onDevice);
    log("off", { remove: off.remove, songs: [...off.songs.keys()] });
    expect(off.remove).toEqual(["f1"]);
    expect([...off.songs.keys()]).toEqual(["t3"]);
  });

  it("a song held by two choices keeps the copy already on the device, else the first kept entry's", () => {
    let state = keepEntry(EMPTY_KEPT_STATE, "album", "a", "MP3:320k", 1);
    state = keepEntry(state, "playlist", "p", "FLAC:lossless", 2);
    const library = makeLibrary({ a: ["t1"] }, { p: ["t1"] }, files);
    expect(planKept(state, library, new Set()).songs.get("t1")?.file.id).toBe("m1");
    const already = planKept(state, library, new Set(["f1"]));
    expect(already.songs.get("t1")?.file.id).toBe("f1");
    expect(already.fetch).toEqual([]);
    expect(already.remove).toEqual([]);
  });

  it("shows the space and progress of each kept entry", () => {
    let state = keepEntry(EMPTY_KEPT_STATE, "album", "a", null, 1);
    state = keepEntry(state, "song", "t3", null, 2);
    const library = makeLibrary({ a: ["t1", "t2"] }, {}, files);
    const plan = planKept(state, library, new Set());
    expect(keptEntryBytes(plan, library, { kind: "album", id: "a" })).toBe(600);
    expect(keptEntryProgress(plan, library, { kind: "album", id: "a" }, new Set(["f1"]))).toEqual({ done: 1, total: 2 });
  });

  it("offline, keeps in colour only what has a song on the device (PAR-OFFL-04)", () => {
    const songs = [
      { id: "t1", albumId: "a", artistId: "x" },
      { id: "t2", albumId: "a", artistId: "x" },
      { id: "t3", albumId: "b", artistId: "y" },
      { id: "t4", albumId: null, artistId: null },
    ];
    // t1 is on the device; t2 is kept but still downloading, so it is not in the set.
    const reach = offlineReach(new Set(["t1"]), songs);
    const seen = {
      songs: songs.map((song) => song.id).filter(reach.song),
      albums: ["a", "b"].filter(reach.album),
      artists: ["x", "y"].filter(reach.artist),
      playlists: [["t3", "t1"], ["t2", "t3"], []].map(reach.playlist),
    };
    console.log("[PAR-OFFL-04] offline reach", JSON.stringify(seen));
    expect(seen).toEqual({ songs: ["t1"], albums: ["a"], artists: ["x"], playlists: [true, false, false] });
  });

  it("skips a song with no stored file and an album that no longer exists", () => {
    const state = keepEntry(keepEntry(EMPTY_KEPT_STATE, "song", "ghost", null, 1), "album", "gone", null, 2);
    const plan = planKept(state, makeLibrary({}, {}, files), new Set(["old"]));
    expect(plan.songs.size).toBe(0);
    expect(plan.remove).toEqual(["old"]);
  });
});

describe("removing single songs on Manage offline content (OFFL-MANAGE-01)", () => {
  const library = makeLibrary(
    { a1: ["t1", "t2", "t3"], a2: ["t4"] },
    { p1: ["t2", "t4"] },
    ["t1", "t2", "t3", "t4", "t5"].map((trackId) => mp3(`f-${trackId}`, trackId))
  );
  const kept = (entries: Array<[KeptEntry["kind"], string]>) =>
    entries.reduce((state, [kind, id], index) => keepEntry(state, kind, id, null, index + 1), EMPTY_KEPT_STATE);
  const onDevice = new Set(["f-t1", "f-t2", "f-t3", "f-t4", "f-t5"]);

  it("leaves a song out of its kept album, keeps the album, and deletes only that file", () => {
    const state = leaveOutSongs(kept([["album", "a1"]]), library, ["t1"], "library");
    const plan = planKept(state, library, new Set(["f-t1", "f-t2", "f-t3"]));
    log("album less t1", { state, remove: plan.remove, songs: plan.songs });
    expect(state.entries).toEqual([{ kind: "album", id: "a1", choice: null, keptAt: 1, except: ["t1"] }]);
    expect(plan.remove).toEqual(["f-t1"]);
    expect([...plan.songs.keys()].sort()).toEqual(["t2", "t3"]);
    expect(keptTrackIds(library, state.entries[0])).toEqual(["t2", "t3"]);
  });

  it("stops keeping an album once every song is left out, and drops songs kept on their own", () => {
    const state = leaveOutSongs(kept([["album", "a1"], ["song", "t5"], ["song", "t4"]]), library, ["t1", "t2", "t3", "t5"], "library");
    log("artist removed", state);
    expect(state.entries).toEqual([{ kind: "song", id: "t4", choice: null, keptAt: 3 }]);
  });

  it("keeps a song a kept playlist still holds when it is removed from the library", () => {
    const state = leaveOutSongs(kept([["album", "a1"], ["playlist", "p1"]]), library, ["t2"], "library");
    const plan = planKept(state, library, onDevice);
    log("t2 removed from library", { state, remove: plan.remove });
    expect(plan.songs.has("t2")).toBe(true);
    expect(plan.remove).not.toContain("f-t2");
    expect(state.entries.find((entry) => entry.kind === "playlist")?.except).toBeUndefined();
  });

  it("removes a song from one playlist only, leaving the album that holds it", () => {
    const state = leaveOutSongs(kept([["album", "a2"], ["playlist", "p1"]]), library, ["t2", "t4"], { playlist: "p1" });
    const plan = planKept(state, library, onDevice);
    log("playlist emptied", { state, remove: plan.remove });
    expect(state.entries).toEqual([{ kind: "album", id: "a2", choice: null, keptAt: 1 }]);
    expect([...plan.songs.keys()]).toEqual(["t4"]);
    expect(plan.remove.sort()).toEqual(["f-t1", "f-t2", "f-t3", "f-t5"]);
  });

  it("stops keeping a whole album or playlist outright, songs the bin did not list included", () => {
    // Say t3 of a1 and t4 of p1 cannot play: the album row's bin then lists t1 and t2 only, the playlist row's t2 only.
    const songsOnly = leaveOutSongs(kept([["album", "a1"]]), library, ["t1", "t2"], "library");
    const album = leaveOutSongs(kept([["album", "a1"], ["playlist", "p1"]]), library, ["t1", "t2"], "library", [{ kind: "album", id: "a1" }]);
    const playlist = leaveOutSongs(kept([["album", "a1"], ["playlist", "p1"]]), library, ["t2"], { playlist: "p1" }, [{ kind: "playlist", id: "p1" }]);
    log("whole", { songsOnly, album, playlist });
    expect(songsOnly.entries).toEqual([{ kind: "album", id: "a1", choice: null, keptAt: 1, except: ["t1", "t2"] }]);
    expect(album.entries).toEqual([{ kind: "playlist", id: "p1", choice: null, keptAt: 2 }]);
    expect(playlist.entries).toEqual([{ kind: "album", id: "a1", choice: null, keptAt: 1 }]);
    // A playlist named whole from the library is out of scope and stays kept.
    expect(leaveOutSongs(kept([["playlist", "p1"]]), library, [], "library", [{ kind: "playlist", id: "p1" }]).entries).toHaveLength(1);
  });

  it("reads back a stored except list and drops a damaged one", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { kind: "album", id: "a1", choice: null, keptAt: 1, except: ["t1"] },
        { kind: "album", id: "a2", choice: null, keptAt: 2, except: [3] },
      ],
    });
    expect(parseKeptState(raw).entries).toEqual([{ kind: "album", id: "a1", choice: null, keptAt: 1, except: ["t1"] }]);
  });
});
