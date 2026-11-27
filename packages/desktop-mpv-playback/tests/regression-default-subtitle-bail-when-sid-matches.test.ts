/**
 * @bugfix @regression-proof
 *
 * Locks the "bail when sid already matches" invariant.
 *
 * History (commit 7d42d8ff): sf.lua now sub-add's the default subtitle with
 * mpv's "select" flag. That means sid is already set BEFORE the first decoded
 * frame. When the post-launch applyExternalSubtitle effect fires and the
 * matching track is found in track-list, it must read the current sid FIRST —
 * if it already matches `existing.id`, NO `set_property` command is issued.
 * Issuing set_property sid with the same value still triggers mpv's
 * refresh-seek, causing the user-visible 1–4s replay loop.
 *
 * Variants tested:
 *   A. currentSid === existing.id (3 === 3) → set_property NOT called.
 *   B. currentSid !== existing.id (5 !== 3) → set_property IS called with 3.
 *
 * Because the logic lives inside a React hook (useMpvPlaybackEngine.ts:1523–
 * 1547), we inline a minimal copy of the relevant block here.
 * Comment: "this mirrors useMpvPlaybackEngine.ts:1523–1547 and will be moved
 * to @space/mpv-protocol in Phase 1b".
 *
 * References: commit 7d42d8ff.
 */

import { describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { MpvTrack } from "./fixtures/track-list-corpus";

// On assertion failure, dump the outcome + recorded mpv mock call args so the
// bail-vs-apply decision is diagnosable offline. Body in try/catch so a dump
// failure can't mask the assertion failure.
const dumpBailSnapshot = (
  label: string,
  ctx: {
    existing?: MpvTrack & { id: number };
    outcome?: "bailed" | "applied";
    sendExternalRequest?: MockInstance;
    sendExternalCommand?: MockInstance;
  },
): void => {
  try {
    console.error(`=== [regression-default-subtitle-bail-when-sid-matches:${label}] snapshot ===`);
    if (ctx.existing) console.error(`existing track: ${JSON.stringify(ctx.existing)}`);
    if (ctx.outcome !== undefined) console.error(`outcome=${ctx.outcome}`);
    if (ctx.sendExternalRequest) {
      console.error(`sendExternalRequest calls:\n${JSON.stringify(ctx.sendExternalRequest.mock.calls, null, 2)}`);
    }
    if (ctx.sendExternalCommand) {
      console.error(`sendExternalCommand calls:\n${JSON.stringify(ctx.sendExternalCommand.mock.calls, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

// ----- Inline copy of the bail-when-sid-matches block (useMpvPlaybackEngine.ts:1530–1549) -----
// this mirrors useMpvPlaybackEngine.ts:1530–1549 and will be moved to
// @space/mpv-protocol in Phase 1b.
async function eagerApplyExistingTrack(
  existing: MpvTrack & { id: number },
  sendExternalRequest: (cmd: unknown) => Promise<unknown>,
  sendExternalCommand: (cmd: unknown) => Promise<boolean>,
): Promise<"bailed" | "applied"> {
  const currentSidRaw = await sendExternalRequest({ command: ["get_property", "sid"] });
  const currentSidRawTyped = currentSidRaw as { data?: unknown } | null;
  const currentSid =
    typeof currentSidRawTyped?.data === "number"
      ? currentSidRawTyped.data
      : currentSidRawTyped?.data === false || currentSidRawTyped?.data === "no"
        ? null
        : null;
  if (currentSid === existing.id) {
    return "bailed";
  }
  await sendExternalCommand({
    command: ["set_property", "sid", existing.id],
  });
  return "applied";
}
// ----- end inline copy -----

describe("@bugfix @regression-proof bail when sid already matches expected track id", () => {
  it(
    "@bugfix @regression-proof does NOT call set_property sid when currentSid === existing.id",
    async () => {
      const sendExternalRequest = vi.fn().mockResolvedValue({ data: 3, error: "success" });
      const sendExternalCommand = vi.fn().mockResolvedValue(true);

      const existing: MpvTrack & { id: number } = {
        id: 3,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      };

      console.info(`[regression-default-subtitle-bail-when-sid-matches:bail-on-match] currentSid=3 existing.id=${existing.id}, expecting bail`);
      const outcome = await eagerApplyExistingTrack(
        existing,
        sendExternalRequest,
        sendExternalCommand,
      );
      console.info(`[regression-default-subtitle-bail-when-sid-matches:bail-on-match] outcome=${outcome} sendExternalCommand callCount=${sendExternalCommand.mock.calls.length}`);

      try {
        expect(outcome).toBe("bailed");
        // set_property must NOT be called — it would cause a refresh-seek.
        expect(sendExternalCommand).not.toHaveBeenCalledWith(
          expect.objectContaining({ command: expect.arrayContaining(["set_property"]) }),
        );
        expect(sendExternalCommand).not.toHaveBeenCalled();
      } catch (err) {
        dumpBailSnapshot("bail-on-match", { existing, outcome, sendExternalRequest, sendExternalCommand });
        throw err;
      }
    },
  );

  it(
    "@bugfix @regression-proof DOES call set_property sid 3 when currentSid (5) differs from existing.id (3)",
    async () => {
      const sendExternalRequest = vi.fn().mockResolvedValue({ data: 5, error: "success" });
      const sendExternalCommand = vi.fn().mockResolvedValue(true);

      const existing: MpvTrack & { id: number } = {
        id: 3,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      };

      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-diff] currentSid=5 existing.id=${existing.id}, expecting apply`);
      const outcome = await eagerApplyExistingTrack(
        existing,
        sendExternalRequest,
        sendExternalCommand,
      );
      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-diff] outcome=${outcome} sendExternalCommand callCount=${sendExternalCommand.mock.calls.length}`);

      try {
        expect(outcome).toBe("applied");
        expect(sendExternalCommand).toHaveBeenCalledWith({
          command: ["set_property", "sid", 3],
        });
      } catch (err) {
        dumpBailSnapshot("apply-on-diff", { existing, outcome, sendExternalRequest, sendExternalCommand });
        throw err;
      }
    },
  );

  it(
    "@bugfix @regression-proof DOES call set_property sid when currentSid is null (sid='no')",
    async () => {
      const sendExternalRequest = vi.fn().mockResolvedValue({ data: "no", error: "success" });
      const sendExternalCommand = vi.fn().mockResolvedValue(true);

      const existing: MpvTrack & { id: number } = {
        id: 3,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      };

      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-no] currentSid='no'(null) existing.id=${existing.id}, expecting apply`);
      const outcome = await eagerApplyExistingTrack(
        existing,
        sendExternalRequest,
        sendExternalCommand,
      );
      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-no] outcome=${outcome} sendExternalCommand callCount=${sendExternalCommand.mock.calls.length}`);

      try {
        expect(outcome).toBe("applied");
        expect(sendExternalCommand).toHaveBeenCalledWith({
          command: ["set_property", "sid", 3],
        });
      } catch (err) {
        dumpBailSnapshot("apply-on-no", { existing, outcome, sendExternalRequest, sendExternalCommand });
        throw err;
      }
    },
  );

  it(
    "@bugfix @regression-proof DOES call set_property sid when currentSid is false",
    async () => {
      const sendExternalRequest = vi.fn().mockResolvedValue({ data: false, error: "success" });
      const sendExternalCommand = vi.fn().mockResolvedValue(true);

      const existing: MpvTrack & { id: number } = {
        id: 3,
        type: "sub",
        lang: "fr",
        title: "French",
        external: true,
      };

      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-false] currentSid=false(null) existing.id=${existing.id}, expecting apply`);
      const outcome = await eagerApplyExistingTrack(
        existing,
        sendExternalRequest,
        sendExternalCommand,
      );
      console.info(`[regression-default-subtitle-bail-when-sid-matches:apply-on-false] outcome=${outcome} sendExternalCommand callCount=${sendExternalCommand.mock.calls.length}`);

      try {
        expect(outcome).toBe("applied");
        expect(sendExternalCommand).toHaveBeenCalledWith({
          command: ["set_property", "sid", 3],
        });
      } catch (err) {
        dumpBailSnapshot("apply-on-false", { existing, outcome, sendExternalRequest, sendExternalCommand });
        throw err;
      }
    },
  );
});
