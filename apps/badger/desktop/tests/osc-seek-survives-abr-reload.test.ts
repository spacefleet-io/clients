// @bugfix @regression-proof issue #25 P1b (ultimate run 1791529129542, S1
// c055, osc-pill-disappear: "liveStart: 0, capturedTime: 0").
//
// Evidence (shard-1/logs/mpv-11-1791539789582.log + shard-1/timeline.jsonl):
//   [3.247]  OSC seekbar click: seek 20.268362 absolute-percent+exact
//            (no "queuing seek" follows: mpv had not executed it yet)
//   52299    format switch: reload position read live from mpv
//            {liveStart: 0, capturedTime: 0}   ← the ABR reload read time-pos 0
//   [3.711]  loadfile … replace, options="demuxer-cache-wait=no"  ← no start=
//   [4.840]  playback restart complete @ 0.021000
//
// The seek happened inside mpv (tog4in1 seekbar), so the renderer never
// learnt its target; mpv still reported the pre-seek 0, and the ABR reload
// restarted the episode at 0:00.
//
// Fix: the OSC announces every absolute seek on `sf-osc-seek <seconds>`.
// The engine treats it like an app seek (arms the pending start target), so
// the reload resumes at the seek target. A seek made WHILE a reload is in
// flight is carried through the reload and applied when it restores the
// position, instead of the reload's own (older) start.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { seeksAllowed } from "@space/desktop-mpv-playback";
import { LUA_OUTBOUND_CHANNELS } from "@space/mpv-protocol";
import { describe, expect, it } from "vitest";
import {
  parseOscSeekMessage,
  PendingStartTarget,
  resolveReloadStartTime,
} from "../src/renderer/src/lib/pendingStartTarget";

const LOG = "[osc-seek-survives-abr-reload]";
// 20.268362 % of the episode. The run does not log the episode duration, so
// this target is illustrative (a 12-minute episode); the bug does not depend
// on the exact value, only on it being far from mpv's pre-seek 0.
const C055_TARGET = 145.932;

const seekMessage = (...args: unknown[]) => ({
  type: "script_message",
  name: LUA_OUTBOUND_CHANNELS.OSC_SEEK,
  args,
});

