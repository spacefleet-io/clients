/**
 * @test-id PARROT-CORE-PLAYLISTS-001
 * @level unit
 * @why Chris 2026-11-09: "you should build everything in the app like the demo you had showed me". Playlists and the
 *      heart are one shared piece of logic for desktop, phone and browser: an edit names what the user did, its ops
 *      are rebuilt on whatever library is current, Liked songs is made on the first like, listed first and can be
 *      neither renamed nor deleted, and a removal follows the song when another device moved it.
 * @covers packages/parrot-core/src/playlists.ts
 */
import { describe, expect, it } from "bun:test";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import {
  applyPlaylistEditsLocally,
  areAllLiked,
  buildParrotPlaylists,
  cleanPlaylistName,
  isLikedSong,
  newPlaylistEdit,
  PARROT_LIKED_PLAYLIST_ID,
  parrotPlaylistEditOps,
  toggleLikeAllEdits,
  toggleLikeEdit,
  type ParrotPlaylist,
} from "../src/playlists";

const NOW = Date.UTC(2026, 10, 9, 12);
let counter = 0;
const context = { now: NOW, newId: () => `id-${(counter += 1)}` };
const playlist = (id: string, name: string, trackIds: string[], createdAt = 1): ParrotPlaylist => ({ id, name, createdAt, updatedAt: createdAt, trackIds, trackCount: trackIds.length });
const summary = (ops: ParrotLibraryOp[]) =>
  ops.map((op) =>
    op.type === "playlist_tracks.set" ? `set ${op.payload.playlistId} [${op.payload.trackIds.join(",")}]` : op.type === "playlist.upsert" ? `upsert ${op.payload.id} "${op.payload.name}"` : `${op.type} ${JSON.stringify(op.payload)}`
  );

