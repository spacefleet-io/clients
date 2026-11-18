// Test seam for the ultimate stress suite (apps/badger/desktop/e2e-ultimate).
// When enabled (preload `window.sf.e2ePerfEnabled`, i.e. SF_E2E_PERF=1),
// records long animation frames and slow input events and exposes them on
// `window.__sfRendererPerf` for the Playwright driver to drain. No-op otherwise.
//
// Every drained record carries `hidden`: true when its [start, start +
// duration] overlaps a period where the app window was hidden. The main window
// hides while external mpv plays and Chromium does not paint a hidden page, so
// an event or frame spanning that period measures the hide, not
// responsiveness (overnight run: pointer events with 0 ms processing and
// 512 ms duration, long frames with 0 ms blocking and no scripts).
//
// Hidden spans come from main's hide/show IPC (appWindowVisibility), stamped
// with main's epoch time. `document.visibilityState` alone is not enough: with
// `backgroundThrottling: false`, `win.hide()` never flips it (issue #25 M7: 0
// flips over 189 playback hides). A document-hidden period (minimise) still
// counts too.

import { rendererLogger } from "@/logger";
import { subscribeAppWindowVisibility } from "./appWindowVisibility";

const log = rendererLogger.child({ scope: "e2e-perf-probe" });

/** One LoAF script attribution; `invoker`/`type`/`pos` attribute anonymous callbacks (`fn` empty), `pos` -1 when unknown. */
export type RendererLoafScript = { src: string; fn: string; invoker: string; type: string; pos: number; ms: number };

export type RendererLoafRecord =
  | {
      ts: number;
      durationMs: number;
      blockingMs: number;
      /**
       * Script attribution (scripts >= 5 ms). Chromium drops entries whose
       * sourceURL is not http(s)/data/blob unless the AlwaysLogLOAFURL feature
       * is on, so the packaged file:// renderer reports none without it (the
       * ultimate suite launches with it; e2e-ultimate/lib/rendererPerf.ts).
       */
      scripts: RendererLoafScript[];
      /** startTime -> renderStart: scripts/tasks that ran before the render phase. */
      workMs: number;
      /** renderStart -> styleAndLayoutStart: rAF/ResizeObserver callbacks and render-phase wait. */
      renderMs: number;
      /** styleAndLayoutStart -> end of frame: style recalc + layout + paint on the main thread. */
      styleLayoutMs: number;
      hidden: boolean;
    }
  | { kind: "unsupported"; type: string };

export type RendererEventRecord =
  | {
      ts: number;
      name: string;
      durationMs: number;
      processingMs: number;
      /** startTime -> processingStart: main thread busy/blocked when the input arrived. */
      inputDelayMs: number;
      /** processingEnd -> next paint presented: style/layout/paint + compositor/present. */
      presentationMs: number;
      target: string | null;
      /** Event Timing interactionId: shared by the entries of one interaction; 0 for hover/move events. */
      interactionId: number;
      hidden: boolean;
    }
  | { kind: "unsupported"; type: string };

export type RendererPerfDrain = { loaf: RendererLoafRecord[]; events: RendererEventRecord[] };

declare global {
  interface Window {
    __sfRendererPerf?: { drain(): RendererPerfDrain };
  }
}

const MAX_RECORDS = 20_000;
const MAX_HIDDEN_SPANS = 2_000;

type LoafScript = { sourceURL?: string; sourceFunctionName?: string; invoker?: string; invokerType?: string; sourceCharPosition?: number; duration: number };
export type LoafEntry = PerformanceEntry & {
  blockingDuration?: number;
  scripts?: LoafScript[];
  renderStart?: number;
  styleAndLayoutStart?: number;
};
export type EventEntry = PerformanceEntry & { processingStart: number; processingEnd: number; target?: Node | null; interactionId?: number };

/** The first (up to 3) script attributions of a long frame. */
export const loafScripts = (entry: LoafEntry): RendererLoafScript[] =>
  (entry.scripts ?? []).slice(0, 3).map((s) => ({
    src: s.sourceURL ?? "",
    fn: s.sourceFunctionName ?? "",
    invoker: s.invoker ?? "",
    type: s.invokerType ?? "",
    pos: s.sourceCharPosition ?? -1,
    ms: s.duration,
  }));

/** Epoch-ms hidden period; `to` null while still hidden. */
type HiddenSpan = { from: number; to: number | null };

/** Open a span on hide, close the open one on show. Repeated hides/shows are no-ops. */
export const recordHiddenTransition = (spans: HiddenSpan[], hidden: boolean, atMs: number): void => {
  const open = spans.at(-1);
  if (hidden) {
    if (!open || open.to !== null) pushCapped(spans, { from: atMs, to: null }, MAX_HIDDEN_SPANS);
  } else if (open && open.to === null) {
    open.to = atMs;
  }
};

/** [start, end] overlaps a span in `spans` (an open span counts until now); spans are in time order. */
export const overlapsHiddenSpan = (spans: HiddenSpan[], start: number, end: number): boolean => {
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span.from <= end && (span.to ?? Number.POSITIVE_INFINITY) >= start) return true;
    if ((span.to ?? Number.POSITIVE_INFINITY) < start) return false;
  }
  return false;
};

const pushCapped = <T>(buffer: T[], record: T, max: number) => {
  buffer.push(record);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
};

/**
 * Split a long-animation-frame entry into its phases. renderStart /
 * styleAndLayoutStart are 0 when the frame had no rendering update.
 */
