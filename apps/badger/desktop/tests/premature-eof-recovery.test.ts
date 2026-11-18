// @bugfix @regression-proof issue #25 P6 — a premature demux EOF was taken
// as the end of the episode (ultimate run b51ea3c4, s2 c075 / x052 and 8
// resume-mismatch).
//
// Evidence (shard-2/logs/mpv-12-1791543795139.log:2954-2998):
//   14.994  mov,mp4: partial file → lavf EOF reached → "got EOF with no data"
//   15.005  "seeking to last frame..." → hr-seek to 720.000000 (paused)
//   15.016  [sf-skip] discontinuity detected: prev=145.93 cur=720.00
// The renderer poll then read time-pos 720 + eof-reached and trusted it: UI
// at the end, progress saved at 100 %, no resume offered on the next open.
//
// Fix: PrematureEofRecovery flags an EOF sample whose last trusted position
// is far from the end (and outside the user's end zone); the poll ignores it
// and seeks back to that position. Bounded, and a recovery that never lands
// still ends in a decision.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  END_ZONE_SEC,
  PREMATURE_EOF_MAX_RECOVERIES,
  PREMATURE_EOF_RECOVERY_WAIT_MS,
  PrematureEofRecovery,
} from "../src/renderer/src/lib/prematureEofRecovery";

const LOG = "[premature-eof-recovery]";
const DURATION = 720;
const NOW = 1_791_543_810_000;

const sample = (overrides: Partial<Parameters<PrematureEofRecovery["observe"]>[0]>) => ({
  eof: true,
  time: DURATION,
  duration: DURATION,
  lastTrustedTime: 145.93,
  creditsStart: null,
  now: NOW,
  ...overrides,
});

