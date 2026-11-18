/**
 * @test-id MPV-SUBPICK-001
 * @level unit
 * @req PLAY-TRACK-06[badger-mobile,badger-tv]
 * @why A subtitle the user picks on the phone can fail to load (the playback proxy answers 502/404 for its
 *   object, the file is unreadable). Native `addSubtitle` then rejects (`subtitle_load_failed`). The controls
 *   must say so with the "Subtitles couldn't load" notice, put the previous subtitle back in mpv and in the
 *   menu, and not remember the failed pick, instead of silently leaving subtitles off.
 */
import { describe, expect, it, vi } from "vitest";
import { applySubtitlePick, type SubtitlePickPlayer } from "../src/subtitlePick";
import { sidecarObjectKey } from "../src/ocrTwin";
import type { SubtitleTrack } from "../src/types";

const track = (id: string, language: string, format: SubtitleTrack["format"]): SubtitleTrack => ({
  id,
  language,
  label: language.toUpperCase(),
  isDefault: false,
  format,
  encrypted: true,
  url: `subs-${id}/${language}.${format === "pgs" ? "sup" : "vtt"}`,
});

const TRACKS = [track("en", "en", "vtt"), track("fr", "fr", "pgs"), track("de", "de", "vtt")];
const urlFor = (sub: SubtitleTrack) => `http://127.0.0.1:9/playback/object/${encodeURIComponent(sub.url)}`;

/** Fake player whose `addSubtitle` rejects for the URLs in `failing`, recording every call. */
const fakePlayer = (failing: string[]) => {
  const calls: string[] = [];
  const player: SubtitlePickPlayer = {
    removeAllSubtitles: vi.fn(async () => { calls.push("removeAll"); return true; }),
    addSubtitle: vi.fn(async (url: string) => {
      calls.push(`add ${url}`);
      if (failing.includes(url)) {
        throw Object.assign(new Error(`sub-add did not add a track: ${url}`), { code: "subtitle_load_failed" });
      }
      return true;
    }),
  };
  return { player, calls };
};

const effects = () => {
  const history: number[] = [];
  const notices: string[] = [];
  const picked: Array<string | null> = [];
  return {
    history,
    notices,
    picked,
    effects: {
      setActiveIdx: (idx: number) => { history.push(idx); },
      showLoadFailed: () => { notices.push("Subtitles couldn't load"); },
      onPicked: (t: SubtitleTrack | null) => { picked.push(t?.id ?? null); },
    },
  };
};

const dump = (label: string, state: Record<string, unknown>) =>
  console.info(`[subtitle-pick:${label}] ${JSON.stringify(state)}`);

