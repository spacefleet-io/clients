// Test-only time-fast-forward helper. When the env var
// `SF_TEST_FAST_FORWARD_SESSION_MINUTES=N` is set on app startup we report
// timestamps shifted N minutes into the past, simulating "the user has been
// idle for N minutes" without burning real wall-clock time in the test suite.
//
// This module deliberately does NOT mock `Date.now()` globally. Code paths that
// want fast-forward semantics must opt in by importing `getNow()` and using it
// instead of `Date.now()`. That keeps the surface auditable: a grep for
// `getNow(` shows every site that participates.
//
// When the env var is unset (or set to a non-positive integer) this is a strict
// no-op and `getNow()` returns `Date.now()`.

const parseMinutes = () => {
  const raw = process.env.SF_TEST_FAST_FORWARD_SESSION_MINUTES;
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
};

// Resolve the offset once at module load. The env var is intentionally read at
// startup only — flipping it after launch must not retroactively shift live
// timestamps in subtle ways.
const FAST_FORWARD_OFFSET_MS = parseMinutes() * 60 * 1000;

export const isTimeFastForwardEnabled = () => FAST_FORWARD_OFFSET_MS > 0;

export const getFastForwardOffsetMs = () => FAST_FORWARD_OFFSET_MS;

/**
 * Returns the current epoch ms, optionally shifted backwards by
 * SF_TEST_FAST_FORWARD_SESSION_MINUTES so callers see "the past". Use in place
 * of `Date.now()` only at session-expiry / idle-timeout call sites that want
 * to participate in the fast-forward override.
 */
export const getNow = (): number => {
  if (FAST_FORWARD_OFFSET_MS <= 0) return Date.now();
  return Date.now() - FAST_FORWARD_OFFSET_MS;
};
