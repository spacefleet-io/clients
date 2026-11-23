// Main event-loop delay measurement shared by the decrypt suites (issue #25) and their perf-lane budget
// (tests/*.perf.test.ts, issue #3350 C6).
//
// Real timers on purpose: monitorEventLoopDelay samples the real event loop against the platform clock, which fake
// timers cannot drive.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

/** The longest main-loop stall, in ms, while `work` runs (with 5 ms of quiet on each side). */
export const measureLoopDelayMs = async (work: () => unknown): Promise<number> => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  // Let the histogram's timer arm before the work starts.
  await sleep(5);
  await work();
  await sleep(5);
  histogram.disable();
  return histogram.max / 1e6;
};

/** The loop delay of an idle window of the same shape: how much the runner itself stalls right now. */
export const measureIdleLoopDelayMs = () => measureLoopDelayMs(() => sleep(1));

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

export const formatMs = (values: number[]) => `[${values.map((ms) => ms.toFixed(1)).join(", ")}] ms`;