describe("playlists (shared)", () => {
  // @req PAR-PL-01
  it("lists Liked songs first, then the others by name, each with its songs in order", () => {
    const list = buildParrotPlaylists(
      [
        { id: "b", name: "road trip", createdAt: 2, updatedAt: 2 },
        { id: PARROT_LIKED_PLAYLIST_ID, name: "Liked songs", createdAt: 9, updatedAt: 9 },
        { id: "a", name: "Gym", createdAt: 1, updatedAt: 1 },
      ],
      [
        { playlistId: "a", trackId: "t2" },
        { playlistId: "a", trackId: "t1" },
        { playlistId: "a", trackId: "t2" },
        { playlistId: PARROT_LIKED_PLAYLIST_ID, trackId: "t3" },
      ]
    );
    console.log("[PARROT-CORE-PLAYLISTS-001] listing", list);
    expect(list.map((p) => [p.id, p.trackIds, p.trackCount])).toEqual([
      [PARROT_LIKED_PLAYLIST_ID, ["t3"], 1],
      ["a", ["t2", "t1", "t2"], 3],
      ["b", [], 0],
    ]);
  });

  // @req PAR-PL-02
  it("creates, renames, adds to, removes from and deletes a playlist", () => {
    const create = newPlaylistEdit("  Gym   mix ", () => "x1", ["t1"]);
    expect(create).toEqual({ kind: "create", id: "pl-x1", name: "  Gym   mix ", trackIds: ["t1"] });
    const created = parrotPlaylistEditOps([], [create, { kind: "add", id: "pl-x1", trackIds: ["t2", "t1"] }], context);
    console.log("[PARROT-CORE-PLAYLISTS-001] create", summary(created));
    expect(summary(created)).toEqual([`upsert pl-x1 "Gym mix"`, "set pl-x1 [t1,t2,t1]"]);
    expect(created[0]!.payload).toMatchObject({ createdAt: NOW, updatedAt: NOW });

    const gym = playlist("pl-x1", "Gym mix", ["t1", "t2", "t1"]);
    expect(summary(parrotPlaylistEditOps([gym], [{ kind: "rename", id: "pl-x1", name: "Gym" }], context))).toEqual([`upsert pl-x1 "Gym"`]);
    // The second "t1" (position 2) goes, the first stays.
    expect(summary(parrotPlaylistEditOps([gym], [{ kind: "remove", id: "pl-x1", position: 2, trackId: "t1" }], context))).toEqual([`upsert pl-x1 "Gym mix"`, "set pl-x1 [t1,t2]"]);
    expect(summary(parrotPlaylistEditOps([gym], [{ kind: "delete", id: "pl-x1" }], context))).toEqual([`playlist.delete {"id":"pl-x1"}`]);
  });

  // @req PAR-PL-02
  it("drops edits that no longer make sense: an empty name, a same-name rename, a deleted playlist", () => {
    const gym = playlist("g", "Gym", ["t1"]);
    expect(parrotPlaylistEditOps([gym], [{ kind: "rename", id: "g", name: "   " }], context)).toEqual([]);
    expect(parrotPlaylistEditOps([gym], [{ kind: "rename", id: "g", name: "Gym" }], context)).toEqual([]);
    expect(parrotPlaylistEditOps([], [{ kind: "add", id: "g", trackIds: ["t2"] }], context)).toEqual([]);
    expect(parrotPlaylistEditOps([], [{ kind: "create", id: "n", name: "" }], context)).toEqual([]);
    expect(cleanPlaylistName(`  ${"a".repeat(150)}`)).toHaveLength(100);
  });

  // @req PAR-PL-03
  it("a removal follows the song when another device moved it, and does nothing when it is gone", () => {
    // This device saw t3 at position 0; another device meanwhile put t9 in front of it.
    const moved = playlist("g", "Gym", ["t9", "t3", "t4"]);
    expect(summary(parrotPlaylistEditOps([moved], [{ kind: "remove", id: "g", position: 0, trackId: "t3" }], context))).toEqual([`upsert g "Gym"`, "set g [t9,t4]"]);
    expect(parrotPlaylistEditOps([playlist("g", "Gym", ["t9"])], [{ kind: "remove", id: "g", position: 0, trackId: "t3" }], context)).toEqual([]);
  });

  // @req PAR-PL-04
  it("the heart makes Liked songs on the first like, toggles the song, and Liked songs cannot be renamed or deleted", () => {
    const like = toggleLikeEdit([], "t1");
    expect(like).toEqual({ kind: "like", trackId: "t1", liked: true });
    const first = parrotPlaylistEditOps([], [like], context);
    console.log("[PARROT-CORE-PLAYLISTS-001] first like", summary(first));
    expect(summary(first)).toEqual([`upsert ${PARROT_LIKED_PLAYLIST_ID} "Liked songs"`, `set ${PARROT_LIKED_PLAYLIST_ID} [t1]`]);

    const liked = [playlist(PARROT_LIKED_PLAYLIST_ID, "Liked songs", ["t1"])];
    expect(isLikedSong(liked, "t1")).toBe(true);
    expect(isLikedSong(liked, "t2")).toBe(false);
    expect(toggleLikeEdit(liked, "t1")).toEqual({ kind: "like", trackId: "t1", liked: false });
    expect(summary(parrotPlaylistEditOps(liked, [toggleLikeEdit(liked, "t1")], context))).toEqual([`upsert ${PARROT_LIKED_PLAYLIST_ID} "Liked songs"`, `set ${PARROT_LIKED_PLAYLIST_ID} []`]);
    // Liking an already liked song (replayed after another device liked it too) adds nothing.
    expect(parrotPlaylistEditOps(liked, [{ kind: "like", trackId: "t1", liked: true }], context)).toEqual([]);
    expect(parrotPlaylistEditOps(liked, [{ kind: "rename", id: PARROT_LIKED_PLAYLIST_ID, name: "Mine" }], context)).toEqual([]);
    expect(parrotPlaylistEditOps(liked, [{ kind: "delete", id: PARROT_LIKED_PLAYLIST_ID }], context)).toEqual([]);
    // "Add to playlist" can pick Liked songs too, even before it exists.
    expect(summary(parrotPlaylistEditOps([], [{ kind: "add", id: PARROT_LIKED_PLAYLIST_ID, trackIds: ["t5"] }], context))).toEqual([
      `upsert ${PARROT_LIKED_PLAYLIST_ID} "Liked songs"`,
      `set ${PARROT_LIKED_PLAYLIST_ID} [t5]`,
    ]);
  });

  // @req PAR-LOOK-05
  it("an album's heart likes the songs not liked yet, and unlikes them all once every one is liked", () => {
    const some = [playlist(PARROT_LIKED_PLAYLIST_ID, "Liked songs", ["t1"])];
    expect(areAllLiked(some, ["t1", "t2"])).toBe(false);
    expect(areAllLiked(some, [])).toBe(false);
    const likeRest = toggleLikeAllEdits(some, ["t1", "t2"]);
    console.log("[PARROT-CORE-PLAYLISTS-001] album like", likeRest);
    expect(likeRest).toEqual([{ kind: "like", trackId: "t2", liked: true }]);
    const all = [playlist(PARROT_LIKED_PLAYLIST_ID, "Liked songs", ["t1", "t2"])];
    expect(areAllLiked(all, ["t1", "t2"])).toBe(true);
    expect(toggleLikeAllEdits(all, ["t1", "t2"])).toEqual([
      { kind: "like", trackId: "t1", liked: false },
      { kind: "like", trackId: "t2", liked: false },
    ]);
  });

  // @req PAR-PL-02
  it("shows the edited playlists before the save finishes", () => {
    const before = [playlist("g", "Gym", ["t1"])];
    const after = applyPlaylistEditsLocally(before, [newPlaylistEdit("Calm", () => "c", ["t2"]), { kind: "like", trackId: "t1", liked: true }, { kind: "delete", id: "g" }], NOW);
    console.log("[PARROT-CORE-PLAYLISTS-001] local view", after);
    expect(after.map((p) => [p.id, p.name, p.trackIds])).toEqual([
      [PARROT_LIKED_PLAYLIST_ID, "Liked songs", ["t1"]],
      ["pl-c", "Calm", ["t2"]],
    ]);
  });
});
