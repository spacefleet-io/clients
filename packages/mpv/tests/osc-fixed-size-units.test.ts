/**
 * @req MPV-OSC-05[badger-desktop]
 * @bugfix player-ui-shrinks-with-window
 * @regression-proof
 *
 * MPV-OSC-05 unit checks, no mpv: Chris (2026-11-13, Mac and Windows) saw the
 * player's text and buttons shrink with the window "as though it was part of
 * the video". Runs the REAL code under a Lua interpreter
 * (tests/lua/osc_fixed_size_scenario.lua):
 *   - tog4in1.lua's sf_fit_controls for windows from 1920x1080 down to
 *     240x135 points at display scales 1 / 1.25 / 1.5 / 2: what is left out
 *     depends on the window's size in points only, never overlaps, follows
 *     the priority order, and a full-size window keeps every control;
 *   - sf.lua's subtitle / message scale: a fixed size times the display scale,
 *     the same at every window size.
 * The real-mpv pixel proof is osc-fixed-size.test.ts (Xvfb).
 *
 * Skips loudly when no Lua interpreter is on PATH.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireMediaBinary } from "@space/media-deps";

const TAG = "[osc-fixed-size-units]";
const tog4in1 = fileURLToPath(new URL("../resources/osc/tog4in1/tog4in1.lua", import.meta.url));
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/osc_fixed_size_scenario.lua", import.meta.url));
const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);

type FitCase = {
  window: string;
  hidpi: number;
  chapters: boolean;
  skip: boolean;
  w: number;
  h: number;
  shown: Record<string, boolean>;
  timecodes: boolean;
  band: boolean;
  title: boolean;
  centre: boolean;
  centreY: number;
  episodes: boolean;
};
type Fit = {
  margin: number;
  chip: number;
  gap: number;
  volume: number;
  backRight: number;
  bandBottom: number;
  seekRowTop: number;
  play: number;
  episodeHalfW: number;
};
type FitResult = { cases: FitCase[]; fit: Fit; drop_order: string[]; right_group: string[] };
type ScaleResult = { cases: { window: string; hidpi: number; codec: string; sub_scale: number; osd_scale: number }[] };

const run = <T>(scenario: string, script: string): T => {
  const proc = spawnSync(lua!, [driver, scenario, script], { encoding: "utf8", timeout: 30_000 });
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status}\n${proc.stdout ?? ""}${proc.stderr ?? ""}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  return JSON.parse(resultLine.slice("RESULT ".length)) as T;
};

const ALL_BOTTOM = ["volume", "volume_slider", "cy_sub", "cy_audio", "cy_qual", "tog_fs"];

describe.skipIf(!lua)("MPV-OSC-05: tog4in1 leaves controls out instead of shrinking them", () => {
  const result = lua ? run<FitResult>("fit", tog4in1) : null;
  const cases = result?.cases ?? [];
  const f = result?.fit;

  it("depends on the window's size in points only, not on the display scale", () => {
    for (const c of cases) {
      const same = cases.find((o) => o.window === c.window && o.chapters === c.chapters && o.skip === c.skip && o.hidpi === 1)!;
      const { hidpi: _a, ...mine } = c;
      const { hidpi: _b, ...base } = same;
      expect(mine, `${c.window} at display scale ${c.hidpi}`).toEqual(base);
    }
  });

  it("keeps every control in a window of 960x540 points or more", () => {
    for (const c of cases.filter((o) => ["1920x1080", "1600x900", "1280x720", "960x540"].includes(o.window))) {
      const label = `${c.window}@${c.hidpi} chapters=${c.chapters} skip=${c.skip}`;
      for (const name of ALL_BOTTOM) expect(c.shown[name], `${label}: ${name}`).toBe(true);
      expect(c.shown.chapters, `${label}: chapters`).toBe(c.chapters);
      expect(c.shown.cy_skip, `${label}: skip button @req PLAY-SKIP-10[badger-desktop]`).toBe(c.skip);
      expect([c.timecodes, c.band, c.title, c.centre, c.episodes], label).toEqual([true, true, true, true, true]);
    }
  });

  it("keeps the 640x360 player whole but the volume track (with chapters)", () => {
    const small = cases.filter((o) => o.window === "640x360" && o.hidpi === 1 && !o.skip);
    console.info(`${TAG} 640x360: ${JSON.stringify(small)}`);
    const plain = small.find((o) => !o.chapters)!;
    const chaptered = small.find((o) => o.chapters)!;
    for (const name of ALL_BOTTOM) expect(plain.shown[name], `no chapters: ${name}`).toBe(true);
    expect(chaptered.shown.volume_slider, "with chapters the volume track goes first").toBe(false);
    expect(chaptered.shown.chapters).toBe(true);
    for (const c of small) expect([c.timecodes, c.band, c.title, c.centre]).toEqual([true, true, true, true]);
  });

  it("never overlaps: bottom row, seek row, centre cluster and top band", () => {
    for (const c of cases) {
      const label = `${c.window}@${c.hidpi} chapters=${c.chapters} skip=${c.skip}`;
      expect(c.shown.tog_fs, `${label}: fullscreen always stays`).toBe(true);
      const left = c.shown.volume ? f!.margin + f!.chip + (c.shown.volume_slider ? f!.volume : 0) : f!.margin - f!.gap;
      const n = result!.right_group.filter((name) => c.shown[name]).length;
      const right = c.w - f!.margin - n * f!.chip - (n - 1) * f!.gap;
      expect(right - left, `${label}: bottom row gap`).toBeGreaterThanOrEqual(f!.gap);
      if (c.centre) {
        const seekRowTop = c.h - f!.seekRowTop;
        expect(c.centreY + f!.play / 2, `${label}: play chip above the seek row`).toBeLessThanOrEqual(seekRowTop - f!.gap);
        expect(c.centreY - f!.play / 2, `${label}: play chip inside the window`).toBeGreaterThanOrEqual(f!.gap);
        if (c.title) expect(c.centreY - f!.play / 2, `${label}: play chip below the title`).toBeGreaterThanOrEqual(f!.bandBottom + f!.gap);
        else if (c.band) expect(c.w / 2 - f!.play / 2, `${label}: play chip right of the back chip`).toBeGreaterThanOrEqual(f!.backRight + f!.gap);
      }
      if (c.band) expect(c.h - f!.seekRowTop, `${label}: seek row below the band`).toBeGreaterThanOrEqual(f!.bandBottom + f!.gap);
    }
  });

  it("leaves bottom-row controls out in priority order", () => {
    for (const c of cases) {
      const order = result!.drop_order.filter((name) => (name !== "chapters" || c.chapters) && (name !== "cy_skip" || c.skip));
      const firstKept = order.findIndex((name) => c.shown[name]);
      const kept = firstKept < 0 ? [] : order.slice(firstKept);
      for (const name of kept) expect(c.shown[name], `${c.window}@${c.hidpi} chapters=${c.chapters} skip=${c.skip}: ${name} kept after a higher-priority one went`).toBe(true);
    }
  });
});

describe.skipIf(!lua)("MPV-OSC-05: sf.lua sizes subtitles and messages in screen points", () => {
  it("text subtitles: sub-scale 1.5 times the display scale; ASS / SSA keep their authored size; osd-scale 1 times the display scale; at every window size", () => {
    const { cases } = run<ScaleResult>("text-scale", sfLua);
    console.info(`${TAG} text scale: ${JSON.stringify(cases.filter((c) => c.window === "640x360"))}`);
    expect(new Set(cases.map((c) => c.codec))).toEqual(new Set(["subrip", "webvtt", "ass", "ssa"]));
    for (const c of cases) {
      const label = `${c.codec} ${c.window}@${c.hidpi}`;
      const authored = c.codec === "ass" || c.codec === "ssa";
      expect(c.sub_scale, `${label}: sub-scale`).toBeCloseTo(authored ? 1 : 1.5 * c.hidpi, 6);
      expect(c.osd_scale, `${label}: osd-scale`).toBeCloseTo(c.hidpi, 6);
    }
  });
});
