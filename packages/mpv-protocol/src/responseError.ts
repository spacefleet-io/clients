/**
 * Helpers for interpreting mpv JSON-IPC response shapes.
 *
 * Relocated from @space/desktop-mpv-playback (externalMpvController.ts) in
 * Phase 1b so main-process code and the renderer hook can share the same
 * "success vs failure" semantics.
 */

export const isExternalMpvResponseReady = (result: unknown): boolean => {
  if (!result || typeof result !== "object") return false;
  return "data" in result || "error" in result;
};

/**
 * True only when mpv's IPC response reports a real failure.
 *
 * mpv's JSON IPC always includes an `error` field in its responses — the
 * string `"success"` means the command completed. A naive `"error" in result`
 * check therefore treats EVERY successful mpv response as a failure, which
 * silently drops script-message metadata commands and any other fire-and-
 * forget commands that don't return a `data` payload.
 *
 * This helper returns true only when:
 *   - the response has an `error` field set to something other than
 *     "success" (including the IPC-layer sentinel "mpv_socket_missing"),
 *   - OR the response carries an explicit error-like shape.
 *
 * Use in command senders to detect "command actually failed" vs "command
 * acknowledged by mpv".
 */
export const isExternalMpvResponseError = (result: unknown): boolean => {
  if (!result || typeof result !== "object") return false;
  if (!("error" in result)) return false;
  const error = (result as { error?: unknown }).error;
  if (typeof error !== "string") return Boolean(error);
  return error !== "success";
};
