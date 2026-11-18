/**
 * Pure handler for Electron's `app.on("second-instance", …)` event (wired in index.ts behind
 * `app.requestSingleInstanceLock()`).
 *
 * Policy: when a second instance is launched, the existing instance is
 * brought to the foreground. The existing process is NEVER quit
 * as a consequence of a second-instance event — not even when there is
 * active processing — because it would abort in-flight jobs without user
 * consent.
 *
 * PLAT-WEB-05: a second launch carrying a `badger://` link (the web player starting the desktop player) does NOT
 * bring the window forward: the user stays in the browser.
 */
import { findBadgerLink } from "./protocolLink";

export type SecondInstanceDeps = {
  showMainWindow: () => void;
  requestQuit: () => void;
  getWindowProcessingState: () => "active" | "idle";
  /** The second launch's command line (Electron's `second-instance` argv). */
  argv?: readonly unknown[];
  /** Called instead of showing the window when the launch carried a `badger://` link. */
  onLink?: (link: string) => void;
};

export const handleSecondInstance = (deps: SecondInstanceDeps): void => {
  const link = findBadgerLink(deps.argv ?? []);
  if (link !== null) {
    deps.onLink?.(link);
    return;
  }
  // Always focus the existing window regardless of processing state.
  deps.showMainWindow();
  // requestQuit is intentionally NOT called here. Terminating the host
  // process when a second instance arrives would silently abort active
  // transcoding/upload jobs without user confirmation.
};