describe("an OSC seek survives an ABR reload (@bugfix @regression-proof issue #25 P1b)", () => {
  it("parses only well-formed sf-osc-seek messages", () => {
    const accepted = parseOscSeekMessage(seekMessage(String(C055_TARGET)));
    const zero = parseOscSeekMessage(seekMessage("0"));
    const rejected = [
      seekMessage("abc"),
      seekMessage("-3"),
      seekMessage("Infinity"),
      seekMessage(),
      { type: "script_message", name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED, args: ["12"] },
      { type: "osc_action", name: LUA_OUTBOUND_CHANNELS.OSC_SEEK, args: ["12"] },
    ].map((msg) => parseOscSeekMessage(msg));
    console.info(`${LOG} phase=parse accepted=${accepted} zero=${zero} rejected=${JSON.stringify(rejected)}`);
    expect(accepted).toBe(C055_TARGET);
    expect(zero).toBe(0);
    expect(rejected.every((value) => value === null)).toBe(true);
  });

  it("replays c055: the ABR reload after an OSC seek resumes at the seek target, not mpv's pre-seek 0", () => {
    const pending = new PendingStartTarget();
    // Fresh launch at 0: nothing pending.
    pending.arm(0);
    // [3.247] the OSC seek is announced; mpv still reports 0.
    const armed = pending.userSeek(C055_TARGET);
    const verdict = pending.observe(0, 1_000);
    console.info(`${LOG} phase=osc-seek armed=${armed} verdict-on-pre-seek-0=${verdict}`);
    expect(armed).toBe(C055_TARGET);
    expect(verdict).toBe("pending");
    // 52299: the format switch captures time-pos 0.
    const liveStart = resolveReloadStartTime({
      pendingStart: pending.get(),
      capturedTime: 0,
      seekTarget: C055_TARGET,
      lastKnownTime: 0,
      loadInFlight: pending.isLoadInFlight(),
    });
    console.info(`${LOG} phase=reload-start liveStart=${liveStart}`);
    expect(liveStart).toBe(C055_TARGET);
  });

  it("a seek made while the reload's file is loading wins over the reload's own start", () => {
    const pending = new PendingStartTarget();
    pending.armForReload(8.5);
    // The user drags the seekbar while the loadfile is in flight.
    pending.userSeek(C055_TARGET);
    console.info(`${LOG} phase=seek-during-load pending=${pending.get()} loadInFlight=${pending.isLoadInFlight()}`);
    // The old file's samples stay untrusted until the new file loads.
    expect(pending.isLoadInFlight()).toBe(true);
    expect(pending.observe(C055_TARGET, 1)).toBe("pending");
    pending.loadLanded();
    const reloadSeek = pending.takeReloadSeek(8.5);
    console.info(`${LOG} phase=restore reloadSeek=${reloadSeek}`);
    expect(reloadSeek).toBe(C055_TARGET);
    // Consumed: a later reload sends nothing (its start= positions it).
    pending.armForReload(30);
    expect(pending.takeReloadSeek(30)).toBe(null);
  });

  it("a seek after the new file loaded but before the restore still wins; otherwise the loadfile start= stands", () => {
    const pending = new PendingStartTarget();
    // Seek back to 0 while reloading at 8.5: the loadfile carried start=8.5.
    pending.armForReload(8.5);
    pending.loadLanded();
    pending.userSeek(0);
    expect(pending.takeReloadSeek(8.5)).toBe(0);

    // No seek during the reload: nothing to send.
    pending.armForReload(8.5);
    pending.loadLanded();
    expect(pending.takeReloadSeek(8.5)).toBe(null);
    // A seek to where the loadfile already starts sends nothing either.
    pending.armForReload(8.5);
    pending.userSeek(8.6);
    expect(pending.takeReloadSeek(8.5)).toBe(null);
    // A null/0 start loads at 0: a seek to 0 needs nothing, a seek past it does.
    pending.armForReload(null);
    pending.userSeek(0);
    expect(pending.takeReloadSeek(null)).toBe(null);
    pending.armForReload(null);
    pending.userSeek(42);
    expect(pending.takeReloadSeek(null)).toBe(42);
    // A settled reload (failure path) drops a stale seek instead of carrying it.
    pending.armForReload(8.5);
    pending.userSeek(40);
    pending.reloadSettled();
    expect(pending.takeReloadSeek(12)).toBe(null);
    // A fresh launch arm drops it too.
    pending.armForReload(8.5);
    pending.userSeek(40);
    pending.arm(5);
    expect(pending.takeReloadSeek(12)).toBe(null);
  });

  it("the reload sends that seek past the phase gate, which is still closed while it restores", () => {
    // The restore runs before `stream_loadfile_done`: the phase is
    // reloading{streamLoaded:false} and seeksAllowed is false, so a seek
    // routed through ensureExternalSeek would be dropped (review of PR 151).
    const gateOpen = seeksAllowed({
      kind: "reloading",
      gen: 1,
      streamLoaded: false,
      lastLaunchedKey: null,
      lastReloadSignature: null,
      lastConsumedIntent: null,
    });
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const restoreAt = engine.indexOf("pendingStart.takeReloadSeek(options.startTime)");
    const loadfileDoneAt = engine.indexOf('dispatchPhase({ type: "stream_loadfile_done" })', restoreAt);
    const restore = engine.slice(restoreAt, loadfileDoneAt);
    const wiring = {
      gateOpen,
      restoreBeforeLoadfileDone: restoreAt > -1 && loadfileDoneAt > restoreAt,
      sendsDirect: /sendExternalCommand\(buildSeekCommand\(reloadSeek, "absolute", "exact"\)\)/.test(restore),
      gatedSeek: /ensureExternalSeek\(/.test(restore),
    };
    console.info(`${LOG} phase=gate ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({ gateOpen: false, restoreBeforeLoadfileDone: true, sendsDirect: true, gatedSeek: false });
  });

  it("the OSC announces its absolute seeks and the engine wires them through the reload", () => {
    const tog = readFileSync(resolve(__dirname, "../../../../packages/mpv/resources/osc/tog4in1/tog4in1.lua"), "utf8");
    const sf = readFileSync(resolve(__dirname, "../../../../packages/mpv/resources/osc/sf.lua"), "utf8");
    const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const togAnnounces = tog.match(/announce_osc_seek\(/g)?.length ?? 0;
    const sfAnnounces = sf.match(/announce_osc_seek\(/g)?.length ?? 0;
    console.info(`${LOG} phase=wiring togAnnounces=${togAnnounces} sfAnnounces=${sfAnnounces}`);
    // definition + seekbar drag + seekbar click
    expect(togAnnounces).toBe(3);
    expect(tog.includes(`"${LUA_OUTBOUND_CHANNELS.OSC_SEEK}"`)).toBe(true);
    // definition + skip intro/credits marker
    expect(sfAnnounces).toBe(2);
    expect(sf.includes(`"${LUA_OUTBOUND_CHANNELS.OSC_SEEK}"`)).toBe(true);
    const needles = [
      "parseOscSeekMessage(msg)",
      "pendingStart.userSeek(",
      "pendingStart.takeReloadSeek(options.startTime)",
      "pendingStart.reloadSettled();",
    ];
    for (const needle of needles) {
      console.info(`${LOG} phase=source needle=${JSON.stringify(needle)} present=${engine.includes(needle)}`);
      expect(engine.includes(needle)).toBe(true);
    }
  });
});
