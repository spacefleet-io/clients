/**
 * Cooperative running of the skip detector's long loops (MPV-PREV-07): the fingerprint and the matching run on the
 * runtime's main thread, so each is written once as a generator that `yield`s between units of work (a block of
 * audio frames, one episode pair). `runSteps` drives it straight through (same result, same cost); `runStepsYielding`
 * gives the event loop a turn whenever a slice of work has run, so requests, the player and timers keep answering
 * while a show with many episodes is matched. Both produce the same output from the same generator.
 */

/** Drive the generator to its end in one go and answer its result. */
export const runSteps = <T>(steps: Generator<void, T, void>): T => {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};

/** Default work slice: the event loop gets a turn after about this many milliseconds of detector work. */
export const SKIP_DETECT_SLICE_MS = 20;

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Drive the generator, giving the event loop a turn after each `sliceMs` of work. With `signal`, an abort stops the
 * work at the next turn (throws `CANCELLED`), so a pass told to give way frees the thread within a slice.
 */
export const runStepsYielding = async <T>(
  steps: Generator<void, T, void>,
  sliceMs = SKIP_DETECT_SLICE_MS,
  signal?: AbortSignal
): Promise<T> => {
  let sliceStart = performance.now();
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - sliceStart >= sliceMs) {
      await turn();
      if (signal?.aborted) throw new Error("CANCELLED");
      sliceStart = performance.now();
    }
  }
};
