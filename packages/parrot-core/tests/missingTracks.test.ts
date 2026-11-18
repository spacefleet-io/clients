/**
 * @test-id PARROT-CORE-MISSING-001
 * @level unit
 * @why PAR-LIB-05: the desktop and phone album pages list the album's songs the user does not have, greyed, in
 *      tracklist order between the owned ones; a song is missing when no owned song has its disc and number, and an
 *      album whose tracklist is unknown lists only its owned songs.
 * @covers packages/parrot-core/src/missingTracks.ts
 * @req PAR-LIB-05[parrot]
 */
import { describe, expect, it } from "bun:test";
import { albumPageRows, missingTracks, type ParrotListedTrack } from "../src";

const log = (phase: string, value: unknown) => console.log(`[PARROT-CORE-MISSING-001] ${phase}`, JSON.stringify(value));

const listed = (disc: number, number: number, title: string): ParrotListedTrack => ({ disc, number, title, durationMs: 200_000 });
const tracklist = [listed(1, 1, "Forecast"), listed(1, 2, "Don't Linger"), listed(1, 3, "Somewhere I Wander"), listed(2, 1, "Bonus")];
const owned = [
  { id: "t2", disc: 1, number: 2 },
  { id: "t3", disc: null, number: 3 },
  { id: "tx", disc: 1, number: null },
];

describe("missing album tracks", () => {
  it("lists the tracklist rows no owned song fills, by disc and number (a song with no disc counts as disc 1)", () => {
    const missing = missingTracks(tracklist, owned);
    log("missing", missing);
    expect(missing.map((track) => track.title)).toEqual(["Forecast", "Bonus"]);
  });

  it("lists nothing when the tracklist is unknown or empty", () => {
    expect(missingTracks(null, owned)).toEqual([]);
    expect(missingTracks(undefined, owned)).toEqual([]);
    expect(missingTracks([], owned)).toEqual([]);
  });

  it("slots the missing rows between the owned songs, keeping each owned song's play index; unnumbered songs last", () => {
    const rows = albumPageRows(owned, tracklist);
    log("rows", rows);
    expect(rows.map((row) => (row.kind === "owned" ? `${row.track.id}@${row.index}` : `missing:${row.listed.title}`))).toEqual([
      "missing:Forecast",
      "t2@0",
      "t3@1",
      "missing:Bonus",
      "tx@2",
    ]);
  });

  it("gives only the owned songs when nothing is missing", () => {
    const rows = albumPageRows(owned, null);
    expect(rows).toEqual(owned.map((track, index) => ({ kind: "owned", track, index })));
  });
});