describe("applySubtitlePick (PLAY-TRACK-06)", () => {
  it("shows the notice and restores the previous subtitle when the picked one fails to load", async () => {
    const { player, calls } = fakePlayer([urlFor(TRACKS[1])]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: 1, previousIdx: 0, subtitleTracks: TRACKS, urlFor }, fx.effects);
    dump("fail-restore", { outcome, calls, history: fx.history, notices: fx.notices, picked: fx.picked });
    expect(outcome).toBe("load_failed");
    expect(fx.notices).toEqual(["Subtitles couldn't load"]);
    expect(fx.history.at(-1)).toBe(0);
    expect(calls).toEqual(["removeAll", `add ${urlFor(TRACKS[1])}`, `add ${urlFor(TRACKS[0])}`]);
    expect(fx.picked).toEqual([]);
  });

  it("goes back to Off when subtitles were off before the failed pick", async () => {
    const { player, calls } = fakePlayer([urlFor(TRACKS[2])]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: 2, previousIdx: -1, subtitleTracks: TRACKS, urlFor }, fx.effects);
    dump("fail-off", { outcome, calls, history: fx.history, notices: fx.notices, picked: fx.picked });
    expect(outcome).toBe("load_failed");
    expect(fx.notices).toHaveLength(1);
    expect(fx.history).toEqual([2, -1]);
    expect(calls).toEqual(["removeAll", `add ${urlFor(TRACKS[2])}`]);
    expect(fx.picked).toEqual([]);
  });

  it("shows Off when the previous subtitle cannot be put back either", async () => {
    const { player, calls } = fakePlayer([urlFor(TRACKS[0]), urlFor(TRACKS[1])]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: 1, previousIdx: 0, subtitleTracks: TRACKS, urlFor }, fx.effects);
    dump("fail-restore-fail", { outcome, calls, history: fx.history, notices: fx.notices });
    expect(outcome).toBe("load_failed");
    expect(fx.notices).toHaveLength(1);
    expect(fx.history).toEqual([1, 0, -1]);
  });

  it("keeps a pick that loads, with no notice, and remembers it", async () => {
    const { player, calls } = fakePlayer([]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: 1, previousIdx: 0, subtitleTracks: TRACKS, urlFor }, fx.effects);
    dump("ok", { outcome, calls, history: fx.history, notices: fx.notices, picked: fx.picked });
    expect(outcome).toBe("ok");
    expect(fx.notices).toEqual([]);
    expect(fx.history).toEqual([1]);
    expect(fx.picked).toEqual(["fr"]);
  });

  /** @req PLAY-TRACK-02[badger-mobile,badger-tv] */
  it("turns subtitles off without loading anything", async () => {
    const { player, calls } = fakePlayer([]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: -1, previousIdx: 1, subtitleTracks: TRACKS, urlFor }, fx.effects);
    dump("off", { outcome, calls, history: fx.history, picked: fx.picked });
    expect(outcome).toBe("ok");
    expect(calls).toEqual(["removeAll"]);
    expect(fx.picked).toEqual([null]);
    expect(fx.notices).toEqual([]);
  });
});

describe("applySubtitlePick with an OCR twin (PLAY-TRACK-05)", () => {
  const pgsWithTwin: SubtitleTrack = { ...track("fr", "fr", "pgs"), ocrTwin: { id: "fr-ocr", url: "subs-fr/fr.ocr.srt" } };
  const twinTracks = [track("en", "en", "vtt"), pgsWithTwin];
  const urlForVo = (directRender: boolean) => (sub: SubtitleTrack) =>
    `http://127.0.0.1:9/playback/object/${encodeURIComponent(sidecarObjectKey(sub, directRender, "pick"))}`;

  // @req PLAY-TRACK-05
  it("a manual pick of a PGS track loads its twin under direct rendering, the picture elsewhere; the pick stays the picture track", async () => {
    for (const directRender of [true, false]) {
      const { player, calls } = fakePlayer([]);
      const fx = effects();
      const outcome = await applySubtitlePick(
        player,
        { idx: 1, previousIdx: 0, subtitleTracks: twinTracks, urlFor: urlForVo(directRender) },
        fx.effects,
      );
      dump(`twin-pick directRender=${directRender}`, { outcome, calls, history: fx.history, picked: fx.picked });
      expect(outcome).toBe("ok");
      expect(calls).toEqual([
        "removeAll",
        `add http://127.0.0.1:9/playback/object/${encodeURIComponent(directRender ? "subs-fr/fr.ocr.srt" : "subs-fr/fr.sup")}`,
      ]);
      expect(fx.picked).toEqual(["fr"]);
    }
  });

  // @req PLAY-TRACK-05
  it("a twin that fails to load restores the previous subtitle and is not remembered", async () => {
    const urlFor = urlForVo(true);
    const { player, calls } = fakePlayer([urlFor(pgsWithTwin)]);
    const fx = effects();
    const outcome = await applySubtitlePick(player, { idx: 1, previousIdx: 0, subtitleTracks: twinTracks, urlFor }, fx.effects);
    dump("twin-fail", { outcome, calls, history: fx.history, notices: fx.notices, picked: fx.picked });
    expect(outcome).toBe("load_failed");
    expect(calls.at(-1)).toBe(`add ${urlFor(twinTracks[0]!)}`);
    expect(fx.picked).toEqual([]);
  });
});
