/**
 * @test-id MOBILE-PLAYBACK-SIDECAR-SUBTITLE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: the quality-switch fallback reloads the file with `loadfile replace`, which
 * drops every sidecar subtitle added with `sub-add`. The reload restored `sid=N` but the track no
 * longer existed, so subtitles vanished while the controls still showed them selected (picking the
 * same one again was a no-op). The switch must re-add the active sidecar after the reload; these
 * helpers decide which one and where to fetch it from.
 */
import { describe, expect, it } from "vitest";
import type { MpvTrack, SubtitleTrack } from "@space/mobile-mpv-playback";
import { findActiveSidecar, sidecarSubtitleUrl } from "../src/lib/playback/sidecarSubtitle";

const TAG = "[playback-sidecar-subtitle]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const sub = (id: string, language: string, label: string): SubtitleTrack => ({
  id,
  language,
  label,
  isDefault: false,
  format: "vtt",
  url: `subs/${id}.vtt`,
}) as SubtitleTrack;

const track = (over: Partial<MpvTrack>): MpvTrack => ({
  id: 1,
  type: "sub",
  selected: false,
  lang: null,
  title: null,
  external: true,
  ...over,
});

const subs = [sub("s1", "en", "English"), sub("s2", "fr", "Français")];

describe("active sidecar subtitle detection", () => {
  it("@bugfix @regression-proof picks the selected external subtitle by its title", () => {
    const active = findActiveSidecar(
      [track({ id: 3, title: "English" }), track({ id: 4, title: "Français", selected: true })],
      subs,
    );
    log("active", active);
    expect(active?.id).toBe("s2");
  });

  it("@bugfix @regression-proof falls back to the language when the title is empty", () => {
    expect(findActiveSidecar([track({ id: 3, lang: "en", selected: true })], subs)?.id).toBe("s1");
  });

  it("@bugfix @regression-proof ignores selected embedded subtitles and unselected sidecars", () => {
    expect(findActiveSidecar([track({ title: "English", selected: true, external: false })], subs)).toBeNull();
    expect(findActiveSidecar([track({ title: "English", selected: false })], subs)).toBeNull();
    expect(findActiveSidecar([track({ type: "audio", title: "English", selected: true })], subs)).toBeNull();
  });
});

describe("sidecar subtitle url", () => {
  it("@bugfix @regression-proof is the local proxy's object url for the subtitle key", () => {
    expect(sidecarSubtitleUrl("http://127.0.0.1:4455/playback/master.m3u8", sub("s1", "en", "English"), false, "start")).toBe(
      "http://127.0.0.1:4455/playback/object/subs%2Fs1.vtt",
    );
  });

  const pgs: SubtitleTrack = {
    id: "pgs-fr",
    language: "fr",
    label: "Français",
    isDefault: false,
    format: "pgs",
    encrypted: false,
    url: "subs-fr-pgs/fre.sup",
    ocrTwin: { id: "pgs-fr-ocr", url: "subs-fr-pgs/fre.ocr.srt" },
  };

  // @req PLAY-TRACK-05
  it("loads a picture track's OCR twin under direct rendering, the picture itself otherwise", () => {
    const playUrl = "http://127.0.0.1:4455/playback/master.m3u8";
    const direct = sidecarSubtitleUrl(playUrl, pgs, true, "quality_switch");
    const gpu = sidecarSubtitleUrl(playUrl, pgs, false, "render_switch");
    const noTwin = sidecarSubtitleUrl(playUrl, { ...pgs, ocrTwin: null }, true, "start");
    log("urls", { direct, gpu, noTwin });
    expect(direct).toBe("http://127.0.0.1:4455/playback/object/subs-fr-pgs%2Ffre.ocr.srt");
    expect(gpu).toBe("http://127.0.0.1:4455/playback/object/subs-fr-pgs%2Ffre.sup");
    expect(noTwin).toBe("http://127.0.0.1:4455/playback/object/subs-fr-pgs%2Ffre.sup");
  });

  // @req PLAY-TRACK-05
  it("re-finds the picture track (and its twin) from the twin loaded under the picture's title", () => {
    const active = findActiveSidecar([track({ id: 5, title: "Français", lang: "fr", selected: true })], [...subs, pgs]);
    log("active twin sidecar", active);
    expect(active?.id).toBe("s2");
    const onlyPicture = findActiveSidecar([track({ id: 5, title: "Français", lang: "fr", selected: true })], [pgs]);
    log("active picture", onlyPicture);
    expect(onlyPicture?.id).toBe("pgs-fr");
    expect(onlyPicture?.ocrTwin?.id).toBe("pgs-fr-ocr");
  });
});
