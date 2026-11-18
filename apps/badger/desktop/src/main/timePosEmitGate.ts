/**
 * Rate gate for mpv's `time-pos` push events on their way out of main.
 *
 * mpv pushes `time-pos` once per displayed frame (24-60 Hz). Every push used to
 * cross the main→renderer IPC (structured clone + a renderer message dispatch)
 * although the renderer coalesces it to 250 ms (issue #25: ~60 emits/s at 60 fps
 * during playback on a low-end PC, main-process fixed cost).
 *
 * Semantics: leading edge fires at once when the window is open, further values
 * inside the window are coalesced and the LAST one is delivered when the window
 * closes (trailing edge) — the final position is never lost. The window length
 * is read per push so a hidden window (1 Hz consumers) can use a longer one; a
 * pending value already waiting on a longer window is released as soon as a push
 * shows the now-shorter window has elapsed (window shown again).
 * `flush()` delivers the pending value synchronously: callers use it before
 * emitting an event that must stay ordered after the exact position (pause,
 * eof-reached, end-file, ...).
 */
/** Window while the app window is visible: the progress bar and renderer throttle need ~4 Hz. */
export const TIME_POS_VISIBLE_EMIT_MS = 250;
/** Window while the app window is hidden: the renderer's hidden poll runs at 1 Hz. */
export const TIME_POS_HIDDEN_EMIT_MS = 1000;

export class TimePosEmitGate {
  private pending: { value: unknown } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;

  constructor(
    private readonly emit: (value: unknown) => void,
    private readonly windowMs: () => number,
  ) {}

  push(value: unknown): void {
    const windowMs = this.windowMs();
    const elapsed = Date.now() - this.lastEmitAt;
    if (elapsed >= windowMs) {
      this.clearTimer();
      this.pending = null;
      this.send(value);
      return;
    }
    this.pending = { value };
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, windowMs - elapsed);
    }
  }

  /** Deliver the pending value now (no-op when nothing is pending). */
  flush(): void {
    this.clearTimer();
    if (this.pending === null) return;
    const { value } = this.pending;
    this.pending = null;
    this.send(value);
  }

  /** Drop the pending value and the timer without delivering. */
  cancel(): void {
    this.clearTimer();
    this.pending = null;
  }

  private send(value: unknown): void {
    this.lastEmitAt = Date.now();
    this.emit(value);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
