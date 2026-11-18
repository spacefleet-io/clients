/**
 * REL-LOG-06: renderer side of the opt-in error reports, for every desktop app (Badger, Parrot). Main owns the answer
 * (`<userData>/error-reports.json`) and the network call; a window only starts its own error catcher while the answer
 * is "on" and hands events to main through the preload bridge.
 *
 * Nothing is loaded for a user who has not opted in: the app passes a `createReporting` that imports the SDK adapter
 * dynamically, so the entry chunk does not carry it. Changes made in Settings or the setup flow come through `set`, so
 * reporting starts and stops without a restart.
 */
import type { ErrorReporting } from "./controller";
import type { ErrorReportsBridge, ErrorReportsState } from "./desktop";

export type RendererErrorReportsDeps = {
  /** The preload bridge; undefined in a browser or a test without one. */
  bridge: () => ErrorReportsBridge | undefined;
  /** Builds this window's reporter. Called only once reporting is on. */
  createReporting: (release: string) => Promise<ErrorReporting>;
  /** The window's log (pino-style: fields, then message). */
  log: { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void };
};

export type RendererErrorReports = {
  /** Reads main's answer and applies it; call once when the window starts. */
  boot(): Promise<ErrorReportsState | undefined>;
  /** Whether this window has the preload bridge (false in a browser build or a test without one). */
  hasBridge(): boolean;
  /** Main's current answer, undefined without a bridge. */
  get(): Promise<ErrorReportsState | undefined>;
  /** Stores the answer in main, then starts or stops this window's reporting at once. */
  set(decision: "on" | "off"): Promise<ErrorReportsState | undefined>;
};

export const createRendererErrorReports = (deps: RendererErrorReportsDeps): RendererErrorReports => {
  let reporting: ErrorReporting | undefined;
  // The first "on" awaits a dynamic import. Without a queue, an "off" arriving
  // meanwhile would find no reporter yet, do nothing, and the import would then
  // start reporting in a window whose stored answer is off. Answers are applied
  // one at a time, in the order main returned them; `applyNow` never rejects.
  let queue: Promise<void> = Promise.resolve();

  const apply = (state: ErrorReportsState): Promise<void> => {
    queue = queue.then(() => applyNow(state));
    return queue;
  };

  const applyNow = async (state: ErrorReportsState) => {
    const enabled = state.decision === "on" && state.available;
    try {
      if (enabled) {
        reporting ??= await deps.createReporting(state.release);
        await reporting.setEnabled(true);
      } else {
        await reporting?.setEnabled(false);
      }
      deps.log.info({ decision: state.decision, available: state.available, reporting: enabled }, "[error-report] renderer reporting applied");
    } catch (err) {
      // Reporting is best effort: a window that cannot start it keeps working.
      deps.log.error({ err: String(err) }, "[error-report] could not apply the answer in this window");
    }
  };

  return {
    async boot() {
      const state = await deps.bridge()?.get();
      if (state) await apply(state);
      return state;
    },
    async get() {
      return deps.bridge()?.get();
    },
    hasBridge() {
      return deps.bridge() !== undefined;
    },
    async set(decision) {
      const state = await deps.bridge()?.set(decision);
      if (state) await apply(state);
      return state;
    },
  };
};
