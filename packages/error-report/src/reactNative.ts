import { setCaughtErrorSink } from "./caught";
import { scrubErrorEvent } from "./scrub";
import { createErrorReporting, type ErrorReporting } from "./controller";
import { createReporterOptions, keepIntegrations, resolveDsn, type ReporterConfig } from "./options";

/**
 * React Native default integrations that we keep. Native-backed ones (native
 * linked errors, device context, release, native frames) and everything that
 * records breadcrumbs, HTTP context, screenshots or view trees are dropped.
 */
export const REACT_NATIVE_INTEGRATIONS: ReadonlySet<string> = new Set([
  "ReactNativeErrorHandlers",
  "EventFilters",
  "FunctionToString",
  "Dedupe",
  "RewriteFrames",
  "DebugMeta",
  "EventOrigin",
  "SdkInfo",
]);

/**
 * Reporting for the React Native apps (phone and TV share this code), off until
 * `setEnabled(true)`. The SDK runs with its native half disabled: native crash
 * reports, native sessions and native breadcrumbs go out through the native
 * SDK's own transport and would bypass the scrubber, so only JavaScript errors
 * are reported, all of them through `beforeSend`.
 */
export function createReactNativeReporting(config: ReporterConfig): ErrorReporting {
  let close: (() => Promise<unknown>) | undefined;
  // `Sentry.close()` first waits for unsent reports to go out and only then
  // turns the client off, so errors caught during that wait would still be
  // sent after the user said "off". `stop()` flips this flag synchronously
  // before `close()`, and `beforeSend` drops everything while it is false.
  let active = false;
  return createErrorReporting({
    async start() {
      const dsn = resolveDsn(config.dsn);
      if (!dsn) {
        console.info("[error-report] no valid DSN in this build, reporting stays off");
        return;
      }
      const Sentry = await import("@sentry/react-native");
      Sentry.init({
        ...createReporterOptions({ ...config, dsn }),
        enableNative: false,
        enableNativeCrashHandling: false,
        enableAutoSessionTracking: false,
        enableNativeNagger: false,
        beforeSend: (event) => (active ? scrubErrorEvent(event) : null),
        integrations: keepIntegrations(REACT_NATIVE_INTEGRATIONS),
      });
      active = true;
      close = () => Sentry.close();
      setCaughtErrorSink((error, guard) => {
        if (active) Sentry.captureException(error, { tags: { guard } });
      });
      console.info("[error-report] reporting started");
    },
    async stop() {
      active = false;
      setCaughtErrorSink(undefined);
      const closing = close;
      close = undefined;
      await closing?.();
      console.info("[error-report] reporting stopped");
    },
  });
}
