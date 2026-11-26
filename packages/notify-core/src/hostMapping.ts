/**
 * How the Kodi add-on and the Jellyfin plugin show each kind of notice with their host's own pop-ups (UX-NOTICE-14):
 * they have no bell and no history, only the closest pop-up the host program offers. The add-on (Python) and the
 * plugin page get this table and the shared texts as generated files; the key-drift test keeps them equal.
 */
import { durationFor, type Notice, type NoticeLevel } from "./kinds";

/** Kodi: `xbmcgui.Dialog().notification` with its icon and time, `Dialog().ok`, or `Dialog().yesno`. */
export type KodiPopup = { type: "notification"; icon: "info" | "warning" | "error"; ms: number } | { type: "ok" } | { type: "yesno" };

/** Jellyfin's web client: its `toast`, its `alert` dialog, or its `confirm` dialog. */
export type JellyfinPopup = { type: "toast"; level: NoticeLevel } | { type: "alert" } | { type: "confirm" };

type Shape = Pick<Notice, "kind" | "level" | "outcome" | "action" | "oneTime">;

const kodiIcon = (level: NoticeLevel): "info" | "warning" | "error" => (level === "error" ? "error" : level === "warning" ? "warning" : "info");

/**
 * A passing notice becomes Kodi's short notification (info icon for info and success, warning, error) for the kind's
 * time; a one-time message an OK dialog; a decision a yes/no dialog.
 */
export const kodiPopupFor = (notice: Shape): KodiPopup => {
  if (notice.kind === "decision") return { type: "yesno" };
  const ms = durationFor(notice);
  if (ms === null) return { type: "ok" };
  return { type: "notification", icon: kodiIcon(notice.level), ms };
};

/** The same match on Jellyfin: toast for passing notices, alert for a one-time message, confirm for a decision. */
export const jellyfinPopupFor = (notice: Shape): JellyfinPopup => {
  if (notice.kind === "decision") return { type: "confirm" };
  if (durationFor(notice) === null) return { type: "alert" };
  return { type: "toast", level: notice.level };
};
