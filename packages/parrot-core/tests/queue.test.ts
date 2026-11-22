/**
 * @test-id PARROT-CORE-QUEUE-001
 * @level unit
 * @why The play queue drives what plays next on every Parrot surface (PAR-SCOPE-01, PLAT-WEB-08): play next, add to
 *   the queue, skip, back, shuffle and repeat. A slip here plays the wrong song, drops a queued one or stops early.
 * @covers packages/parrot-core/src/queue.ts
 */
import { describe, expect, it } from "bun:test";
import {
  addToQueue,
  advance,
  clearUpcoming,
  currentEntry,
  emptyQueue,
  goBack,
  jumpTo,
  nextRepeatMode,
  playNext,
  removeEntry,
  setRepeat,
  setShuffle,
  startQueue,
  upcoming,
  type PlayQueue,
} from "../src/queue";

const tracksOf = (queue: PlayQueue<string>) => queue.entries.map((entry) => entry.track);
const now = (queue: PlayQueue<string> | null) => (queue ? currentEntry(queue)?.track ?? null : null);
/** Reverses the list: a deterministic stand-in for Math.random in the Fisher-Yates shuffle. */
const reverse = () => 0;

describe("startQueue / advance / goBack", () => {
  it("plays from the chosen song to the end, then stops", () => {
    let queue: PlayQueue<string> | null = startQueue(["a", "b", "c"], 1);
    expect(now(queue)).toBe("b");
    queue = advance(queue, "ended");
    expect(now(queue)).toBe("c");
    expect(advance(queue!, "ended")).toBeNull();
    expect(now(goBack(queue!))).toBe("b");
    expect(now(goBack(startQueue(["a"], 0)))).toBe("a");
  });

  it("repeat all wraps around both ways; repeat one replays on end but a skip moves on", () => {
    const all = setRepeat(startQueue(["a", "b"], 1), "all");
    expect(now(advance(all, "ended"))).toBe("a");
    expect(now(goBack(jumpTo(all, 0)))).toBe("b");
    const one = setRepeat(startQueue(["a", "b"], 0), "one");
    expect(now(advance(one, "ended"))).toBe("a");
    expect(now(advance(one, "skip"))).toBe("b");
    expect(nextRepeatMode("off")).toBe("all");
    expect(nextRepeatMode("all")).toBe("one");
    expect(nextRepeatMode("one")).toBe("off");
  });

  it("an empty queue plays nothing", () => {
    expect(advance(emptyQueue<string>(), "skip")).toBeNull();
    expect(now(startQueue([], 0))).toBeNull();
  });
});

describe("playNext / addToQueue / removeEntry / clearUpcoming", () => {
  it("play next goes right after the current song, add to queue at the end", () => {
    let queue = startQueue(["a", "b", "c"], 0);
    queue = playNext(queue, ["x", "y"]);
    queue = addToQueue(queue, ["z"]);
    expect(tracksOf(queue)).toEqual(["a", "x", "y", "b", "c", "z"]);
    expect(now(queue)).toBe("a");
    expect(upcoming(queue).map((entry) => entry.track)).toEqual(["x", "y", "b", "c", "z"]);
  });

  it("into an empty queue the added songs start playing", () => {
    expect(now(addToQueue(emptyQueue<string>(), ["a", "b"]))).toBe("a");
    expect(now(playNext(emptyQueue<string>(), ["a"]))).toBe("a");
  });

  it("a song already played can be queued again: two entries; removing the played one keeps the other and the current song", () => {
    let queue = addToQueue(startQueue(["a", "b"], 1), ["a"]);
    expect(tracksOf(queue)).toEqual(["a", "b", "a"]);
    const [played, current, again] = queue.entries;
    queue = removeEntry(queue, played!.key);
    expect(queue.entries.map((entry) => entry.key)).toEqual([current!.key, again!.key]);
    expect(removeEntry(queue, currentEntry(queue)!.key)).toBe(queue);
    const later = removeEntry(jumpTo(startQueue(["a", "b", "c"], 0), 2), startQueue(["a", "b", "c"], 0).entries[0]!.key);
    expect(now(later)).toBe("c");
    expect(tracksOf(later)).toEqual(["b", "c"]);
  });

  it("clear keeps what played and the current song", () => {
    const queue = clearUpcoming(startQueue(["a", "b", "c"], 1));
    expect(tracksOf(queue)).toEqual(["a", "b"]);
    expect(advance(queue, "skip")).toBeNull();
  });
});

describe("setShuffle", () => {
  it("mixes only the songs to come and turning it off brings back the queued order", () => {
    const queue = startQueue(["a", "b", "c", "d"], 1);
    const on = setShuffle(queue, true, reverse);
    expect(tracksOf(on).slice(0, 2)).toEqual(["a", "b"]);
    expect(now(on)).toBe("b");
    expect([...tracksOf(on).slice(2)].sort()).toEqual(["c", "d"]);
    const off = setShuffle(on, false);
    expect(tracksOf(off)).toEqual(["a", "b", "c", "d"]);
    expect(now(off)).toBe("b");
  });

  it("starting a queue with shuffle on plays the chosen song first, then the rest mixed", () => {
    const queue = startQueue(["a", "b", "c", "d"], 2, { ...emptyQueue<string>(), shuffle: true }, reverse);
    expect(now(queue)).toBe("c");
    expect(queue.position).toBe(0);
    expect([...tracksOf(queue).slice(1)].sort()).toEqual(["a", "b", "d"]);
  });
});
