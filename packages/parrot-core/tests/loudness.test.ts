import { describe, expect, it } from "bun:test";
import { startQueue } from "../src/queue";
import {
  PARROT_EVEN_VOLUME_DEFAULT,
  PARROT_EVEN_VOLUME_LEVELS,
  PARROT_EVEN_VOLUME_TARGET_LUFS,
  measureParrotLoudness,
  parrotAlbumLoudness,
  parrotEvenVolumeLimits,
  parrotEvenVolumeStorageKey,
  parrotLoudnessMode,
  parrotPlaybackGainDb,
  parrotQueueGainsDb,
  parseParrotEvenVolume,
  type ParrotLoudnessTrack,
} from "../src/loudness";

const TAG = "[PARROT-CORE-LOUDNESS]";

const sine = (hz: number, amplitude: number, seconds: number, rate = 48_000) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / rate));

const song = (id: string, albumId: string, number: number, gainDb: number | null, peak = 0.1): ParrotLoudnessTrack => ({
  id, albumId, disc: 1, number, durationMs: 60_000, gainDb, peak,
});

describe("Even out volume (PAR-PLAY-03 item 2)", () => {
  // @req PAR-PLAY-03
  it("measures a full-scale 1 kHz sine in one channel at −3.01 LUFS (BS.1770-4's check), at 44.1 and 48 kHz", () => {
    for (const rate of [44_100, 48_000]) {
      const measured = measureParrotLoudness([sine(997, 1, 5, rate)], rate)!;
      expect(measured.lufs).toBeCloseTo(-3.01, 1);
      expect(measured.gainDb).toBeCloseTo(-14.99, 1);
      expect(measured.peak).toBeCloseTo(1, 2);
    }
  });

  // @req PAR-PLAY-03
  it("brings a loud and a quiet song to the same loudness", () => {
    const loud = measureParrotLoudness([sine(440, 0.9, 5), sine(440, 0.9, 5)], 48_000)!;
    const quiet = measureParrotLoudness([sine(440, 0.05, 5), sine(440, 0.05, 5)], 48_000)!;
    expect(loud.lufs - quiet.lufs).toBeCloseTo(20 * Math.log10(0.9 / 0.05), 1);
    expect(loud.lufs + loud.gainDb).toBeCloseTo(quiet.lufs + quiet.gainDb, 6);
  });

  // @req PAR-PLAY-03
  it("finds nothing to measure in silence", () => {
    expect(measureParrotLoudness([new Float32Array(48_000 * 2)], 48_000)).toBeNull();
  });

  // @req PAR-PLAY-03
  it("measures the true peak, between the samples (BS.1770-4 Annex 2)", () => {
    // A 12 kHz sine at 48 kHz whose samples all fall at ±0.707: its waveform still reaches 1.
    const rate = 48_000;
    const between = Float32Array.from({ length: rate * 2 }, (_, index) => Math.sin(Math.PI / 4 + (Math.PI / 2) * index));
    const measured = measureParrotLoudness([between], rate)!;
    console.info(TAG, "[true-peak] sample peak 0.7071, true peak", measured.peak);
    expect(measured.peak).toBeGreaterThan(0.97);
    expect(measured.peak).toBeLessThan(1.03);
  });

  // @req PAR-PLAY-03
  it("plays every song as recorded while the setting is off (the default)", () => {
    const tracks = [song("a1", "A", 1, -6), song("a2", "A", 2, 4)];
    const albums = parrotAlbumLoudness(tracks);
    expect(PARROT_EVEN_VOLUME_DEFAULT).toEqual({ on: false, level: "normal" });
    for (const track of tracks) {
      expect(parrotPlaybackGainDb(track, "album", albums, PARROT_EVEN_VOLUME_DEFAULT)).toBe(0);
      expect(parrotPlaybackGainDb(track, "track", albums, { on: false, level: "loud" })).toBe(0);
    }
    expect(parrotQueueGainsDb(tracks, true, PARROT_EVEN_VOLUME_DEFAULT)).toEqual({ a1: 0, a2: 0 });
  });

  // @req PAR-PLAY-03
  it("brings a song to each level: Loud −11, Normal −14, Quiet −19 LUFS", () => {
    // Stored −2 dB to −18 LUFS: the song is at −16 LUFS, with plenty of headroom (peak −20 dBFS).
    const track = song("x", "X", 1, -2);
    const gains = Object.fromEntries(PARROT_EVEN_VOLUME_LEVELS.map((level) => [level, parrotPlaybackGainDb(track, "track", new Map(), { on: true, level })]));
    console.info(TAG, "[levels] gains for a −16 LUFS song", gains);
    expect(gains.loud).toBeCloseTo(5, 6);
    expect(gains.normal).toBeCloseTo(2, 6);
    expect(gains.quiet).toBeCloseTo(-3, 6);
    expect(PARROT_EVEN_VOLUME_TARGET_LUFS).toEqual({ loud: -11, normal: -14, quiet: -19 });
  });

  // @req PAR-PLAY-03
  it("uses the album's value for an album in order, each song's own on shuffle or a mixed queue", () => {
    const quiet = { on: true, level: "quiet" } as const;
    const tracks = [song("a1", "A", 1, -6), song("a2", "A", 2, 4), song("b1", "B", 1, 0)];
    const albums = parrotAlbumLoudness(tracks);
    // Equal lengths: −18 − 10·log10(mean of 10^(L/10)) with L = −12 and −22.
    const expected = -18 - 10 * Math.log10((10 ** (-12 / 10) + 10 ** (-22 / 10)) / 2);
    expect(albums.get("A")!.gainDb).toBeCloseTo(expected, 6);
    const inOrder = startQueue([tracks[0]!, tracks[1]!], 0);
    expect(parrotLoudnessMode(inOrder)).toBe("album");
    expect(parrotLoudnessMode({ ...inOrder, shuffle: true })).toBe("track");
    expect(parrotLoudnessMode(startQueue([tracks[1]!, tracks[0]!], 0))).toBe("track");
    expect(parrotLoudnessMode(startQueue(tracks, 0))).toBe("track");
    // Quiet is −19 LUFS, one dB under the stored reference of −18.
    const album = parrotPlaybackGainDb(tracks[1]!, "album", albums, quiet);
    const own = parrotPlaybackGainDb(tracks[1]!, "track", albums, quiet);
    console.info(TAG, "[album] a2 under Quiet", { album, own });
    expect(album).toBeCloseTo(expected - 1, 6);
    expect(own).toBeCloseTo(3, 6);
  });

  // @req PAR-PLAY-03
  it("Normal and Quiet lift a song only up to 1 dB under its true peak; Loud lifts it all the way", () => {
    // Spotify's example: −20 LUFS (stored +2 dB) with a −5 dBFS true peak plays at −16 LUFS under Normal.
    const track = { ...song("x", "X", 1, 2), peak: 10 ** (-5 / 20) };
    const normal = parrotPlaybackGainDb(track, "track", new Map(), { on: true, level: "normal" });
    const loud = parrotPlaybackGainDb(track, "track", new Map(), { on: true, level: "loud" });
    console.info(TAG, "[headroom] −20 LUFS, −5 dBFS peak", { normal, loud });
    expect(normal).toBeCloseTo(4, 6);
    expect(loud).toBeCloseTo(9, 6);
    // A song already at its ceiling is not lifted; one louder than the level is still turned down; no peak, no lift.
    expect(parrotPlaybackGainDb({ ...track, peak: 0.95 }, "track", new Map(), { on: true, level: "normal" })).toBe(0);
    expect(parrotPlaybackGainDb({ ...song("y", "Y", 1, -10), peak: 1 }, "track", new Map(), { on: true, level: "normal" })).toBeCloseTo(-6, 6);
    expect(parrotPlaybackGainDb({ ...track, peak: null }, "track", new Map(), { on: true, level: "quiet" })).toBe(0);
    expect(parrotPlaybackGainDb(song("z", "Z", 1, null), "track", new Map(), { on: true, level: "loud" })).toBe(0);
  });

  // @req PAR-PLAY-03
  it("takes the files' own album tag when every song carries the same one", () => {
    const tagged = [{ ...song("a1", "A", 1, -6), albumGainDb: -3, albumPeak: 0.4 }, { ...song("a2", "A", 2, null), albumGainDb: -3, albumPeak: 0.4 }];
    expect(parrotAlbumLoudness(tagged).get("A")).toEqual({ gainDb: -3, peak: 0.4 });
  });

  // @req PAR-PLAY-03
  it("reads the stored setting, falling back to off and Normal", () => {
    expect(parrotEvenVolumeStorageKey("u1")).toBe("parrot.evenVolume.u1");
    expect(parseParrotEvenVolume(null)).toEqual(PARROT_EVEN_VOLUME_DEFAULT);
    expect(parseParrotEvenVolume("not json")).toEqual(PARROT_EVEN_VOLUME_DEFAULT);
    expect(parseParrotEvenVolume(JSON.stringify({ on: true, level: "loud" }))).toEqual({ on: true, level: "loud" });
    expect(parseParrotEvenVolume(JSON.stringify({ on: true, level: "max" }))).toEqual({ on: true, level: "normal" });
    expect(parrotEvenVolumeLimits({ on: true, level: "loud" })).toBe(true);
    expect(parrotEvenVolumeLimits({ on: false, level: "loud" })).toBe(false);
    expect(parrotEvenVolumeLimits({ on: true, level: "normal" })).toBe(false);
  });

  it("@req PAR-PLAY-03 the phone's queue gains: album values for one album in order, track values on shuffle", () => {
    const normal = { on: true, level: "normal" } as const;
    const songs = [
      { id: "a", albumId: "al", disc: 1, number: 1, durationMs: 1000, gainDb: -10, peak: 0.1 },
      { id: "b", albumId: "al", disc: 1, number: 2, durationMs: 1000, gainDb: 2, peak: 0.1 },
    ];
    const ordered = parrotQueueGainsDb(songs, false, normal);
    const shuffled = parrotQueueGainsDb(songs, true, normal);
    console.log("[PARROT-CORE-LOUDNESS] queue gains", { ordered, shuffled });
    expect(ordered.a).toBeCloseTo(ordered.b!, 6);
    expect(shuffled).toEqual({ a: -6, b: 6 });
    expect(parrotQueueGainsDb([{ id: "c", albumId: "al", disc: 1, number: 1, durationMs: 1000 }], false, normal)).toEqual({ c: 0 });
  });
});