export const loafPhases = (entry: LoafEntry): { workMs: number; renderMs: number; styleLayoutMs: number } => {
  const end = entry.startTime + entry.duration;
  const renderStart = entry.renderStart && entry.renderStart > 0 ? entry.renderStart : null;
  const styleStart = entry.styleAndLayoutStart && entry.styleAndLayoutStart > 0 ? entry.styleAndLayoutStart : null;
  if (renderStart === null) return { workMs: entry.duration, renderMs: 0, styleLayoutMs: 0 };
  const styleAt = styleStart ?? end;
  return { workMs: renderStart - entry.startTime, renderMs: styleAt - renderStart, styleLayoutMs: end - styleAt };
};

/** Split an event-timing entry into input delay / processing / presentation. */
export const eventPhases = (entry: EventEntry): { inputDelayMs: number; processingMs: number; presentationMs: number } => ({
  inputDelayMs: entry.processingStart - entry.startTime,
  processingMs: entry.processingEnd - entry.processingStart,
  presentationMs: entry.startTime + entry.duration - entry.processingEnd,
});

const describeTarget = (target: Node | null | undefined): string | null => {
  if (!(target instanceof Element)) return null;
  return target.getAttribute("data-testid") ?? target.tagName;
};

let installed = false;

export const installRendererPerfProbe = (enabled: boolean): void => {
  if (!enabled || installed) return;
  installed = true;
  const loaf: Exclude<RendererLoafRecord, { kind: "unsupported" }>[] = [];
  const events: Exclude<RendererEventRecord, { kind: "unsupported" }>[] = [];
  const unsupportedLoaf: RendererLoafRecord[] = [];
  const unsupportedEvents: RendererEventRecord[] = [];
  const documentHiddenSpans: HiddenSpan[] = [];
  const windowHiddenSpans: HiddenSpan[] = [];
  const now = () => performance.timeOrigin + performance.now();

  if (document.visibilityState === "hidden") documentHiddenSpans.push({ from: performance.timeOrigin, to: null });
  document.addEventListener("visibilitychange", () => {
    recordHiddenTransition(documentHiddenSpans, document.visibilityState === "hidden", now());
    log.info({ visibility: document.visibilityState }, `[e2e-perf-probe] visibility=${document.visibilityState}`);
  });
  subscribeAppWindowVisibility((change) => {
    recordHiddenTransition(windowHiddenSpans, change.hidden, change.atMs);
    log.info(
      { hidden: change.hidden, atMs: change.atMs, reason: change.reason, spans: windowHiddenSpans.length },
      `[e2e-perf-probe] app window hidden=${change.hidden} (main span mark)`,
    );
  });

  const overlapsHidden = (start: number, end: number): boolean =>
    overlapsHiddenSpan(windowHiddenSpans, start, end) || overlapsHiddenSpan(documentHiddenSpans, start, end);

  // Logged once: a blocking frame without any script attribution means either
  // non-script work or the AlwaysLogLOAFURL feature is missing (file:// URLs filtered).
  let unattributedLogged = false;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LoafEntry[]) {
        const scripts = loafScripts(entry);
        if (!unattributedLogged && (entry.blockingDuration ?? 0) > 0 && scripts.length === 0) {
          unattributedLogged = true;
          log.info(
            { durationMs: entry.duration, blockingMs: entry.blockingDuration, rawScripts: entry.scripts?.length ?? null },
            "[e2e-perf-probe] first blocking long frame without script attribution",
          );
        }
        pushCapped(
          loaf,
          {
            ts: performance.timeOrigin + entry.startTime,
            durationMs: entry.duration,
            blockingMs: entry.blockingDuration ?? 0,
            scripts,
            ...loafPhases(entry),
            hidden: false,
          },
          MAX_RECORDS,
        );
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch (err) {
    log.warn({ err: String(err) }, "[e2e-perf-probe] long-animation-frame unsupported");
    unsupportedLoaf.push({ kind: "unsupported", type: "long-animation-frame" });
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as EventEntry[]) {
        pushCapped(
          events,
          {
            ts: performance.timeOrigin + entry.startTime,
            name: entry.name,
            durationMs: entry.duration,
            ...eventPhases(entry),
            target: describeTarget(entry.target),
            interactionId: entry.interactionId ?? 0,
            hidden: false,
          },
          MAX_RECORDS,
        );
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch (err) {
    log.warn({ err: String(err) }, "[e2e-perf-probe] event timing unsupported");
    unsupportedEvents.push({ kind: "unsupported", type: "event" });
  }

  window.__sfRendererPerf = {
    // Hidden overlap is decided at drain time: an entry is usually observed
    // only after the page paints again, i.e. after its hidden span closed.
    drain: () => {
      const drainedLoaf = loaf.splice(0, loaf.length).map((r) => ({ ...r, hidden: overlapsHidden(r.ts, r.ts + r.durationMs) }));
      const drainedEvents = events.splice(0, events.length).map((r) => ({ ...r, hidden: overlapsHidden(r.ts, r.ts + r.durationMs) }));
      return {
        loaf: [...unsupportedLoaf.splice(0, unsupportedLoaf.length), ...drainedLoaf],
        events: [...unsupportedEvents.splice(0, unsupportedEvents.length), ...drainedEvents],
      };
    },
  };
  log.info({ maxRecords: MAX_RECORDS, visibility: document.visibilityState }, "[e2e-perf-probe] renderer perf probe installed");
};
