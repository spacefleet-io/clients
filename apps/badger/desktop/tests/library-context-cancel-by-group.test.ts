/**
 * @bugfix
 * @regression-proof
 *
 * effervescent-teapot Round 3 — "delete media + re-add same file".
 *
 * Verifies the renderer-side wiring of the V2 cancel-by-group cascade:
 * when the V2 flag is on, deleting a media item must call
 * `window.sf.runtimeJobs.cancelByGroup({ groupId, reason })` alongside the
 * legacy lab-queue `remove_media_jobs` path. When the V2 flag is off, the
 * V2 IPC must NOT fire (legacy-only behavior is preserved).
 */
import { describe, expect, it, vi } from "vitest";
import { cancelRuntimeJobsByGroupForDelete } from "../src/renderer/src/lib/libraryContext";

// Dump-on-failure: surface the cancelByGroup mock's call count + args and the
// onError routing so a wiring regression (wrong groupId/reason, fired/not-fired
// under the wrong flag) is diagnosable offline.
const dumpCancelByGroupSnapshot = (
  label: string,
  ctx: { cancelByGroup?: ReturnType<typeof vi.fn>; onError?: ReturnType<typeof vi.fn> },
) => {
  try {
    console.error(`=== [library-context-cancel-by-group:${label}] snapshot ===`);
    console.error(
      `cancelByGroup callCount=${ctx.cancelByGroup?.mock.calls.length ?? "(no-mock)"}`,
    );
    console.error(`cancelByGroup calls=${JSON.stringify(ctx.cancelByGroup?.mock.calls ?? null, null, 2)}`);
    if (ctx.onError) {
      console.error(`onError callCount=${ctx.onError.mock.calls.length}`);
      console.error(
        `onError first-arg=${JSON.stringify(
          ctx.onError.mock.calls[0]?.[0] instanceof Error
            ? { name: ctx.onError.mock.calls[0][0].name, message: ctx.onError.mock.calls[0][0].message }
            : ctx.onError.mock.calls[0]?.[0],
        )}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("cancelRuntimeJobsByGroupForDelete @bugfix @regression-proof", () => {
  it("calls cancelByGroup with { groupId, reason: 'media-deleted' } when V2 is enabled", async () => {
    console.info(`[library-context-cancel-by-group:v2-on] deleting media-orchard with v2Enabled=true`);
    const cancelByGroup = vi.fn().mockResolvedValue({
      cancelled: 2,
      dismissed: 1,
    });
    await cancelRuntimeJobsByGroupForDelete({
      mediaId: "media-orchard",
      v2Enabled: true,
      cancelByGroup,
    });
    console.info(
      `[library-context-cancel-by-group:v2-on] cancelByGroup calls=${JSON.stringify(cancelByGroup.mock.calls)}`,
    );
    try {
      expect(cancelByGroup).toHaveBeenCalledTimes(1);
      expect(cancelByGroup).toHaveBeenCalledWith({
        groupId: "media-orchard",
        reason: "media-deleted",
      });
    } catch (err) {
      dumpCancelByGroupSnapshot("v2-on", { cancelByGroup });
      throw err;
    }
  });

  it("does NOT call cancelByGroup when V2 is disabled (legacy lab-queue path only)", async () => {
    console.info(`[library-context-cancel-by-group:v2-off] deleting media-orchard with v2Enabled=false`);
    const cancelByGroup = vi.fn();
    await cancelRuntimeJobsByGroupForDelete({
      mediaId: "media-orchard",
      v2Enabled: false,
      cancelByGroup,
    });
    console.info(
      `[library-context-cancel-by-group:v2-off] cancelByGroup callCount=${cancelByGroup.mock.calls.length} (expected 0)`,
    );
    try {
      expect(cancelByGroup).not.toHaveBeenCalled();
    } catch (err) {
      dumpCancelByGroupSnapshot("v2-off", { cancelByGroup });
      throw err;
    }
  });

  it("is a no-op when the IPC surface is missing (older preload)", async () => {
    console.info(`[library-context-cancel-by-group:no-ipc] v2Enabled=true but cancelByGroup undefined`);
    await expect(
      cancelRuntimeJobsByGroupForDelete({
        mediaId: "media-orchard",
        v2Enabled: true,
        cancelByGroup: undefined,
      })
    ).resolves.toBeUndefined();
    console.info(`[library-context-cancel-by-group:no-ipc] resolved without throwing`);
  });

  it("swallows errors and routes them through onError so the delete flow continues", async () => {
    console.info(`[library-context-cancel-by-group:error-routing] cancelByGroup rejects with runtime_jobs_http_503`);
    const cancelByGroup = vi
      .fn()
      .mockRejectedValue(new Error("runtime_jobs_http_503"));
    const onError = vi.fn();
    await expect(
      cancelRuntimeJobsByGroupForDelete({
        mediaId: "media-orchard",
        v2Enabled: true,
        cancelByGroup,
        onError,
      })
    ).resolves.toBeUndefined();
    console.info(
      `[library-context-cancel-by-group:error-routing] onError callCount=${onError.mock.calls.length} firstArgIsError=${onError.mock.calls[0]?.[0] instanceof Error}`,
    );
    try {
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    } catch (err) {
      dumpCancelByGroupSnapshot("error-routing", { cancelByGroup, onError });
      throw err;
    }
  });
});
