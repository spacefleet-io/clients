import { setCaughtErrorSink } from "./caught";
import { createErrorReporting, type ErrorReporting } from "./controller";
import { createReporterOptions, keepIntegrations, type ReportApp } from "./options";
import { scrubErrorEvent } from "./scrub";

/**
 * Browser-SDK default integrations that we keep in the renderer. Breadcrumb,
 * dedupe and context-line style integrations are left out: breadcrumbs record
 * clicks, URLs and console output, and HTTP context records page URLs.
 */
export const ELECTRON_RENDERER_INTEGRATIONS: ReadonlySet<string> = new Set([
  "EventFilters",
  "FunctionToString",
  "BrowserApiErrors",
  "GlobalHandlers",
  "LinkedErrors",
  "ScopeToMain",
]);

/**
 * Reporting for a renderer window, off until `setEnabled(true)`. The SDK is
 * loaded only then, so a window whose user never opted in does not even fetch
 * its code. Events travel through the preload bridge to the main process, which
 * owns the network call.
 */
export function createElectronRendererReporting(config: { release: string; app: ReportApp }): ErrorReporting {
  let stop: (() => Promise<void>) | undefined;
  return createErrorReporting({
    async start() {
      const sdk = await import("@sentry/electron/renderer");
      sdk.init({
        ...createReporterOptions({ dsn: "", release: config.release, app: config.app, platform: "desktop" }),
        dsn: undefined,
        beforeSend: scrubErrorEvent,
        integrations: keepIntegrations(ELECTRON_RENDERER_INTEGRATIONS),
      });
      setCaughtErrorSink((error, guard) => sdk.captureException(error, { tags: { guard } }));
      stop = async () => {
        setCaughtErrorSink(undefined);
        await sdk.getClient()?.close(2000);
        // `init` refuses to run twice per window; let a later opt-in start it again.
        (window as unknown as { __SENTRY__RENDERER_INIT__?: boolean }).__SENTRY__RENDERER_INIT__ = false;
      };
    },
    async stop() {
      await stop?.();
      stop = undefined;
    },
  });
}
