// @bugfix @regression-proof issue #25 NEW-resume-wrong-episode (ultimate run
// 1791422679313, S1 x005 / S2 c060): after an OSC next-episode the poll saved
// pct 0 to the PREVIOUS episode, so relaunch reopened it from 0:00 with no
// resume prompt. The save decision itself is unit-tested in
// packages/desktop-mpv-playback/tests/regression-progress-save-wrong-episode.test.ts;
// this file pins the engine wiring and the switch gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PendingStartTarget } from "../src/renderer/src/lib/pendingStartTarget";

const LOG = "[resume-wrong-episode]";
const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");

describe("next-episode switch never saves to the wrong episode (@bugfix @regression-proof issue #25)", () => {
  it("an episode switch on a live mpv gates saves until the new file loads", () => {
    const pending = new PendingStartTarget();
    // prepareEpisodeStart(0) while mpv still plays E(n).
    pending.armForReload(0);
    console.info(`${LOG} phase=switch loadInFlight=${pending.isLoadInFlight()} target=${pending.get()}`);
    expect(pending.isLoadInFlight()).toBe(true);
    expect(pending.get()).toBeNull();
    // mpv file-loaded for E(n+1).
    pending.loadLanded();
    expect(pending.isLoadInFlight()).toBe(false);
  });

  it("the poll drops a superseded tick and routes every save through decidePolledProgressSave", () => {
    const needles = [
      "if (cancelled) return;\n        const allowUiUpdates",
      "const saveDecision = decidePolledProgressSave({",
      "liveTarget: progressTargetRef.current,",
      "loadInFlight: pendingStart.isLoadInFlight(),",
      "if (isExternalActive(lifecycleRef.current)) pendingStart.armForReload(time);",
    ];
    for (const needle of needles) {
      console.info(`${LOG} phase=source needle=${JSON.stringify(needle)} present=${engine.includes(needle)}`);
      expect(engine.includes(needle)).toBe(true);
    }
    const saveIdx = engine.indexOf("void setProgress(media.id, pct, episodeId ?? null");
    const decisionIdx = engine.indexOf("const saveDecision = decidePolledProgressSave({");
    expect(decisionIdx).toBeGreaterThan(0);
    expect(saveIdx).toBeGreaterThan(decisionIdx);
  });
});
