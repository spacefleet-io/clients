/**
 * Subtitles drawn by the app (PLAT-TV-06). On Android TV mpv renders straight from the hardware decoder
 * (`vo=mediacodec_embed`) and draws no subtitles; the native view sends the current line (`sub-text`) and the
 * video's rect as the `MpvSubtitle` device event, once per change, and `MpvPlayer` draws it over the picture.
 */

/** Device event emitted by `MpvSurfaceView.publishSubtitle` (Android). */
export const MPV_SUBTITLE_EVENT = "MpvSubtitle";

/** Payload of {@link MPV_SUBTITLE_EVENT}. Rect in dp, relative to the box the player was laid out in. */
export type MpvSubtitleEvent = {
  /** mpv `sub-text`: the line showing now, "" between lines or with subtitles off. */
  text: string;
  /** mpv `sub-visibility`. */
  visible: boolean;
  /** True while mpv renders with `vo=mediacodec_embed`; false means mpv draws subtitles itself. */
  directRender: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** What the overlay draws; `null` = nothing. */
export type SubtitleOverlayModel = {
  text: string;
  /** Video rect (dp) inside the player box; the line sits at its bottom centre. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

/** Line height relative to the video's height (mpv's default: 55 at 720 scaled-px ≈ 5.3 %), clamped for tiny / huge boxes. */
const FONT_RATIO = 0.052;
const MIN_FONT = 14;
const MAX_FONT = 64;
/** Before the native side reported the video rect: fits a 540 dp TV window. */
const DEFAULT_FONT = 28;
/** Bottom padding (dp) before the video rect is known: the line then fills the whole player box. */
const UNKNOWN_FRAME_PADDING = 27;

/**
 * Space (dp) between the bottom of the overlay's frame and the line: mpv's own bottom margin is ~3 % of the picture;
 * 5 % keeps a two-line cue clear of the TV's overscan.
 */
export const overlayPaddingBottom = (subtitle: SubtitleOverlayModel): number =>
  subtitle.width > 0 && subtitle.height > 0 ? Math.round(subtitle.height * 0.05) : UNKNOWN_FRAME_PADDING;

/**
 * Plain text from `sub-text`. mpv already strips formatting, but a malformed ASS event can leak `{\…}` override
 * blocks, `\N` / `\n` / `\h` escapes or `<i>`-style tags; those are removed so the overlay never shows markup.
 */
export const cleanSubtitleText = (raw: string): string =>
  raw
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

/** Font size (dp) for a video of `height` dp. */
export const subtitleFontSize = (height: number): number =>
  Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, height * FONT_RATIO)));

/**
 * The overlay for a subtitle event: hidden when mpv draws subtitles itself (no direct rendering), when subtitles are
 * off (`sub-visibility=no`, or no line because `sid=no`), or between lines.
 */
export const subtitleOverlayModel = (event: MpvSubtitleEvent | null): SubtitleOverlayModel | null => {
  if (!event || !event.directRender || !event.visible) return null;
  const text = cleanSubtitleText(event.text ?? "");
  if (!text) return null;
  const valid = event.width > 0 && event.height > 0;
  return {
    text,
    x: valid ? event.x : 0,
    y: valid ? event.y : 0,
    width: valid ? event.width : 0,
    height: valid ? event.height : 0,
    fontSize: valid ? subtitleFontSize(event.height) : DEFAULT_FONT,
  };
};

/** True when two models draw the same thing (the hook skips a re-render otherwise). */
export const sameSubtitleOverlay = (a: SubtitleOverlayModel | null, b: SubtitleOverlayModel | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.text === b.text && a.x === b.x && a.y === b.y && a.width === b.width &&
    a.height === b.height && a.fontSize === b.fontSize);
