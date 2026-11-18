/**
 * Collapses bursts of "the library changed, re-read it" into few refreshes. The first call runs at once (a title
 * the user just matched shows its copy without delay); calls within `minGapMs` of the last refresh collapse into one
 * trailing refresh. Used by the artwork copy: a migration applies one title every few seconds, and re-reading the
 * whole library after each would re-render it the whole time.
 */
export interface CoalescedRefresh {
  request(): void;
  /** Drops a pending trailing refresh (the library closed). */
  cancel(): void;
}

export const coalesceRefresh = (
  refresh: () => Promise<unknown>,
  options: { minGapMs: number; now?: () => number; onError?: (error: unknown) => void },
): CoalescedRefresh => {
  const now = options.now ?? Date.now;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const run = () => {
    timer = null;
    if (cancelled) return;
    lastRunAt = now();
    void refresh().catch((error: unknown) => options.onError?.(error));
  };

  return {
    request() {
      if (cancelled || timer) return;
      const wait = lastRunAt + options.minGapMs - now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer ?? undefined);
      timer = null;
    },
  };
};
