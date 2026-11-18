import { overlayPaddingBottom, type SubtitleOverlayModel } from "./subtitleOverlay";

/**
 * Subtitles above the TV player's controls (MPV-OSC-02), the TV twin of the desktop OSC's `sf_update_sub_raise`
 * (`packages/mpv/resources/osc/tog4in1/tog4in1.lua`). While the controls show, the subtitle line sits above the bottom
 * control bar (timecodes + progress bar); when they hide it goes back to the user's place. Two paths:
 * - direct rendering (Android TV, PLAT-TV-06): the app draws the line itself (`MpvSubtitleOverlay`, text subtitles and
 *   the OCR text copies of picture subtitles), so the overlay is moved up by {@link overlayLift};
 * - mpv draws the subtitles (`vo=gpu` fallback, Apple TV): mpv's `sub-pos` is lowered by {@link createSubPosLift}.
 * Both measure from the bar's real top edge, reported by `PlayerControls` (`onControlsBottomInset`).
 */

/**
 * Space (design dp) kept between the subtitle line's bottom and the top of the control bar; multiplied by the controls'
 * `uiScale` (UX-TV-13) like the bar itself, so the lift is the same share of the screen at every TV scale.
 */
export const SUBTITLE_LIFT_GAP = 12;

/**
 * Distance (dp) from the bottom of the player box up to the top of the bottom control bar, from the bar's measured
 * layout (`barTop`, dp from the box top). 0 when either is not measured yet.
 */
export const controlsBottomInset = (boxHeight: number, barTop: number): number =>
  boxHeight > 0 && barTop >= 0 ? Math.max(0, Math.round(boxHeight - barTop)) : 0;

/**
 * How far (dp) to move the app-drawn line up so its bottom sits {@link SUBTITLE_LIFT_GAP} above the controls' top.
 * `controlsInset` 0 = controls hidden; 0 also when the line already sits higher (the user's place is never lowered).
 * `scale`: the controls' `uiScale` (default 1), applied to the gap; every other length is already on screen.
 */
export const overlayLift = ({ subtitle, boxHeight, controlsInset, scale = 1 }: {
  subtitle: SubtitleOverlayModel | null;
  boxHeight: number;
  controlsInset: number;
  scale?: number;
}): number => {
  if (!subtitle || boxHeight <= 0 || controlsInset <= 0) return 0;
  const known = subtitle.width > 0 && subtitle.height > 0;
  const frameBottom = known ? subtitle.y + subtitle.height : boxHeight;
  const lineAboveBoxBottom = boxHeight - frameBottom + overlayPaddingBottom(subtitle);
  return Math.max(0, Math.ceil(controlsInset + SUBTITLE_LIFT_GAP * scale - lineAboveBoxBottom));
};

/**
 * {@link overlayLift} held across the gaps between lines: with no line on screen the lift is measured from the last
 * line drawn, so while the controls show the next line appears already above them instead of sliding up from the bar.
 */
export const createOverlayLift = () => {
  let lastLine: SubtitleOverlayModel | null = null;
  return {
    next({ subtitle, boxHeight, controlsInset, scale = 1 }: {
      subtitle: SubtitleOverlayModel | null;
      boxHeight: number;
      controlsInset: number;
      scale?: number;
    }): number {
      if (subtitle) lastLine = subtitle;
      return overlayLift({ subtitle: lastLine, boxHeight, controlsInset, scale });
    },
  };
};

/**
 * mpv `sub-pos` (percent of the player height where the bottom line ends) that keeps mpv's subtitles above the
 * controls' top, never below the user's own `userPos` (like the desktop OSC). `boxHeight` and `controlsInset` are on
 * screen and the gap is multiplied by `scale` (the controls' `uiScale`), so the percentage is the same at every TV
 * scale: 960x540 at 1 and 1920x1080 at 2 both give floor((540 - 64 - 12) / 540 * 100) = 85.
 */
export const liftedSubPos = ({ boxHeight, controlsInset, userPos, scale = 1 }: {
  boxHeight: number;
  controlsInset: number;
  userPos: number;
  scale?: number;
}): number => {
  const pos = Math.floor(((boxHeight - controlsInset - SUBTITLE_LIFT_GAP * scale) / boxHeight) * 100);
  return Math.min(userPos, Math.max(0, Math.min(100, pos)));
};

/** The slice of `MpvControl` the `sub-pos` lift drives. */
export type SubPosTarget = {
  getSubPos: () => Promise<number>;
  setSubPos: (value: number) => Promise<boolean>;
};

export type SubPosLiftState = { raised: boolean; savedPos: number | null; appliedPos: number | null };

/**
 * Lowers mpv's `sub-pos` while the controls show and restores the user's value when they hide. Updates run one at a
 * time in call order. A `sub-pos` found different from the one this lift applied is the user's new place: it is kept
 * for the hide, and the lift is reapplied as `min(lift, new place)` (as on desktop, MPV-OSC-02 notes).
 */
export const createSubPosLift = (mpv: SubPosTarget) => {
  const state: SubPosLiftState = { raised: false, savedPos: null, appliedPos: null };
  let queue: Promise<void> = Promise.resolve();

  const apply = async (boxHeight: number, controlsInset: number, scale: number): Promise<void> => {
    if (controlsInset > 0 && boxHeight > 0) {
      const current = await mpv.getSubPos();
      if (!state.raised) {
        state.raised = true;
        state.savedPos = current;
      } else if (current !== state.appliedPos) {
        console.info(`[mpv-subtitles] lift: user moved sub-pos while lifted: ${current} (applied ${state.appliedPos}, saved ${state.savedPos})`);
        state.savedPos = current;
      }
      const pos = liftedSubPos({ boxHeight, controlsInset, userPos: state.savedPos ?? current, scale });
      state.appliedPos = pos;
      if (pos === current) return;
      await mpv.setSubPos(pos);
      console.info(`[mpv-subtitles] lift: controls shown, sub-pos ${current} -> ${pos} (bar inset ${controlsInset} of ${boxHeight} dp, scale ${scale})`);
      return;
    }
    if (!state.raised) return;
    const current = await mpv.getSubPos();
    const restore = current !== state.appliedPos ? current : (state.savedPos ?? current);
    state.raised = false;
    state.savedPos = null;
    state.appliedPos = null;
    if (restore !== current) await mpv.setSubPos(restore);
    console.info(`[mpv-subtitles] lift: controls hidden, sub-pos restored to ${restore}`);
  };

  return {
    /** `controlsInset` from {@link controlsBottomInset} while the controls show, 0 once they hide; `scale` = the controls' `uiScale` (default 1). */
    update: ({ boxHeight, controlsInset, scale = 1 }: { boxHeight: number; controlsInset: number; scale?: number }): Promise<void> => {
      queue = queue
        .then(() => apply(boxHeight, controlsInset, scale))
        .catch((error: unknown) => {
          console.warn(`[mpv-subtitles] lift: sub-pos update failed: ${String(error)}`, JSON.stringify(state));
        });
      return queue;
    },
    dump: (): SubPosLiftState => ({ ...state }),
  };
};
