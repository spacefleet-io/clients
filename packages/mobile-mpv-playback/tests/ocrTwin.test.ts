/**
 * @test-id MPV-OCR-TWIN-001
 * @level unit
 * @why The Android TV renders with `vo=mediacodec_embed`: mpv draws nothing and the app draws text lines only, so a
 *   picture subtitle (PGS / VobSub) never shows there. The desktop runtime OCRs each picture track into an SRT
 *   "twin"; under direct rendering the twin is loaded in place of the picture, everywhere else the picture is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECT_RENDER_VO, directRenderOf, loadsOcrTwin, sidecarObjectKey, unplayableUnderDirectRender } from "../src/ocrTwin";
import type { SubtitleTrack } from "../src/types";

const dump = (label: string, state: unknown) => console.info(`[ocr-twin:${label}] ${JSON.stringify(state)}`);

const track = (over: Partial<SubtitleTrack>): SubtitleTrack => ({
  id: "fr-pgs",
  language: "fr",
  label: "Français",
  isDefault: false,
  format: "pgs",
  encrypted: false,
  url: "subs-fr-pgs/fre.sup",
  ocrTwin: { id: "fr-pgs-ocr", url: "subs-fr-pgs/fre.ocr.srt" },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("directRenderOf", () => {
  // @req PLAY-TRACK-05
  it("is true only on vo=mediacodec_embed and unknown before mpv has a VO", () => {
    const cases = [DIRECT_RENDER_VO, "gpu", "gpu-next", "", null] as const;
    const out = cases.map((currentVo) => directRenderOf(currentVo === null ? null : { currentVo }));
    dump("direct-render", { cases, out });
    expect(out).toEqual([true, false, false, null, null]);
  });
});

describe("sidecarObjectKey", () => {
  // @req PLAY-TRACK-05
  it("loads the twin's SRT for a PGS or VobSub track under direct rendering", () => {
    const pgs = sidecarObjectKey(track({}), true, "start");
    const vobsub = sidecarObjectKey(
      track({ id: "en-vob", format: "vobsub", url: "subs-en-vobsub/eng.mkv", ocrTwin: { id: "en-vob-ocr", url: "subs-en-vobsub/eng.srt" } }),
      true,
      "pick",
    );
    dump("direct", { pgs, vobsub });
    expect(pgs).toBe("subs-fr-pgs/fre.ocr.srt");
    expect(vobsub).toBe("subs-en-vobsub/eng.srt");
  });

  // @req PLAY-TRACK-05
  it("keeps the picture on phones, Apple TV and the GPU fallback, and without a twin", () => {
    const gpu = sidecarObjectKey(track({}), false, "render_switch");
    const noTwin = sidecarObjectKey(track({ ocrTwin: null }), true, "start");
    dump("picture", { gpu, noTwin });
    expect(gpu).toBe("subs-fr-pgs/fre.sup");
    expect(noTwin).toBe("subs-fr-pgs/fre.sup");
  });

  // @req PLAY-TRACK-05
  it("never touches a text track, even one carrying a stray twin", () => {
    const info = vi.spyOn(console, "info");
    const key = sidecarObjectKey(track({ format: "vtt", url: "subs-fr/fre.vtt" }), true, "pick");
    dump("text", { key, logs: info.mock.calls.length });
    expect(key).toBe("subs-fr/fre.vtt");
    expect(loadsOcrTwin(track({ format: "vtt" }), true)).toBe(false);
  });

  // @req PLAY-TRACK-05
  it("logs each picture-track decision with the picked id, twin id, direct rendering and reason", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    sidecarObjectKey(track({}), true, "quality_switch");
    sidecarObjectKey(track({ ocrTwin: null }), true, "start");
    sidecarObjectKey(track({}), false, "render_switch");
    const payloads = info.mock.calls.map(([event, payload]) => ({ event, payload: JSON.parse(String(payload)) as unknown }));
    dump("logs", payloads);
    expect(payloads).toEqual([
      {
        event: "[mpv-subtitles] sidecar.resolve",
        payload: { reason: "quality_switch", pickedId: "fr-pgs", format: "pgs", twinId: "fr-pgs-ocr", directRender: true, load: "ocr_twin", why: "direct_render" },
      },
      {
        event: "[mpv-subtitles] sidecar.resolve",
        payload: { reason: "start", pickedId: "fr-pgs", format: "pgs", twinId: null, directRender: true, load: "picture", why: "no_twin" },
      },
      {
        event: "[mpv-subtitles] sidecar.resolve",
        payload: { reason: "render_switch", pickedId: "fr-pgs", format: "pgs", twinId: "fr-pgs-ocr", directRender: false, load: "picture", why: "not_direct_render" },
      },
    ]);
  });
});

describe("unplayableUnderDirectRender", () => {
  // @req PLAY-TRACK-05
  it("flags only a picture track without a twin, and only under direct rendering", () => {
    const cases = {
      pgsNoTwinDirect: unplayableUnderDirectRender(track({ ocrTwin: null }), true),
      vobsubNoTwinDirect: unplayableUnderDirectRender(track({ format: "vobsub", ocrTwin: undefined }), true),
      pgsNoTwinGpu: unplayableUnderDirectRender(track({ ocrTwin: null }), false),
      pgsTwinDirect: unplayableUnderDirectRender(track({}), true),
      vttDirect: unplayableUnderDirectRender(track({ format: "vtt", ocrTwin: null }), true),
    };
    dump("unplayable", cases);
    expect(cases).toEqual({ pgsNoTwinDirect: true, vobsubNoTwinDirect: true, pgsNoTwinGpu: false, pgsTwinDirect: false, vttDirect: false });
  });
});
