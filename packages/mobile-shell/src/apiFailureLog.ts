/**
 * REL-LOG-31: the phone apps (Badger, Parrot) write one local warn line per failed API call, with the answer's status,
 * code and the server's request id (REL-LOG-28), so a failure seen on a device is found on the server by one search.
 * The line goes to the device log (logcat / the unified log); the in-memory error log feedback can carry redacts its
 * fields (REL-LOG-06), so the request id never leaves the device, and no error report ever gets it.
 */
import { logFailedApiCalls } from "@space/shared/apiFailure";
import { scopeLogger } from "./logger";

/** Called once at start-up, next to `setClientIdentity`. Returns the unsubscribe function. */
export const logApiFailuresOnDevice = (): (() => void) =>
  logFailedApiCalls((fields) => {
    scopeLogger("api").warn("call.failed", fields);
  });
