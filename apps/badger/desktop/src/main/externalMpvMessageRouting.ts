import type { MpvExternalMessage } from "@space/mpv-protocol";

/**
 * Whether a message from one main-side mpv client reaches the renderer.
 *
 * - `currentClient`: the live client. A stop (`disposeCurrentClient`) nulls it
 *   BEFORE disposing, so concurrent callers see "no client".
 * - `lifecycleOwner`: the newest launched client. A stop does not clear it;
 *   only the next launch replaces it.
 *
 * The current client's messages all pass. A stopped client's lifecycle pushes
 * (user_stop → stopping, process_exited → idle) still pass while it is the
 * newest launch: without them the renderer's lifecycle mirror stays "playing"
 * on a dead mpv, and Start Over seeks it instead of relaunching (#25 run 7950).
 * Once a newer launch exists, a stale client's late transitions are dropped so
 * they cannot clobber the new session.
 */
export const shouldForwardMpvMessage = <C>(input: {
  client: C;
  currentClient: C | null;
  lifecycleOwner: C | null;
  message: MpvExternalMessage;
}): boolean => {
  if (input.currentClient === input.client) return true;
  return input.message.type === "lifecycle" && input.lifecycleOwner === input.client;
};

/**
 * Lua → renderer script-messages forwarded only in E2E runs. `sf-pill-state`
 * (sf.lua emit_pill_state) has no production consumer: only the E2E
 * skipPillObserver (e2e/_helpers/skipPillObserver.ts) subscribes to it, and
 * the ultimate harness reads it straight off the mpv socket. Forwarding it in
 * production cost an IPC hop into the (often hidden) renderer for nothing
 * (#25 NEW-pill-state-flood). Every other channel (e.g. `sf-track-picked`,
 * consumed by the renderer's oscTrackPicks) is forwarded unconditionally.
 */
const E2E_ONLY_SCRIPT_MESSAGES: Readonly<Record<string, true>> = { "sf-pill-state": true };

export const shouldForwardScriptMessage = (
  name: string,
  env: { SF_E2E?: string } = process.env,
): boolean => E2E_ONLY_SCRIPT_MESSAGES[name] !== true || env.SF_E2E === "1";