describe("premature EOF recovery (@bugfix @regression-proof issue #25 P6)", () => {
  it("replays s2 c075: the 145.9 → 720 EOF jump recovers at 145.9", () => {
    const recovery = new PrematureEofRecovery();
    const playing = recovery.observe(sample({ eof: false, time: 145.93, lastTrustedTime: 145.68 }));
    const jump = recovery.observe(sample({}));
    console.info(`${LOG} phase=c075 playing=${JSON.stringify(playing)} jump=${JSON.stringify(jump)}`);
    expect(playing).toEqual({ kind: "none" });
    expect(jump).toEqual({ kind: "recover", position: 145.93, attempt: 1 });
  });

  it("a genuine end (playback approached it) is trusted", () => {
    const recovery = new PrematureEofRecovery();
    const verdicts = [
      recovery.observe(sample({ eof: false, time: 719.5, lastTrustedTime: 719.25 })),
      recovery.observe(sample({ time: 719.97, lastTrustedTime: 719.5 })),
      recovery.observe(sample({ lastTrustedTime: 719.97 })),
    ];
    console.info(`${LOG} phase=natural-end verdicts=${JSON.stringify(verdicts)}`);
    expect(verdicts.every((verdict) => verdict.kind === "none")).toBe(true);
  });

  it("a jump to the end from the user's end zone (RIGHT, Skip credits) is trusted", () => {
    const recovery = new PrematureEofRecovery();
    const verdicts = {
      // RIGHT (+10 s) from 8 s before the end, no credits marker.
      rightInFallbackZone: recovery.observe(sample({ lastTrustedTime: DURATION - 8 })),
      // Skip credits from the start of a 90 s credits marker.
      skipCredits: recovery.observe(sample({ lastTrustedTime: 631, creditsStart: 630 })),
      // Just before the zone is still premature.
      beforeZone: recovery.observe(sample({ lastTrustedTime: DURATION - END_ZONE_SEC - 1 })),
    };
    console.info(`${LOG} phase=end-zone ${JSON.stringify(verdicts)}`);
    expect(verdicts.rightInFallbackZone).toEqual({ kind: "none" });
    expect(verdicts.skipCredits).toEqual({ kind: "none" });
    expect(verdicts.beforeZone.kind).toBe("recover");
  });

  it("missing data never triggers a recovery", () => {
    const recovery = new PrematureEofRecovery();
    const verdicts = [
      recovery.observe(sample({ eof: null, lastTrustedTime: 100 })),
      recovery.observe(sample({ duration: null, lastTrustedTime: 100 })),
      recovery.observe(sample({ lastTrustedTime: null })),
      // EOF while mpv still reports the real (mid-file) position: nothing to undo.
      recovery.observe(sample({ time: 146, lastTrustedTime: 145.9 })),
    ];
    console.info(`${LOG} phase=missing-data verdicts=${JSON.stringify(verdicts)}`);
    expect(verdicts.every((verdict) => verdict.kind === "none")).toBe(true);
  });

  it("bounds recoveries at one position, then accepts the end; a new position starts over", () => {
    const recovery = new PrematureEofRecovery();
    const atSamePosition = Array.from({ length: PREMATURE_EOF_MAX_RECOVERIES + 1 }, () =>
      recovery.observe(sample({ lastTrustedTime: 300 })),
    );
    const elsewhere = recovery.observe(sample({ lastTrustedTime: 500 }));
    console.info(`${LOG} phase=bounded same=${JSON.stringify(atSamePosition)} elsewhere=${JSON.stringify(elsewhere)}`);
    expect(atSamePosition.map((verdict) => verdict.kind)).toEqual([
      ...Array.from({ length: PREMATURE_EOF_MAX_RECOVERIES }, () => "recover"),
      "give-up",
    ]);
    expect(elsewhere).toEqual({ kind: "recover", position: 500, attempt: 1 });
  });

  it("a recovery that never shows as landed while mpv stays at EOF is reported stalled, once the wait passed", () => {
    const recovery = new PrematureEofRecovery();
    const first = recovery.observe(sample({}));
    const stalled = (now: number, overrides: { eof?: boolean | null; pendingTarget?: number | null } = {}) =>
      recovery.recoveryStalled({ eof: true, pendingTarget: 145.93, now, ...overrides });
    const checks = {
      seekInFlight: stalled(NOW + 1_000),
      otherTarget: stalled(NOW + PREMATURE_EOF_RECOVERY_WAIT_MS, { pendingTarget: 400 }),
      waitPassed: stalled(NOW + PREMATURE_EOF_RECOVERY_WAIT_MS),
    };
    // Once mpv reports a non-EOF sample, the recovery is no longer stalled.
    const landed = stalled(NOW + PREMATURE_EOF_RECOVERY_WAIT_MS + 100, { eof: false });
    const afterLanding = stalled(NOW + PREMATURE_EOF_RECOVERY_WAIT_MS * 2);
    console.info(`${LOG} phase=stall first=${JSON.stringify(first)} ${JSON.stringify({ ...checks, landed, afterLanding })}`);
    expect(first.kind).toBe("recover");
    expect(checks).toEqual({ seekInFlight: false, otherTarget: false, waitPassed: true });
    expect(landed).toBe(false);
    expect(afterLanding).toBe(false);
    // The stalled sample, observed again, is the next occurrence → bounded.
    const second = recovery.observe(sample({ now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS }));
    const third = recovery.observe(sample({ now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS * 2 }));
    expect([second.kind, third.kind]).toEqual(["recover", "give-up"]);
  });

  it("a second recovery at mpv's settled position (not the first target) still stalls and then gives up", () => {
    const recovery = new PrematureEofRecovery();
    const first = recovery.observe(sample({}));
    const firstStalled = recovery.recoveryStalled({ eof: true, pendingTarget: 145.93, now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS });
    // ensureExternalSeek rewrote lastKnownTime to mpv's settled 145.9583.
    const second = recovery.observe(sample({ lastTrustedTime: 145.9583, now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS }));
    const secondStalled = recovery.recoveryStalled({
      eof: true,
      pendingTarget: 145.9583,
      now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS * 2,
    });
    const third = recovery.observe(sample({ lastTrustedTime: 145.9583, now: NOW + PREMATURE_EOF_RECOVERY_WAIT_MS * 2 }));
    console.info(`${LOG} phase=drifted-stall ${JSON.stringify({ first, firstStalled, second, secondStalled, third })}`);
    expect([first.kind, firstStalled, second.kind, secondStalled, third.kind]).toEqual([
      "recover",
      true,
      "recover",
      true,
      "give-up",
    ]);
  });

  it("the engine poll routes every trusted sample through the premature-EOF check", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const wiring = {
      observe: /prematureEof\.observe\(/.test(src),
      creditsZone: /creditsStart: creditsStartRef\.current/.test(src),
      stallDisarms: /prematureEof\.recoveryStalled\([\s\S]{0,300}pendingStart\.arm\(null\)/.test(src),
      distrusts: /eofVerdict\.kind === "recover"[\s\S]{0,80}timeTrusted = false/.test(src),
      armsTarget: /pendingStart\.arm\(eofVerdict\.position\)/.test(src),
      seeksBack: /ensureExternalSeek\(eofVerdict\.position\)/.test(src),
    };
    console.info(`${LOG} phase=source-wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({
      observe: true,
      creditsZone: true,
      stallDisarms: true,
      distrusts: true,
      armsTarget: true,
      seeksBack: true,
    });
  });

  // @bugfix @regression-proof issue #25 P6 (review of PR #149): an app seek
  // (seekbar drag, keyboard, chapter) from 600 s straight to the end of a
  // 1440 s episode must stand. requestSeek used to leave lastKnownTimeRef at
  // 600, so the EOF that followed looked premature and was seeked back to 600.
  it("an app seek to the end is the trusted position, so its EOF is not undone", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const start = src.indexOf("const applyRequestedSeek = (");
    const body = start >= 0 ? src.slice(start, src.indexOf("\n  };\n", start)) : "";
    const seekTrustsTarget = /lastKnownTimeRef\.current = clamped;[\s\S]{0,200}pendingStart\.userSeek\(clamped\)/.test(body);
    // Replay what the poll feeds the check after the seek: the trusted time
    // is whatever requestSeek left in lastKnownTimeRef.
    const lastTrustedTime = seekTrustsTarget ? 1440 : 600;
    const recovery = new PrematureEofRecovery();
    const verdict = recovery.observe(sample({ time: 1440, duration: 1440, lastTrustedTime }));
    console.info(`${LOG} phase=app-seek-to-end requestSeekFound=${start >= 0} seekTrustsTarget=${seekTrustsTarget} lastTrustedTime=${lastTrustedTime} verdict=${JSON.stringify(verdict)}`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(seekTrustsTarget).toBe(true);
    expect(verdict.kind).toBe("none");
  });
});
