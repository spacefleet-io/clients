import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoPlayAllowed,
  isUserPause,
  markSentPauseSeen,
  shouldForceResumeExternalPlayback,
  type SentPause,
} from "../src/renderer/src/lib/mpvPlaybackResilience";

// Decision-matrix dump: on mismatch, print the exact input (paused flags,
// timing, lastSentPause) and observed-vs-expected so the failing resume
// gate is unambiguous. Wrapped in try/catch so a dump failure can't mask
// the assertion.
const dumpMpvPlaybackResilienceSnapshot = (
  label: string,
  input: Parameters<typeof shouldForceResumeExternalPlayback>[0],
  observed: boolean,
  expected: boolean,
) => {
  try {
    console.error(`=== [mpv-playback-resilience:${label}] decision snapshot ===`);
    console.error(`input=${JSON.stringify(input)}`);
    console.error(`observed=${observed} expected=${expected}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const assertForceResume = (
  label: string,
  input: Parameters<typeof shouldForceResumeExternalPlayback>[0],
  expected: boolean,
) => {
  const observed = shouldForceResumeExternalPlayback(input);
  if (observed !== expected) {
    dumpMpvPlaybackResilienceSnapshot(label, input, observed, expected);
  }
  expect(observed).toBe(expected);
};

describe("shouldForceResumeExternalPlayback", () => {
  it("[@bugfix][@regression-proof] requests a bounded resume when external mpv is unexpectedly paused after a user play action", () => {
    console.info("[mpv-playback-resilience:case] recent pause:false sent (4500ms), unexpectedly paused → expect resume true");
    assertForceResume(
      "unexpected-pause-after-play",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 3_000,
        lastSentPause: { value: false, at: 4_500 },
      },
      true,
    );
  });

  it("does not force resume while buffering, at eof, or when the user explicitly paused playback", () => {
    console.info("[mpv-playback-resilience:case] pausedForCache=true (buffering) → expect false");
    assertForceResume(
      "buffering-no-resume",
      {
        paused: true,
        pausedForCache: true,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 0,
        lastSentPause: null,
      },
      false,
    );
    console.info("[mpv-playback-resilience:case] eof=true → expect false");
    assertForceResume(
      "eof-no-resume",
      {
        paused: true,
        pausedForCache: false,
        eof: true,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 0,
        lastSentPause: null,
      },
      false,
    );
    console.info("[mpv-playback-resilience:case] userPaused=true → expect false");
    assertForceResume(
      "user-paused-no-resume",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: true,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 0,
        lastSentPause: null,
      },
      false,
    );
  });

  it("[@bugfix][@regression-proof] does NOT auto-resume when last command we sent was pause:true (OSC pause is user-initiated)", () => {
    console.info("[mpv-playback-resilience:case] lastSentPause.value=true → OSC pause is user-initiated → expect false");
    assertForceResume(
      "last-sent-pause-true",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 3_000,
        lastSentPause: { value: true, at: 4_500 },
      },
      false,
    );
  });

  it("[@bugfix][@regression-proof] does NOT auto-resume when no pause command has ever been sent (defensive default — covers the OSC-pause path before any renderer pause has happened)", () => {
    console.info("[mpv-playback-resilience:case] lastSentPause=null (never sent) → defensive default → expect false");
    assertForceResume(
      "no-pause-ever-sent",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 0,
        lastSentPause: null,
      },
      false,
    );
  });

  it("[@bugfix][@regression-proof] does NOT auto-resume when last pause:false is stale (>5s old — long after launch sequence ended)", () => {
    console.info("[mpv-playback-resilience:case] lastSentPause.at=1000, now=20000 (>5s stale) → expect false");
    assertForceResume(
      "stale-pause-false",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 20_000,
        lastAttemptAt: 3_000,
        lastSentPause: { value: false, at: 1_000 },
      },
      false,
    );
  });

  // @bugfix player-pause-resumes-by-itself @regression-proof @req MPV-PAUSE-01
  // Chris 2026-11-09 hand-try: "when I click pause it starts playing again
  // right away on its own, then I wait a bit and pause works". The app sends
  // pause:false when playback starts; a pause clicked in mpv (OSC centre
  // button, click on the picture, Space) within the next 5 s looked like
  // "mpv ignored our play", so the poll forced a resume every second.
  it("[@bugfix][@regression-proof] pause right after playback starts stays paused, 10 times in a row", () => {
    let sent: SentPause | null = null;
    let lastAttemptAt = 0;
    let now = 10_000;
    for (let round = 1; round <= 10; round += 1) {
      // The app starts playback: pause:false sent, mpv reports playing.
      sent = { value: false, at: now };
      now += 250;
      sent = markSentPauseSeen(sent, false);
      console.info(`[mpv-playback-resilience:pause-after-play] round=${round} play landed sent=${JSON.stringify(sent)}`);
      // The user pauses in mpv 300 ms later; the poll keeps seeing paused for 6 s.
      now += 300;
      for (let tick = 0; tick < 24; tick += 1) {
        now += 250;
        sent = markSentPauseSeen(sent, true);
        const input = {
          paused: true,
          pausedForCache: false,
          eof: false,
          userPaused: false,
          blockAutoPlay: false,
          externalActive: true,
          now,
          lastAttemptAt,
          lastSentPause: sent,
        };
        const observed = shouldForceResumeExternalPlayback(input);
        if (observed) {
          dumpMpvPlaybackResilienceSnapshot(`pause-after-play-round-${round}-tick-${tick}`, input, observed, false);
          lastAttemptAt = now;
        }
        expect(observed).toBe(false);
      }
    }
  });

  it("still retries while mpv has not reported playing since the app's pause:false", () => {
    const sent = markSentPauseSeen({ value: false, at: 4_500 }, true);
    console.info(`[mpv-playback-resilience:case] play not landed yet sent=${JSON.stringify(sent)} → expect resume true`);
    expect(sent?.applied).not.toBe(true);
    assertForceResume(
      "play-not-landed-yet",
      {
        paused: true,
        pausedForCache: false,
        eof: false,
        userPaused: false,
        blockAutoPlay: false,
        externalActive: true,
        now: 5_000,
        lastAttemptAt: 3_000,
        lastSentPause: sent,
      },
      true,
    );
  });
});

// @bugfix player-pause-resumes-by-itself @regression-proof @req MPV-PAUSE-01
// Chris, 2026-11-09: a pause made while playback starts (deferred launch,
// backdrop->stream handoff, resume-from-position seek) was undone ~1 s later
// by the app's own automatic play.
describe("user pause wins over automatic play", () => {
  it("[@bugfix][@regression-proof] a pause in mpv the app did not send is the user's", () => {
    const now = 10_000;
    expect(isUserPause({ previous: false, next: true, lastSentPause: null, now })).toBe(true);
    expect(isUserPause({ previous: false, next: true, lastSentPause: { value: false, at: now - 200 }, now })).toBe(true);
    // The app's own pause echoing back is not the user's.
    expect(isUserPause({ previous: false, next: true, lastSentPause: { value: true, at: now - 200 }, now })).toBe(false);
    // An old app pause does not cover a new pause.
    expect(isUserPause({ previous: false, next: true, lastSentPause: { value: true, at: now - 60_000 }, now })).toBe(true);
    // Launching paused (no "playing" seen before) is not a user pause.
    expect(isUserPause({ previous: null, next: true, lastSentPause: null, now })).toBe(false);
    expect(isUserPause({ previous: true, next: false, lastSentPause: null, now })).toBe(false);
  });

  // @bugfix eof-pause-counted-as-user-pause (PD13 follow-up, 2026-11-16): mpv runs with --keep-open=yes, so it
  // pauses itself at the end of the file. That pause was stamped as the user's, so after a premature EOF
  // (issue #25 P6) the recovery seeked back to the real position and then left the film paused.
  it("[@bugfix][@regression-proof] mpv's own pause at the end of the file is not the user's", () => {
    const now = 10_000;
    expect(isUserPause({ previous: false, next: true, eof: true, lastSentPause: null, now })).toBe(false);
    expect(isUserPause({ previous: false, next: true, eof: false, lastSentPause: null, now })).toBe(true);
    expect(isUserPause({ previous: false, next: true, eof: null, lastSentPause: null, now })).toBe(true);
    // Both pause readers pass the end-of-file state of the same read.
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    expect(src).toContain("noteMpvPause(paused, eof)");
    expect(src).toContain("noteMpvPause(value, observedEofRef.current)");
  });

  it("[@bugfix][@regression-proof] an automatic play never overrides a pause made after the play request", () => {
    // Play requested at 1000; user paused during the handoff/seek at 1800.
    expect(autoPlayAllowed({ playRequestedAt: 1000, userPausedAt: 1800 })).toBe(false);
    // Pause before the deferred launch, still after the request: pause wins.
    expect(autoPlayAllowed({ playRequestedAt: 1000, userPausedAt: 1000 })).toBe(false);
    // A later explicit play (Resume, Space, Play button) beats an older pause.
    expect(autoPlayAllowed({ playRequestedAt: 2000, userPausedAt: 1800 })).toBe(true);
    expect(autoPlayAllowed({ playRequestedAt: 0, userPausedAt: null })).toBe(true);
  });
});
