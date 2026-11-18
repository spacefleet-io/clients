import { init, IPCMode, makeElectronTransport } from "@sentry/electron/main";
import { scrubErrorEvent } from "./scrub";
import { createErrorReporting, type ErrorReporting } from "./controller";
import { createReporterOptions, keepIntegrations, resolveDsn, type ReporterConfig } from "./options";

/**
 * Default integrations of the Electron main-process SDK that we keep. Everything
 * else is dropped on purpose: `SentryMinidump` and `ElectronMinidump` upload
 * native memory dumps that can hold file names and titles; `ElectronBreadcrumbs`,
 * `ElectronNet`, `Console` and `NativeNodeFetch` record URLs and log lines;
 * `ContextLines` and `LocalVariables` attach source and variable values;
 * `Screenshots`, `AdditionalContext` and `GpuContext` describe the user's screen
 * and hardware; `MainProcessSession` sends session data tied to a device; `PreloadInjection`
 * is replaced by importing `./electron-preload` in the app's own preload.
 */
export const ELECTRON_MAIN_INTEGRATIONS: ReadonlySet<string> = new Set([
  "OnUncaughtException",
  "OnUnhandledRejection",
  "ChildProcess",
  "ElectronContext",
  "EventFilters",
  "FunctionToString",
  "LinkedErrors",
  "Context",
  "NormalizePaths",
]);

/**
 * Keeps only plain error events from an envelope. Renderer envelopes can also
 * carry replays, profiles, spans and attachments, which never pass `beforeSend`;
 * the allowlist scrubber only covers events, so nothing else may leave.
 */
type Transport = ReturnType<typeof makeElectronTransport>;
type Envelope = Parameters<Transport["send"]>[0];
type SendResponse = Awaited<ReturnType<Transport["send"]>>;

export function onlyErrorEvents(envelope: Envelope): Envelope | undefined {
  const [headers, items] = envelope;
  const kept = items.filter((item) => item[0].type === "event");
  return kept.length > 0 ? ([headers, kept] as unknown as Envelope) : undefined;
}

/**
 * Reporting for the Electron main process, off until `setEnabled(true)`.
 * `config.dsn` comes from the build; a build without one never starts the SDK.
 * The renderer SDK (`./electron-renderer`) forwards its events through the
 * main-process SDK, so these options also scrub renderer reports.
 *
 * The SDK is initialised once per process: a second `init` would register the
 * IPC handlers a second time. Turning reporting off therefore keeps the client
 * but gates both `beforeSend` and the transport, so nothing is sent and nothing
 * is queued on disk (the plain transport is used, not the offline one).
 */
export function createElectronMainReporting(config: ReporterConfig): ErrorReporting {
  let active = false;
  let initialised = false;
  return createErrorReporting({
    start() {
      const dsn = resolveDsn(config.dsn);
      if (!dsn) {
        console.info("[error-report] no valid DSN in this build, reporting stays off");
        return;
      }
      active = true;
      if (initialised) {
        console.info("[error-report] reporting resumed");
        return;
      }
      const options = createReporterOptions({ ...config, dsn });
      init({
        ...options,
        beforeSend: (event) => (active ? scrubErrorEvent(event) : null),
        transport: (transportOptions): Transport => {
          const inner = makeElectronTransport(transportOptions);
          return {
            send: async (envelope): Promise<SendResponse> => {
              const events = active ? onlyErrorEvents(envelope) : undefined;
              return events ? inner.send(events) : {};
            },
            flush: (timeout) => inner.flush(timeout),
          };
        },
        // Classic IPC needs no protocol registered before `app.ready`, so the
        // user can opt in while the app runs.
        ipcMode: IPCMode.Classic,
        integrations: keepIntegrations(ELECTRON_MAIN_INTEGRATIONS),
      });
      initialised = true;
      console.info("[error-report] reporting started");
    },
    stop() {
      active = false;
      console.info("[error-report] reporting stopped");
    },
  });
}
