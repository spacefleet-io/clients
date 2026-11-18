import { describe, expect, test } from "bun:test";
import type { TrackFileRow } from "../src/catalog";
import { chooseParrotCopy, createParrotCopyPicker, parrotCopyLadder, PARROT_LIGHT_COPY } from "../src/copies";

/** Store rows carry more columns than `TrackFileRow` reads (codec, container…); the picker ignores them. */
const file = (over: Record<string, unknown>): TrackFileRow =>
  ({
    id: "tf-original",
    trackId: "tr-1",
    codec: "flac",
    container: "flac",
    mime: "audio/flac",
    lossless: true,
    bitrateKbps: 900,
    sampleRate: 44_100,
    sizeBytes: 30_000_000,
    lightCopy: false,
    createdAt: 1,
    chunks: [],
    ...over,
  }) as TrackFileRow;

const original = file({});
const light = file({
  id: "tf-light",
  codec: "opus",
  container: "ogg",
  mime: PARROT_LIGHT_COPY.mime,
  lossless: false,
  bitrateKbps: 64,
  sampleRate: 48_000,
  sizeBytes: 2_000_000,
  lightCopy: true,
});

describe("parrotCopyLadder", () => {
  test("the original first, the light copy last; what the player cannot decode left out", () => {
    expect(parrotCopyLadder([light, original]).map((f) => f.id)).toEqual(["tf-original", "tf-light"]);
    expect(parrotCopyLadder([light, original], (mime) => mime !== "audio/flac").map((f) => f.id)).toEqual(["tf-light"]);
  });
});

describe("chooseParrotCopy", () => {
  const choose = (throughputBps: number | null, previousKbps: number | null = null) =>
    chooseParrotCopy({ files: [original, light], durationMs: 240_000, throughputBps, previousKbps })!.id;

  test("the original while unmeasured or fast enough", () => {
    expect(choose(null)).toBe("tf-original");
    expect(choose(5_000_000)).toBe("tf-original");
  });

  test("the light copy when the connection cannot keep up with the original", () => {
    expect(choose(600_000)).toBe("tf-light");
    expect(choose(10_000)).toBe("tf-light");
  });

  test("climbing back needs headroom over the original's bitrate", () => {
    // 1.2 Mbps: enough for 900 kbps after the safety factor, not with the climb's headroom.
    expect(choose(1_200_000, 64)).toBe("tf-light");
    expect(choose(1_200_000, null)).toBe("tf-original");
    expect(choose(2_000_000, 64)).toBe("tf-original");
  });
});

describe("createParrotCopyPicker", () => {
  test("drops to the light copy on a slow connection and returns to the original once it recovers", () => {
    const picker = createParrotCopyPicker();
    expect(picker.pick([original, light], 240_000)!.id).toBe("tf-original");
    // 1 MiB chunks taking 20 s each: ~420 kbps.
    for (let i = 0; i < 4; i += 1) picker.record(1 << 20, 20_000);
    expect(picker.pick([original, light], 240_000)!.id).toBe("tf-light");
    // Fast again: 1 MiB in 100 ms (~84 Mbps).
    for (let i = 0; i < 8; i += 1) picker.record(1 << 20, 100);
    expect(picker.pick([original, light], 240_000)!.id).toBe("tf-original");
  });

  test("one slow download after a fast start drops the next song at once", () => {
    const picker = createParrotCopyPicker();
    for (let i = 0; i < 8; i += 1) picker.record(1 << 20, 100);
    expect(picker.pick([original, light], 240_000)!.id).toBe("tf-original");
    picker.record(1 << 20, 20_000);
    expect(picker.pick([original, light], 240_000)!.id).toBe("tf-light");
  });

  test("small downloads are not measured", () => {
    const picker = createParrotCopyPicker();
    picker.record(1000, 10_000);
    expect(picker.throughputBps()).toBeNull();
  });
});
