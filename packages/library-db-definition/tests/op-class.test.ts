/**
 * @test-id LIB-DB-OPCLASS-001
 * @level unit
 * @req LIB-SYNC-07[runtime]
 * @why Progress-class ops (media.progress, per-episode resume settings) must be
 *   told apart from structural ops so they never count toward the snapshot
 *   threshold. Every client shares this one classifier.
 */
import { describe, expect, it } from "vitest";
import { isProgressClassOp } from "../src/index";

const SUITE = "LIB-DB-OPCLASS-001";

describe("isProgressClassOp", () => {
  it("classifies media.progress and episode resume settings as progress", () => {
    console.info(`[${SUITE}:progress] checking progress-class ops`);
    const cases = [
      { type: "media.progress", payload: { mediaId: "m1" } },
      { type: "setting.set", payload: { key: "episode_resume_v1:ep-1", value: "{}" } },
    ];
    const results = cases.map((op) => isProgressClassOp(op));
    console.info(`[${SUITE}:progress] results=${JSON.stringify(results)}`);
    expect(results).toEqual([true, true]);
  });

  // @bugfix @regression-proof — pre-fix a non-main profile's resume/progress keys were structural.
  it("@req LIB-SYNC-07 classifies a non-main profile's resume and progress settings as progress", () => {
    console.info(`[${SUITE}:profile] checking p:<pid>: progress keys`);
    const cases = [
      { type: "setting.set", payload: { key: "p:prof-2:episode_resume_v1:ep-1", value: "{}" } },
      { type: "setting.set", payload: { key: "p:prof-2:media_progress_v1:m1", value: "{}" } },
      { type: "setting.set", payload: { key: "p:prof-2:track_prefs_v1:m1", value: "{}" } },
      { type: "setting.set", payload: { key: "p:prof-2:playlist_v1:favorites", value: "{}" } },
      { type: "setting.set", payload: { key: "p::episode_resume_v1:ep-1", value: "{}" } },
      // Only non-main profiles write media_progress_v1, but the unprefixed key classifies the same way.
      { type: "setting.set", payload: { key: "media_progress_v1:m1", value: "{}" } },
    ];
    const results = cases.map((op) => isProgressClassOp(op));
    console.info(`[${SUITE}:profile] results=${JSON.stringify(results)}`);
    expect(results).toEqual([true, true, false, false, false, true]);
  });

  it("classifies every other op as not progress", () => {
    console.info(`[${SUITE}:other] checking structural ops`);
    const cases = [
      { type: "media.upsert", payload: { details: { id: "m1" } } },
      { type: "media.delete", payload: { mediaId: "m1" } },
      { type: "setting.set", payload: { key: "ui.lang", value: "fr" } },
      { type: "setting.set", payload: { value: "no key" } },
      { type: "setting.set", payload: null },
      { type: "setting.set" },
      { type: "playlist.create", payload: { id: "p1" } },
    ];
    const results = cases.map((op) => isProgressClassOp(op));
    console.info(`[${SUITE}:other] results=${JSON.stringify(results)}`);
    expect(results).toEqual([false, false, false, false, false, false, false]);
  });
});
