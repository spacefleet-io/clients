// @bugfix @regression-proof issue #25 — an ABR / quality switch during start
// or right after a seek left mpv paused or lost the seek (ultimate run part
// 2, "skip-intro pill missing": playback never reached the 60 s marker).
//
// Root causes (agent MpvOscSeek, all in useMpvPlaybackEngine.ts):
//   c035   ABR 1080p → 360p during the backdrop handoff: selectFixedFormat
//          paused mpv, the init effect skipped "load already in flight" and
//          nothing re-ran it after the load settled. time-pos froze 54.938.
//   c065   startFrom's zero-seek path left `userZeroSeek` parked; the
//          switch's init re-fire took the intent-consume return, no
//          loadStream, mpv stayed paused.
//   x002   OSC seekbar seek to 55 s inside mpv, ABR downshift 100 ms later
//          reloaded at the renderer's stale polled 1.938 s (render-closure
//          `currentTime`), so the seek was lost.
//   +      `abrSwitchInFlightRef` latched true and was never cleared.
//
// Fix: PendingFormatSwitch + decideInitEntry / decideIntentConsume /
// shouldRetryDeferredSwitch (formatSwitchReload.ts). A switch always
// completes: reload now, or queue behind the in-flight load and re-fire the
// init effect once it settles; exits that do not reload settle the switch
// and resume mpv unless the user paused. The reload position is mpv's live
// time-pos read at reload time (pending start target first).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideInitEntry,
  decideIntentConsume,
  PendingFormatSwitch,
  shouldRetryDeferredSwitch,
} from "../src/renderer/src/lib/formatSwitchReload";
import {
  PendingStartTarget,
  resolveFormatSwitchResumeTime,
  resolveReloadStartTime,
} from "../src/renderer/src/lib/pendingStartTarget";

const LOG = "[abr-switch-always-completes]";
const log = (phase: string, data: Record<string, unknown>) =>
  console.info(`${LOG} phase=${phase} ${JSON.stringify(data)}`);

/**
 * Minimal model of the engine's external-mpv switch path, driven only by the
 * production decision functions. Records every mpv-visible effect so each
 * scenario can assert "mpv ends up playing at the right place".
 */
class SwitchHarness {
  readonly formatSwitch = new PendingFormatSwitch();
  readonly pendingStart = new PendingStartTarget();
  loadInFlight = false;
  lastLaunchedKey = "file|1080p|a";
  currentKey = "file|1080p|a";
  pendingIntent: string | null = null;
  mpvPaused = false;
  mpvTimePos = 0;
  lastKnownTime = 0;
  seekTarget: number | null = null;
  userPaused = false;
  readonly loads: Array<{ startTime: number | null; paused: boolean; key: string }> = [];
  readonly history: string[] = [];

  private note(entry: string, data: Record<string, unknown> = {}) {
    this.history.push(entry);
    log(entry, { ...data, mpvPaused: this.mpvPaused, timePos: this.mpvTimePos, pending: this.formatSwitch.get() });
  }

  /** selectFixedFormat: pause mpv, record the switch, change the key. */
  selectFixedFormat(formatId: string, source: "user" | "abr") {
    this.mpvPaused = true;
    const resumeTime = resolveFormatSwitchResumeTime({
      pendingStart: this.pendingStart.get(),
      lastKnownTime: this.lastKnownTime,
    });
    this.lastKnownTime = resumeTime;
    this.seekTarget = resumeTime;
    const request = this.formatSwitch.request({
      source,
      formatId,
      now: 0,
      resumeAutoplay: !this.userPaused,
    });
    this.currentKey = `file|${formatId}|a`;
    this.note("selectFixedFormat", { formatId, source, resumeTime, switchId: request.id });
    this.runInitEffect();
  }

