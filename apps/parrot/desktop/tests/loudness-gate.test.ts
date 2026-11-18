/**
 * @test-id PARROT-DESKTOP-LOUDNESS-GATE-001
 * @level unit
 * @why PAR-UP-03 / PAR-PLAY-03 @bugfix: the renderer measures each song's loudness as soon as it shows, so during an
 *   import every song gave a loudness publish racing the import's own publish (a `version_conflict` and a replay per
 *   song in the hand try of #2032). While an import runs the measured values are held and kept in one publish at its end.
 * @covers apps/parrot/desktop/src/main/loudnessGate.ts
 */
import { describe, expect, it } from "vitest";
import type { ParrotMeasuredLoudness } from "../src/shared/ipc";
import { createLoudnessGate } from "../src/main/loudnessGate";

const log = (message: string, data?: unknown) => console.log(`[PARROT-DESKTOP-LOUDNESS-GATE-001] ${message}`, data === undefined ? "" : JSON.stringify(data));

const song = (trackId: string, gainDb: number): ParrotMeasuredLoudness => ({ trackId, gainDb, peak: 0.9 });

const setup = () => {
  const publishes: ParrotMeasuredLoudness[][] = [];
  const lines: string[] = [];
  const gate = createLoudnessGate({
    save: async (measured) => {
      publishes.push(measured);
      log("publish", measured);
      return "published";
    },
    heldResult: async () => "held",
    log: (line) => {
      lines.push(line);
      log(line);
    },
  });
  return { gate, publishes, lines };
};

describe("loudness gate @bugfix", () => {
  it("publishes at once when no import runs", async () => {
    const { gate, publishes } = setup();
    expect(await gate.save([song("paperboat", -3)])).toBe("published");
    expect(publishes).toEqual([[song("paperboat", -3)]]);
  });

  it("holds every song measured during an import and keeps them in one publish when it ends", async () => {
    const { gate, publishes, lines } = setup();
    gate.pause();
    expect(await gate.save([song("paperboat", -3)])).toBe("held");
    expect(await gate.save([song("one-step-closer", -4)])).toBe("held");
    // The same song measured again (another decode) keeps its latest value only.
    expect(await gate.save([song("paperboat", -2.5)])).toBe("held");
    log("publishes during the import", publishes.length);
    expect(publishes).toEqual([]);

    await gate.resume();
    log("publishes after the import", publishes);
    expect(publishes).toEqual([[song("paperboat", -2.5), song("one-step-closer", -4)]]);
    expect(lines.at(-1)).toContain("keeping the 2 held song(s)");

    // After the import, a new measure publishes at once again.
    expect(await gate.save([song("at-the-gate", -5)])).toBe("published");
    expect(publishes).toHaveLength(2);
  });

  it("publishes nothing at the import's end when nothing was measured", async () => {
    const { gate, publishes } = setup();
    gate.pause();
    await gate.resume();
    expect(publishes).toEqual([]);
  });
});
