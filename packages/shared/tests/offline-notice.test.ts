import { describe, expect, it } from "vitest";
import { offlineNoticeEdge } from "../src/offlineNotice";

/**
 * @test-id SHARED-OFFLINE-NOTICE-001
 * @level unit
 * @req UX-NOTICE-02[badger-mobile,badger-desktop]
 * @why Chris 2026-11-13 (design feedback on a dev build that could not reach its server): being offline is a normal
 *   state, so it must never hold a lasting banner. The phone and the computer say it once, in a notice that floats and
 *   leaves on its own, when the app goes offline, and take that notice back when the connection returns. This pure
 *   rule decides when: only on a change, never on a re-render while the state stays the same.
 */
const log = (step: string, detail: unknown) => console.info(`[SHARED-OFFLINE-NOTICE-001] ${step}`, JSON.stringify(detail));

describe("offlineNoticeEdge (UX-NOTICE-02)", () => {
  it("shows the notice once when the app goes offline", () => {
    const edge = offlineNoticeEdge(null, "network");
    log("online -> offline", edge);
    expect(edge).toEqual({ kind: "show", variant: "network" });
  });

  it("says nothing while the state stays the same (a re-render, a page change)", () => {
    log("offline -> offline", offlineNoticeEdge("network", "network"));
    expect(offlineNoticeEdge("network", "network")).toBeNull();
    expect(offlineNoticeEdge(null, null)).toBeNull();
  });

  it("takes the notice back when the connection returns, and shows nothing else", () => {
    const edge = offlineNoticeEdge("network", null);
    log("offline -> online", edge);
    expect(edge).toEqual({ kind: "withdraw" });
  });

  it("shows the new cause once when the reason changes (no network -> the sync fails)", () => {
    const edge = offlineNoticeEdge<"network" | "sync_error">("network", "sync_error");
    log("network -> sync_error", edge);
    expect(edge).toEqual({ kind: "show", variant: "sync_error" });
  });
});