  /** The init effect's entry + reload body (external player, mpv alive). */
  runInitEffect() {
    const pending = this.formatSwitch.get();
    const entry = decideInitEntry({
      loadInFlight: this.loadInFlight,
      switchPending: pending !== null,
      matchesLastLaunchedKey: this.lastLaunchedKey === this.currentKey,
    });
    this.note("init-entry", { entry });
    if (entry === "defer-switch-until-settled") {
      this.formatSwitch.defer();
      return;
    }
    if (entry === "settle-switch-already-loaded") {
      const settled = this.formatSwitch.settle();
      if (settled?.resumeAutoplay && !this.userPaused) this.mpvPaused = false;
      return;
    }
    if (entry !== "proceed") return;
    let resumeTime = this.seekTarget ?? this.lastKnownTime;
    if (pending) {
      const liveStart = resolveReloadStartTime({
        pendingStart: this.pendingStart.get(),
        capturedTime: this.mpvTimePos,
        seekTarget: this.seekTarget,
        lastKnownTime: this.lastKnownTime,
      });
      if (liveStart !== null) resumeTime = liveStart;
      this.note("live-capture", { capturedTime: this.mpvTimePos, liveStart });
    }
    const intent = decideIntentConsume({
      pendingIntent: this.pendingIntent,
      externalActive: true,
      switchPending: pending !== null,
    });
    this.note("intent", { intent, pendingIntent: this.pendingIntent });
    if (intent === "consume-intent-and-skip") {
      this.pendingIntent = null;
      return;
    }
    if (intent === "consume-intent-and-load") this.pendingIntent = null;
    const paused = this.userPaused;
    this.loads.push({ startTime: resumeTime, paused, key: this.currentKey });
    this.lastLaunchedKey = this.currentKey;
    this.mpvTimePos = resumeTime;
    this.mpvPaused = paused;
    if (pending) this.formatSwitch.settle(pending.id);
    this.note("reloaded", { startTime: resumeTime, paused });
  }

  /** The in-flight load settles; the retry effect runs. */
  settleInFlightLoad() {
    this.loadInFlight = false;
    const retry = shouldRetryDeferredSwitch({ loadInFlight: false, pending: this.formatSwitch.get() });
    this.note("load-settled", { retry });
    if (retry) {
      this.formatSwitch.markRetried();
      this.runInitEffect();
    }
  }

  dump() {
    return JSON.stringify({ loads: this.loads, history: this.history, mpvPaused: this.mpvPaused, pending: this.formatSwitch.get() });
  }
}

