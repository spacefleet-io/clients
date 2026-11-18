/** The phone remote's status line ("Play on TV", UX-TV-02): which `playOnTv.remote.*` text a view shows. */
import type { RemoteView } from "./phoneRemote";

export type RemoteStatusKey =
  | "connecting"
  | "waiting"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "failed"
  | "notFound"
  | "unreachable";

export const remoteStatusKey = (view: RemoteView): RemoteStatusKey => {
  if (view.status === "unreachable") return "unreachable";
  if (view.status === "ended") return "ended";
  const tv = view.tv;
  if (!tv) return view.status === "waiting" ? "waiting" : "connecting";
  if (tv.phase === "failed") return tv.error === "media_not_found" ? "notFound" : "failed";
  if (tv.phase === "playing" || tv.phase === "paused" || tv.phase === "loading" || tv.phase === "ended") return tv.phase;
  // `idle`: the TV answered but plays nothing (a hello after it closed its player).
  return "ended";
};
