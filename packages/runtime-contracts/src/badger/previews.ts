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
