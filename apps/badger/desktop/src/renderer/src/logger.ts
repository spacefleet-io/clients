import { createBrowserLogger, type BrowserLogger } from "@space/logger/browser";

/**
 * Shared renderer-side logger for badger-desktop. Wraps `console.*` with
 * level gating so debug traces are available in dev (`VITE_SF_LOG_LEVEL=debug`
 * or `__sfLog.setLevel("trace")` from DevTools) and silenced in production.
 *
 * Import and scope via `.child({ scope: "..." })` at the top of each module:
 *
 *   import { rendererLogger } from "@/logger";
 *   const log = rendererLogger.child({ scope: "play-trace" });
 *   log.debug({ id }, "handlePlayMedia:click");
 *
 * Do NOT call `console.*` directly — an ESLint rule will flag it.
 */
export const rendererLogger: BrowserLogger = createBrowserLogger({
  service: "badger-desktop-renderer",
});
