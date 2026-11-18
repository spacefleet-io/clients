// Pure maths of the volume slider (no React Native import, so it unit-tests in node).

export const clampLevel = (level: number): number => (Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0);

/** Level under a finger at `x` along a track `width` wide (0 at the left end, 1 at the right). */
export const levelAt = (x: number, width: number): number => (width > 0 ? clampLevel(x / width) : 0);

/** One accessibility increment / decrement step from `level` (`step` is a fraction of the range). */
export const stepLevel = (level: number, direction: 1 | -1, step: number): number =>
  clampLevel(Math.round((clampLevel(level) + direction * step) * 1000) / 1000);

/** Whole percent, for the accessibility value. */
export const percentOf = (level: number): number => Math.round(clampLevel(level) * 100);
