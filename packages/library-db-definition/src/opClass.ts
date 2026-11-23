/**
 * Progress-class ops are high-frequency playback state (a player saves its
 * position every ~0.5 s). The next save of the same key supersedes the
 * previous one, so they are cheap to coalesce and carry no library structure:
 * they must NOT count toward the snapshot threshold (LIB-SYNC-07) and a queue
 * holding only these may wait before uploading.
 *
 * Progress-class means `media.progress`, and `setting.set` for a playback
 * position key of any profile (`[p:<pid>:]episode_resume_v1:<episodeId>`,
 * `[p:<pid>:]media_progress_v1:<mediaId>`; see `isPlaybackProgressSettingKey`).
 */
import { isPlaybackProgressSettingKey } from "@space/shared/profileViewing";

export const isProgressClassOp = (op: { type: string; payload?: unknown }): boolean => {
  if (op.type === "media.progress") return true;
  if (op.type !== "setting.set") return false;
  const payload = op.payload;
  if (typeof payload !== "object" || payload === null || !("key" in payload)) return false;
  const key = payload.key;
  return typeof key === "string" && isPlaybackProgressSettingKey(key);
};
