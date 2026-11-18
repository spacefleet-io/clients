/**
 * @test-id PARROT-CORE-CARD-QUEUE-001
 * @level unit
 * @why A card's Play / Shuffle / Play next / Add to queue (PAR-CARD-01) must leave the queue in the order the queue view
 *   shows: Shuffle drops the old queue and plays every song of the item once, Play next puts the whole album right
 *   after the song playing (in album order, before what was queued), Add to queue puts it at the very end.
 * @covers packages/parrot-core/src/queue.ts
 */
import { describe, expect, it } from "bun:test";
import { addToQueue, currentEntry, playNext, shuffleQueue, startQueue, upcoming, type PlayQueue } from "../src/queue";

const log = (step: string, queue: PlayQueue<string>) =>
  console.log(
    `[PARROT-CORE-CARD-QUEUE-001] ${step}: now=${currentEntry(queue)?.track ?? "-"} order=${queue.entries.map((entry) => entry.track).join(",")} position=${queue.position} shuffle=${queue.shuffle} keys=${queue.entries.map((entry) => entry.key).join(",")}`
  );
const order = (queue: PlayQueue<string>) => queue.entries.map((entry) => entry.track);
const next = (queue: PlayQueue<string>) => upcoming(queue).map((entry) => entry.track);

/** A seeded generator, so a shuffle is random-looking yet the same on every run. */
const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const meltway = ["forecast", "dont-stay", "somewhere", "lying", "hit", "easier"];
const hybrid = ["paperboat", "one-step", "with-you"];

describe("card Play", () => {
  it("replaces whatever was queued with the album, from its first song", () => {
    const before = addToQueue(startQueue(hybrid, 1), ["extra"]);
    log("before", before);
    const after = startQueue(meltway, 0, { ...before, shuffle: false });
    log("after play", after);
    expect(currentEntry(after)?.track).toBe("forecast");
    expect(order(after)).toEqual(meltway);
    expect(after.queued.map((entry) => entry.track)).toEqual(meltway);
  });
});

describe("card Shuffle", () => {
  it("clears the old queue and plays each of the album's songs once, in a random order, with shuffle on", () => {
    const before = addToQueue(startQueue(hybrid, 0), ["extra"]);
    log("before", before);
    const after = shuffleQueue(meltway, before, seeded(7));
    log("after shuffle", after);
    expect(after.shuffle).toBe(true);
    expect(after.position).toBe(0);
    expect([...order(after)].sort()).toEqual([...meltway].sort());
    expect(order(after)).not.toEqual(meltway);
    expect(order(after).some((track) => hybrid.includes(track) || track === "extra")).toBe(false);
    // Keys stay unique across the old and new queue, so React and the queue view never mix two entries up.
    expect(after.entries.every((entry) => entry.key >= before.nextKey)).toBe(true);
  });

  it("starts from a random song, not always the first", () => {
    const firsts = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => currentEntry(shuffleQueue(meltway, undefined, seeded(seed)))?.track));
    console.log(`[PARROT-CORE-CARD-QUEUE-001] first songs over 8 seeds: ${[...firsts].join(",")}`);
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("keeps the repeat mode and an empty item plays nothing", () => {
    const repeating = { ...startQueue(hybrid, 0), repeat: "all" as const };
    expect(shuffleQueue(meltway, repeating, seeded(3)).repeat).toBe("all");
    const empty = shuffleQueue<string>([], repeating, seeded(3));
    log("empty", empty);
    expect(currentEntry(empty)).toBeNull();
  });
});

describe("card Play next / Add to queue", () => {
  it("Play next puts the album right after the song playing, before songs already queued", () => {
    const playing = addToQueue(startQueue(hybrid, 0), ["queued-1", "queued-2"]);
    log("before", playing);
    const after = playNext(playing, meltway);
    log("after play next", after);
    expect(currentEntry(after)?.track).toBe("paperboat");
    expect(next(after)).toEqual([...meltway, "one-step", "with-you", "queued-1", "queued-2"]);
  });

  it("Add to queue puts the album at the very end, after songs already queued", () => {
    const playing = playNext(startQueue(hybrid, 0), ["next-1"]);
    log("before", playing);
    const after = addToQueue(playing, meltway);
    log("after add to queue", after);
    expect(currentEntry(after)?.track).toBe("paperboat");
    expect(next(after)).toEqual(["next-1", "one-step", "with-you", ...meltway]);
  });

  it("two Play next in a row: the latest one plays first, as in streaming apps", () => {
    const after = playNext(playNext(startQueue(hybrid, 0), ["a1", "a2"]), ["b1"]);
    log("after two play next", after);
    expect(next(after)).toEqual(["b1", "a1", "a2", "one-step", "with-you"]);
  });

  it("with shuffle on, Play next still lands right after the current song", () => {
    const shuffled = shuffleQueue(hybrid, undefined, seeded(5));
    const after = playNext(shuffled, ["x1", "x2"]);
    log("shuffle + play next", after);
    expect(next(after).slice(0, 2)).toEqual(["x1", "x2"]);
  });

  it("with nothing playing, Play next and Add to queue start the album", () => {
    expect(currentEntry(playNext(startQueue<string>([], 0), meltway))?.track).toBe("forecast");
    expect(currentEntry(addToQueue(startQueue<string>([], 0), meltway))?.track).toBe("forecast");
  });
});