describe("ABR / quality switch always completes (@bugfix @regression-proof issue #25)", () => {
  it("c035: ABR downshift during the backdrop handoff is queued and reloads at mpv's live position once the load settles", () => {
    const h = new SwitchHarness();
    h.loadInFlight = true; // backdrop handoff
    h.mpvTimePos = 54.938;
    h.lastKnownTime = 54.7;
    h.selectFixedFormat("360p", "abr");
    expect(h.formatSwitch.get()?.waitingForLoad, h.dump()).toBe(true);
    expect(h.loads, h.dump()).toHaveLength(0);
    // While still in flight no retry fires.
    expect(shouldRetryDeferredSwitch({ loadInFlight: true, pending: h.formatSwitch.get() })).toBe(false);
    h.settleInFlightLoad();
    log("c035-result", { loads: h.loads, mpvPaused: h.mpvPaused });
    expect(h.loads, h.dump()).toEqual([{ startTime: 54.938, paused: false, key: "file|360p|a" }]);
    expect(h.mpvPaused, h.dump()).toBe(false);
    expect(h.formatSwitch.get(), "switch (ABR in-flight flag) cleared").toBeNull();
  });

  it("c065: a parked userZeroSeek intent no longer swallows the switch's reload", () => {
    const h = new SwitchHarness();
    h.pendingIntent = "userZeroSeek";
    h.mpvTimePos = 3.2;
    h.lastKnownTime = 3.0;
    h.selectFixedFormat("360p", "abr");
    log("c065-result", { loads: h.loads, mpvPaused: h.mpvPaused, pendingIntent: h.pendingIntent });
    expect(h.loads, h.dump()).toEqual([{ startTime: 3.2, paused: false, key: "file|360p|a" }]);
    expect(h.pendingIntent, "stale intent consumed").toBeNull();
    expect(h.mpvPaused).toBe(false);
    expect(h.formatSwitch.get()).toBeNull();
  });

  it("c065 guard kept: without a switch the startFrom intent still skips the duplicate load", () => {
    expect(decideIntentConsume({ pendingIntent: "userZeroSeek", externalActive: true, switchPending: false })).toBe(
      "consume-intent-and-skip",
    );
    expect(decideIntentConsume({ pendingIntent: "userManual", externalActive: false, switchPending: false })).toBe(
      "consume-intent-and-skip",
    );
    expect(decideIntentConsume({ pendingIntent: "userZeroSeek", externalActive: false, switchPending: true })).toBe("load");
    expect(decideIntentConsume({ pendingIntent: null, externalActive: true, switchPending: true })).toBe("load");
    expect(decideIntentConsume({ pendingIntent: "userManual", externalActive: true, switchPending: true })).toBe(
      "consume-intent-and-load",
    );
  });

  it("s1:x002: OSC seek to 55 s then ABR downshift 100 ms later reloads at 55 s, not the stale polled 1.938 s", () => {
    const h = new SwitchHarness();
    h.lastKnownTime = 1.938; // last poll before the seek
    h.mpvTimePos = 55; // seek done inside mpv (OSC seekbar); time-pos reports the target
    h.selectFixedFormat("360p", "abr");
    log("x002-result", { loads: h.loads });
    expect(h.loads, h.dump()).toEqual([{ startTime: 55, paused: false, key: "file|360p|a" }]);
    expect(h.formatSwitch.get()).toBeNull();
  });

  it("PR #81 kept: a pending start target still wins over the live pre-seek time-pos 0", () => {
    const h = new SwitchHarness();
    h.pendingStart.arm(39.54);
    h.mpvTimePos = 0;
    h.selectFixedFormat("720p", "abr");
    expect(h.loads, h.dump()).toEqual([{ startTime: 39.54, paused: false, key: "file|720p|a" }]);
  });

  it("a user pause survives the switch: reload stays paused", () => {
    const h = new SwitchHarness();
    h.userPaused = true;
    h.mpvTimePos = 12;
    h.selectFixedFormat("720p", "user");
    expect(h.loads, h.dump()).toEqual([{ startTime: 12, paused: true, key: "file|720p|a" }]);
    expect(h.mpvPaused).toBe(true);
  });

  it("switch back to the already-loaded format settles the switch and resumes mpv (no reload, no stuck pause)", () => {
    const h = new SwitchHarness();
    h.mpvTimePos = 20;
    h.selectFixedFormat("1080p", "user");
    expect(h.loads, h.dump()).toHaveLength(0);
    expect(h.mpvPaused, h.dump()).toBe(false);
    expect(h.formatSwitch.get()).toBeNull();
  });

  it("two switches queued behind one in-flight load: the latest wins and reloads once", () => {
    const h = new SwitchHarness();
    h.loadInFlight = true;
    h.mpvTimePos = 30;
    h.selectFixedFormat("720p", "abr");
    h.selectFixedFormat("360p", "abr");
    expect(h.formatSwitch.get()?.deferrals).toBe(2);
    h.settleInFlightLoad();
    expect(h.loads, h.dump()).toEqual([{ startTime: 30, paused: false, key: "file|360p|a" }]);
    expect(h.formatSwitch.get()).toBeNull();
  });

  it("settle(id) never clears a newer switch that arrived while the previous one was reloading", () => {
    const tracker = new PendingFormatSwitch();
    const first = tracker.request({ source: "abr", formatId: "720p", now: 0, resumeAutoplay: true });
    const second = tracker.request({ source: "user", formatId: "1080p", now: 1, resumeAutoplay: true });
    expect(tracker.settle(first.id)).toBeNull();
    expect(tracker.get()?.id).toBe(second.id);
    expect(tracker.settle(second.id)?.formatId).toBe("1080p");
    expect(tracker.get()).toBeNull();
  });

  it("decideInitEntry: legacy skips unchanged when no switch is pending", () => {
    expect(decideInitEntry({ loadInFlight: true, switchPending: false, matchesLastLaunchedKey: false })).toBe("skip-load-in-flight");
    expect(decideInitEntry({ loadInFlight: false, switchPending: false, matchesLastLaunchedKey: true })).toBe(
      "skip-matches-last-launched-key",
    );
    expect(decideInitEntry({ loadInFlight: false, switchPending: false, matchesLastLaunchedKey: false })).toBe("proceed");
    expect(decideInitEntry({ loadInFlight: true, switchPending: true, matchesLastLaunchedKey: true })).toBe(
      "defer-switch-until-settled",
    );
  });

  it("the engine routes switches through PendingFormatSwitch on every init exit", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const initDeps = src.match(/\}, \[\s*open,\s*fileId,\s*initSignature,[\s\S]*?\]\);/)?.[0] ?? "";
    const selectFixed = src.match(/const selectFixedFormat = [\s\S]*?\n {2}\};/)?.[0] ?? "";
    const selectAuto = src.match(/const selectAutoQuality = [\s\S]*?\n {2}\};/)?.[0] ?? "";
    const wiring = {
      noAbrLatch: !/abrSwitchInFlightRef\s*[.=]/.test(src.replace(/\/\/.*$/gm, "")),
      entryDecision: /decideInitEntry\(\{\s*loadInFlight: isLoadInFlight\(phaseRef\.current\)/.test(src),
      deferQueues: /formatSwitch\.defer\(\);\s*setFormatSwitchDeferTick/.test(src),
      retryEffect: /shouldRetryDeferredSwitch\(\{[\s\S]{0,200}?\}\)\) return;\s*formatSwitch\.markRetried\(\);/.test(src),
      retryNonceInDeps: /formatSwitchRetryNonce/.test(initDeps),
      intentDecision: /decideIntentConsume\(\{[\s\S]{0,200}?switchPending: pendingSwitch !== null/.test(src),
      liveCapture: /if \(pendingSwitch && externalPlayer && isExternalActive\(lifecycleRef\.current\)\) \{\s*const timePos = await getProperty\(sendExternalRequest, "time-pos"\);\s*const capturedTime = typeof timePos === "number" \? timePos : null;/.test(src),
      settleReloaded: /formatSwitch\.settle\(pendingSwitch\.id\)/.test(src),
      settleSmoke: /settleFormatSwitchWithoutReload\("smoke-test", false\)/.test(src),
      settleDeferred: /settleFormatSwitchWithoutReload\("playback-deferred", false\)/.test(src),
      settleResumePrompt: /settleFormatSwitchWithoutReload\("resume-prompt", false\)/.test(src),
      settleAlreadyLoaded: /settleFormatSwitchWithoutReload\("already-loaded", true\)/.test(src),
      settleLoadFailed: /dispatchPhase\(\{ type: "load_failed" \}\);\s*const failedSwitch = formatSwitch\.settle\(\);/.test(src),
      fixedRecords: /formatSwitch\.request\(/.test(selectFixed) && /setFormatSwitchRetryNonce/.test(selectFixed),
      autoRecords: /formatSwitch\.request\(/.test(selectAuto) && /setFormatSwitchRetryNonce/.test(selectAuto),
      noClosureResume: !/uiTime: currentTime,\s*lastKnownTime/.test(src),
    };
    log("source-wiring", wiring);
    for (const [name, ok] of Object.entries(wiring)) {
      expect(ok, `engine wiring: ${name}`).toBe(true);
    }
  });
});
