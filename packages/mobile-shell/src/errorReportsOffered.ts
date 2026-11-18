/**
 * Whether this build offers error reports at all (REL-LOG-06). Only a build with a reporting address (DSN) baked in
 * asks "Send error reports?" in its setup and shows the Settings switch; a build without one (built without the
 * generated config, or with an empty DSN, issue #2570) never asks for something it cannot do, and its setup is
 * numbered without that step.
 *
 * Set from the build's DSN by `startErrorReporting` (`./errorReporting`), which each app calls from `index.js` before
 * React mounts. Kept apart from the reporter so the pure setup steps and the settings screens read it without pulling
 * in the SDK.
 */
let offered = true;

/** True when this build can send error reports, so the question and the switch are shown. */
export const errorReportsOffered = (): boolean => offered;

/** Records whether this build has a reporting address: an empty DSN means the build cannot report. */
export const setErrorReportsOffered = (dsn: string): void => {
  offered = dsn.trim() !== "";
};
