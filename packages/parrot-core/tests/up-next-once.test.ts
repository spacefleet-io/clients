/**
 * @test-id PARROT-CORE-UP-NEXT-ONCE-001
 * @level unit
 * @why PAR-CARD-02 (Chris 2026-11-21): a song sits in Up next at most once. Adding an album or a playlist skips the
 *   songs already in Up next or playing now; adding one song that is already there adds nothing, so the app can say
 *   "Already in Up next". Chris saw "Without You" playing AND further down Up next after adding its album.
 * @covers packages/parrot-core/src/queue.ts
 */
import { describe, expect, it } from "bun:test";
import { addToQueue, currentEntry, newToUpNext, notYetQueued, playNext, startQueue, upcoming, type PlayQueue } from "../src/queue";

type Song = { id: string; title: string };

const log = (step: string, queue: PlayQueue<Song>) =>
  console.log(
    `[PARROT-CORE-UP-NEXT-ONCE-001] ${step}: now=${currentEntry(queue)?.track.id ?? "-"} upNext=${upcoming(queue)
      .map((entry) => entry.track.id)
      .join(",")} position=${queue.position} keys=${queue.entries.map((entry) => entry.key).join(",")}`
  );
const upNextIds = (queue: PlayQueue<Song>) => upcoming(queue).map((entry) => entry.track.id);
const byId = (song: Song) => song.id;
/** A fresh copy of the song each time, as the library hands out new rows: the rule must go by id, not by object. */
const song = (id: string): Song => ({ id, title: id });
const album = () => ["intro", "without-you", "lanterns", "outro"].map(song);

describe("@req PAR-CARD-02 a song is in Up next at most once", () => {
  it("adding the album while one of its songs plays leaves that song out", () => {
    const playing = startQueue([song("without-you")], 0);
    log("playing", playing);
    const after = addToQueue(playing, album(), byId);
    log("album added", after);
    expect(currentEntry(after)?.track.id).toBe("without-you");
    expect(upNextIds(after)).toEqual(["intro", "lanterns", "outro"]);
  });

  it("adding the album skips the songs already in Up next, in either action", () => {
    const queued = addToQueue(startQueue([song("other")], 0), [song("lanterns")], byId);
    log("lanterns queued", queued);
    const added = addToQueue(queued, album(), byId);
    log("album added at the end", added);
    expect(upNextIds(added)).toEqual(["lanterns", "intro", "without-you", "outro"]);
    const next = playNext(queued, album(), byId);
    log("album played next", next);
    expect(upNextIds(next)).toEqual(["intro", "without-you", "outro", "lanterns"]);
  });

  it("one song added twice is still one row; the second add changes nothing", () => {
    const once = addToQueue(startQueue([song("other")], 0), [song("lanterns")], byId);
    const twice = addToQueue(once, [song("lanterns")], byId);
    log("added twice", twice);
    expect(twice).toBe(once);
    expect(upNextIds(twice)).toEqual(["lanterns"]);
    expect(newToUpNext(once, [song("lanterns")], byId)).toEqual([]);
    expect(playNext(once, [song("lanterns")], byId)).toBe(once);
  });

  it("the song playing is never added again, by Play next either", () => {
    const playing = startQueue(album(), 1);
    expect(playNext(playing, [song("without-you")], byId)).toBe(playing);
    expect(addToQueue(playing, [song("without-you")], byId)).toBe(playing);
  });

  it("a playlist holding a song twice adds it once", () => {
    const list = [song("a"), song("b"), song("a")];
    const after = addToQueue(startQueue([song("now")], 0), list, byId);
    log("playlist with a repeat added", after);
    expect(upNextIds(after)).toEqual(["a", "b"]);
  });

  it("songs that already played may come back: only Now playing and Up next count", () => {
    const later = startQueue(album(), 3);
    const after = addToQueue(later, [song("intro")], byId);
    log("played song queued again", after);
    expect(upNextIds(after)).toEqual(["intro"]);
  });

  it("notYetQueued: the phone's form, against the ids the native player holds", () => {
    expect(notYetQueued(["without-you", "lanterns"], album(), byId).map(byId)).toEqual(["intro", "outro"]);
    expect(notYetQueued([null], ["x", "x", "y"])).toEqual(["x", "y"]);
  });
});
