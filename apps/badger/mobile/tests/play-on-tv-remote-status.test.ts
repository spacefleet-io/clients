// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The remote's status line picks one `playOnTv.remote.*` text from the remote's status and the TV's last state;
 *   a wrong branch would show "Playing" on a TV that failed, or "Not found" for a generic failure.
 */
import { describe, expect, it } from "vitest";
import type { RemoteView } from "../src/lib/playOnTv/phoneRemote";
import { IDLE_STATE, type TvState } from "../src/lib/playOnTv/protocol";
import { remoteStatusKey } from "../src/lib/playOnTv/remoteStatus";

const tv = (phase: TvState["phase"], error: string | null = null): TvState => ({ ...IDLE_STATE, phase, error });

describe("remoteStatusKey", () => {
  it("maps every branch", () => {
    const cases: Array<[RemoteView, string]> = [
      [{ status: "unreachable", tv: tv("playing") }, "unreachable"],
      [{ status: "ended", tv: tv("playing") }, "ended"],
      [{ status: "connecting", tv: null }, "connecting"],
      [{ status: "waiting", tv: null }, "waiting"],
      [{ status: "connected", tv: null }, "connecting"],
      [{ status: "connected", tv: tv("failed", "media_not_found") }, "notFound"],
      [{ status: "connected", tv: tv("failed", "start_failed") }, "failed"],
      [{ status: "connected", tv: tv("failed") }, "failed"],
      [{ status: "connected", tv: tv("playing") }, "playing"],
      [{ status: "connected", tv: tv("paused") }, "paused"],
      [{ status: "connected", tv: tv("loading") }, "loading"],
      [{ status: "connected", tv: tv("ended") }, "ended"],
      [{ status: "connected", tv: tv("idle") }, "ended"],
      [{ status: "waiting", tv: tv("playing") }, "playing"],
    ];
    for (const [view, expected] of cases) {
      const key = remoteStatusKey(view);
      console.info("[phase:status]", JSON.stringify({ status: view.status, phase: view.tv?.phase ?? null, error: view.tv?.error ?? null, key }));
      expect(key).toBe(expected);
    }
  });
});
