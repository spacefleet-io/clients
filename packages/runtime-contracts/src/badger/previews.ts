import { z } from "zod";
import { defineCommand } from "../helpers";

/**
 * `badger.previews.get_status` (MPV-PREV-06, Chris 2026-11-02)
 *
 * Asked by the desktop main process when the playing video has no seek-bar preview record yet: whether its previews
 * are still to come (`pending`: the catch-up pass, MPV-PREV-03, has not given up on that source format) or will not
 * come (`failed`: it used all `maxAttempts` tries). The seek bar shows "Previews are being prepared" only for
 * `pending`. Read-only; `failures` / `maxAttempts` are for the logs (`maxAttempts` 0 when the pass is not running).
 */
export const badgerPreviewsGetStatus = defineCommand({
  name: "badger.previews.get_status" as const,
  module: "badger",
  payloadSchema: z.object({
    formatId: z.string().min(1),
  }),
  resultSchema: z.object({
    formatId: z.string(),
    state: z.enum(["pending", "failed"]),
    failures: z.number().int().min(0),
    maxAttempts: z.number().int().min(0),
  }),
});

/**
 * `badger.previews.get_catch_up` (MPV-PREV-07, Chris 2026-11-23/24 via Main): the catch-up pass (MPV-PREV-03) as the
 * Jobs tab shows it, "Skip detection: N of M videos". `total`: the library's videos; `handled`: those with a skip
 * signature plus those the pass gave up on (`failed`), read from what is stored, so a restart shows the true count.
 * `state`: `running` while videos remain and nothing holds it back, `paused_playback` / `paused_import` while a
 * playback or an import runs, `offline` after the backend could not be reached, `done` when none remain.
 * `current`: the video being made, else the next one (null when none remain); while it runs, `phase` says its step
 * (downloading its stored copy, reading its pictures, reading its sound; null while it waits its turn),
 * `downloaded` (0..1) and `downloadedBytes` / `totalBytes` how much of the stored copy has arrived, and `progress`
 * (0..1) how far that one video is, so the card's bar moves within a video. `videos` (Chris 2026-11-24, the
 * expanded card's detailed list): every counted video, the running one first, then those the pass gave up on (with
 * `failedStep`: `download` the stored copy could not be fetched, `read` it could not be read), then the queue in the
 * pass's order, then the done ones with `result` (intro and/or credits found, waiting for another episode of the
 * show, nothing found), then the ones the user cancelled (`cancelled`, last). A video whose last try failed (or found
 * no disk room, `failedStep` `room`) with tries left waits an hour before the pass takes it again: it is listed after
 * the queue as `retry_waiting` with its `retryAt`, never as next; when only such videos remain, `state` is
 * `retry_wait` and `retryAt` the earliest of them (null in every other state). A failed, cancelled or done video the user
 * removed from the Jobs history (`dismiss`) is not in `videos`. `cancelled`: every video the user cancelled, removed
 * from the history or not; with `failed` it is what the title's details list as left out, with their "Try again"
 * (PLAY-SKIP-09). `finishedAt`: when this runtime saw the list run dry (null before that).
 */
const catchUpVideo = z.object({
  formatId: z.string(),
  mediaId: z.string(),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),
});

export const badgerPreviewsGetCatchUp = defineCommand({
  name: "badger.previews.get_catch_up" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    state: z.enum(["running", "paused_playback", "paused_import", "offline", "retry_wait", "done"]),
    retryAt: z.string().nullable(),
    handled: z.number().int().min(0),
    total: z.number().int().min(0),
    current: catchUpVideo
      .extend({
        running: z.boolean(),
        phase: z.enum(["download", "pictures", "sound"]).nullable(),
        downloaded: z.number().min(0).max(1),
        downloadedBytes: z.number().int().min(0),
        totalBytes: z.number().int().min(0),
        progress: z.number().min(0).max(1),
      })
      .nullable(),
    failed: z.array(catchUpVideo),
    cancelled: z.array(catchUpVideo),
    videos: z.array(
      catchUpVideo.extend({
        status: z.enum(["running", "failed", "cancelled", "queued", "retry_waiting", "done"]),
        result: z.enum(["found_both", "found_intro", "found_credits", "waiting_other_episode", "nothing_found", "previews_made"]).nullable(),
        failedStep: z.enum(["download", "read", "room"]).nullable(),
        /** When a `retry_waiting` video may run again (null for every other status). */
        retryAt: z.string().nullable(),
      })
    ),
    finishedAt: z.string().nullable(),
  }),
});

export type BadgerPreviewsCatchUp = z.infer<typeof badgerPreviewsGetCatchUp.resultSchema>;

/**
 * `badger.previews.retry_catch_up` (MPV-PREV-07, Chris 2026-11-24): the Jobs card's "Try again". Forgets the failed
 * tries of one video (`formatId`), or of every video when omitted, and asks the catch-up for a pass soon. `reset`:
 * how many videos had tries to forget.
 */
export const badgerPreviewsRetryCatchUp = defineCommand({
  name: "badger.previews.retry_catch_up" as const,
  module: "badger",
  payloadSchema: z.object({
    formatId: z.string().min(1).optional(),
  }),
  resultSchema: z.object({
    reset: z.number().int().min(0),
  }),
});

/**
 * `badger.previews.set_catch_up_video` (MPV-PREV-07, Chris 2026-11-24: skip detection is a job type of the Jobs
 * queue): `cancel` takes one video out of the catch-up (a running one stops at its next check, never counted as a
 * failed try) until "Try again" (`retry_catch_up`) brings it back; `dismiss` removes a finished video (done, failed or
 * cancelled) from the Jobs history ("Remove from history", "Clear finished"). A removed failed or cancelled video stays
 * left out; its "Try again" is on its title's details (PLAY-SKIP-09), and trying again brings it back to the history. `ok`: false when nobody is signed in.
 */
export const badgerPreviewsSetCatchUpVideo = defineCommand({
  name: "badger.previews.set_catch_up_video" as const,
  module: "badger",
  payloadSchema: z.object({
    formatId: z.string().min(1),
    action: z.enum(["cancel", "dismiss"]),
  }),
  resultSchema: z.object({
    ok: z.boolean(),
  }),
});
