/**
 * @test-id MPV-SUBS-001
 * @level unit
 * @why Under direct rendering (Android TV, `vo=mediacodec_embed`) mpv draws no subtitles; the app draws mpv's
 *   `sub-text` itself. Bugs here show no subtitles on TV, keep a stale line after "Off", or draw a second copy over
 *   mpv's own subtitles after the vo=gpu fallback.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: "android" },
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  },
  Text: "Text",
  View: "View",
}));

import { MpvSubtitleOverlay } from "../src/components/MpvSubtitleOverlay";
import { subscribeMpvSubtitles, type SubtitleEventSource } from "../src/hooks/useMpvSubtitle";
import {
  cleanSubtitleText,
  MPV_SUBTITLE_EVENT,
  type MpvSubtitleEvent,
  subtitleFontSize,
  subtitleOverlayModel,
  type SubtitleOverlayModel,
} from "../src/subtitleOverlay";

const event = (over: Partial<MpvSubtitleEvent> = {}): MpvSubtitleEvent => ({
  text: "Hello there",
  visible: true,
  directRender: true,
  x: 0,
  y: 67.5,
  width: 960,
  height: 405,
  ...over,
});

/** A stand-in for DeviceEventEmitter that lets the test fire the native event. */
const fakeSource = () => {
  let handler: ((payload: MpvSubtitleEvent) => void) | null = null;
  const remove = vi.fn(() => {
    handler = null;
  });
  const source: SubtitleEventSource = {
    addListener: vi.fn((name: string, h: (payload: MpvSubtitleEvent) => void) => {
      expect(name).toBe(MPV_SUBTITLE_EVENT);
      handler = h;
      return { remove };
    }),
  };
  return { source, remove, emit: (payload: MpvSubtitleEvent) => handler?.(payload) };
};
/** Renders the memo'd overlay's inner function (no renderer in this package). */
type ElementLike = { props: Record<string, unknown> & { children?: unknown; style?: unknown } } | null;
const renderOverlay = (subtitle: SubtitleOverlayModel | null): ElementLike => {
  const memoized: unknown = MpvSubtitleOverlay;
  if (!memoized || typeof memoized !== "object" || !("type" in memoized) || typeof memoized.type !== "function") {
    throw new Error("MpvSubtitleOverlay is not a React.memo component");
  }
  return memoized.type({ subtitle });
};

describe("subtitleOverlayModel — @req PLAT-TV-06", () => {
  it("draws the line inside the letterboxed video rect, sized from the video height", () => {
    expect(subtitleOverlayModel(event())).toEqual({
      text: "Hello there",
      x: 0,
      y: 67.5,
      width: 960,
      height: 405,
      fontSize: subtitleFontSize(405),
    });
    expect(subtitleFontSize(405)).toBe(21);
    expect(subtitleFontSize(540)).toBe(28);
    expect(subtitleFontSize(10_000)).toBe(64);
  });

  it("is hidden when mpv draws subtitles itself (vo=gpu fallback, phones)", () => {
    expect(subtitleOverlayModel(event({ directRender: false }))).toBeNull();
  });

  it("is hidden when subtitles are off (sub-visibility=no, or sid=no gives an empty line) — @req PLAY-TRACK-02", () => {
    expect(subtitleOverlayModel(event({ visible: false }))).toBeNull();
    expect(subtitleOverlayModel(event({ text: "" }))).toBeNull();
    expect(subtitleOverlayModel(event({ text: "  \n " }))).toBeNull();
    expect(subtitleOverlayModel(null)).toBeNull();
  });

  it("fills the player box with a TV-sized font until the video rect is known", () => {
    const model = subtitleOverlayModel(event({ width: 0, height: 0, x: 5, y: 5 }));
    expect(model).toMatchObject({ x: 0, y: 0, width: 0, height: 0, fontSize: 28 });
  });
});

describe("cleanSubtitleText — @req PLAT-TV-06", () => {
  it("keeps plain multi-line text", () => {
    expect(cleanSubtitleText("Line one\nLine two")).toBe("Line one\nLine two");
  });

  it("strips leaked ASS override blocks, escapes and HTML-ish tags", () => {
    expect(cleanSubtitleText("{\\an8}{\\i1}Hi{\\i0}\\Nthere\\hyou")).toBe("Hi\nthere you");
    expect(cleanSubtitleText("<i>Quiet</i> <font color=\"red\">now</font>")).toBe("Quiet now");
    expect(cleanSubtitleText("\r\n  a  \r\n\r\nb\r\n")).toBe("a\nb");
  });
});

describe("subscribeMpvSubtitles — @req PLAT-TV-06", () => {
  it("emits the line, then clears it when subtitles are turned off", () => {
    const { source, emit, remove } = fakeSource();
    const onChange = vi.fn();
    const unsubscribe = subscribeMpvSubtitles(source, onChange);

    emit(event({ text: "First line" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "First line" }));

    emit(event({ text: "" }));
    expect(onChange).toHaveBeenLastCalledWith(null);

    emit(event({ text: "Back", visible: false }));
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("reports only changes (no work for a repeated payload) — @req PLAT-TV-07", () => {
    const { source, emit } = fakeSource();
    const onChange = vi.fn();
    subscribeMpvSubtitles(source, onChange);

    emit(event({ text: "Same" }));
    emit(event({ text: "Same" }));
    emit(event({ text: "", directRender: false }));
    emit(event({ text: "", directRender: false }));
    expect(onChange.mock.calls).toEqual([[expect.objectContaining({ text: "Same" })], [null]]);
  });

  it("clears the line when the engine falls back to vo=gpu", () => {
    const { source, emit } = fakeSource();
    const onChange = vi.fn();
    subscribeMpvSubtitles(source, onChange);

    emit(event({ text: "Shown by the app" }));
    emit(event({ text: "", directRender: false }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("MpvSubtitleOverlay — @req PLAT-TV-06", () => {
  it("renders nothing without a line", () => {
    expect(renderOverlay(null)).toBeNull();
  });

  it("renders the line bottom-centred in the video rect, untouchable", () => {
    const model = subtitleOverlayModel(event({ text: "Over the picture" }));
    const el = renderOverlay(model);
    expect(el).not.toBeNull();
    expect(el!.props.pointerEvents).toBe("none");
    const style = Object.assign({}, ...(el!.props.style as object[]).flat());
    expect(style).toMatchObject({ position: "absolute", left: 0, top: 67.5, width: 960, height: 405, justifyContent: "flex-end", alignItems: "center" });
    const text = el!.props.children as { props: { children: string; style: object[] } };
    expect(text.props.children).toBe("Over the picture");
    expect(Object.assign({}, ...text.props.style)).toMatchObject({ color: "#ffffff", fontSize: 21, textAlign: "center" });
  });
});

// Keep React in scope for the JSX runtime used by the component under test.
void React;
