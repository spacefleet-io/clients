import { monitorEventLoopDelay } from "node:perf_hooks";
import { scopeLogger } from "./logger";

// Test seam for the ultimate stress suite (apps/badger/desktop/e2e-ultimate).
// When SF_E2E_PERF=1, samples the main-process event-loop delay once per
// second and exposes the buffer on `globalThis.__sfMainPerf` so the Playwright
// driver can drain it via `electronApp.evaluate(...)`. No-op otherwise.

export type MainPerfSample = { ts: number; maxMs: number; meanMs: number };

declare global {
  var __sfMainPerf: { drain(): MainPerfSample[] } | undefined;
}

const SAMPLE_INTERVAL_MS = 1000;
const MAX_SAMPLES = 10_000;

let installed = false;

export const installE2ePerfProbe = (): void => {
  if (process.env.SF_E2E_PERF !== "1" || installed) return;
  installed = true;
  const logger = scopeLogger("e2e-perf-probe");
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const samples: MainPerfSample[] = [];
  const timer = setInterval(() => {
    samples.push({ ts: Date.now(), maxMs: histogram.max / 1e6, meanMs: histogram.mean / 1e6 });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    histogram.reset();
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  globalThis.__sfMainPerf = {
    drain: () => samples.splice(0, samples.length),
  };
  logger.info({ intervalMs: SAMPLE_INTERVAL_MS, maxSamples: MAX_SAMPLES }, "main event-loop delay probe installed");
};
