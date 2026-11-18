/**
 * @bugfix sf-skip-countdown-wall-clock
 * @regression-proof
 *
 * Ultimate-stress finding P22 (#25): the skip-intro / skip-credits / next-
 * episode pill counted its 5 s auto-fire grace on mpv's WALL clock
 * (`mp.get_time()`), so on a stuttering PC (playback well under 1x) the pill
 * fired after ~1.5 s of media and already read "0:01" at media 10:31.5, and
 * pausing during the pill then resuming fired the skip immediately.
 *
 * This suite runs the REAL resources/osc/sf.lua under a mocked mp runtime
 * (tests/lua/mp_mock.lua) in a plain LuaJIT / Lua 5.1 interpreter, with a
 * simulated wall clock and a media clock (time-pos) that only advances while
 * unpaused, at the configured speed. Pre-fix:
 *   - slow (0.3x): fires at media ~61.5 instead of 65 (marker start 60 + 5)
 *   - pause: fires at media ~62.1 the moment playback resumes
 *   - next-episode: "Opening next episode" is an unboxed osd_message
 *
 * Skips loudly when no Lua interpreter is on PATH (CI image has none; the
 * @space/mpv suite runs in local `test:core`).
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-skip-countdown]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_countdown_scenario.lua", import.meta.url));

// mpv embeds LuaJIT (or Lua 5.1/5.2), so prefer those dialects.
const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) {
  console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);
} else {
  console.info(`${TAG} using ${lua}: ${spawnSync(lua, ["-v"]).stdout.toString().trim()} sf.lua=${sfLua}`);
}

type Fire = { media: number; wall: number; kind: string };
type Checkpoint = {
  label: string;
  wall: number;
  media: number;
  paused: boolean;
  fires: number;
  countdown?: number;
  active?: boolean;
  kind?: string;
  overlay: string;
};
type ScenarioResult = {
  scenario: string;
  fires: Fire[];
  checkpoints: Checkpoint[];
  openingOsdMessages?: number;
  nextEpisodeRequests?: number;
  nextEpisodeRequestsBeforeClick?: number;
  log: string;
};

// The mock's JSON encoder writes an empty Lua table as {}; normalise to arrays.
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const runScenario = (scenario: string): ScenarioResult => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status} signal=${proc.signal}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const parsed = JSON.parse(resultLine.slice("RESULT ".length)) as Record<string, unknown>;
  const result: ScenarioResult = {
    scenario,
    fires: asArray<Fire>(parsed.fires),
    checkpoints: asArray<Checkpoint>(parsed.checkpoints),
    openingOsdMessages: parsed.openingOsdMessages as number | undefined,
    nextEpisodeRequests: parsed.nextEpisodeRequests as number | undefined,
    nextEpisodeRequestsBeforeClick: parsed.nextEpisodeRequestsBeforeClick as number | undefined,
    log,
  };
  // Generous logging: the sf-skip/sf-pill lines plus every checkpoint.
  const relevant = log
    .split("\n")
    .filter((line) => /sf-skip|sf-pill|sf-eof|checkpoint|osd_message|seek|rror/.test(line))
    .join("\n");
  console.info(`${TAG} scenario=${scenario} fires=${JSON.stringify(result.fires)}\n${relevant}`);
  return result;
};

const checkpoint = (result: ScenarioResult, label: string): Checkpoint => {
  const found = result.checkpoints.find((c) => c.label === label);
  if (!found) {
    console.error(`${TAG} missing checkpoint ${label}\n${result.log}`);
    throw new Error(`missing checkpoint ${label}`);
  }
  return found;
};

// Fire must land at media marker.start + 5 s: no earlier, and within two
// frames + one 250 ms countdown tick of media later.
const FIRE_SLACK_MEDIA_S = 0.35;

describe.skipIf(!lua)("sf.lua auto-skip countdown runs on media time (P22)", () => {
  it("fires at media start+5 s at normal speed", () => {
    const result = runScenario("normal");
    expect(result.fires).toHaveLength(1);
    expect(result.fires[0]!.kind).toBe("skip_intro");
    expect(result.fires[0]!.media).toBeGreaterThanOrEqual(65 - 1e-6);
    expect(result.fires[0]!.media).toBeLessThanOrEqual(65 + FIRE_SLACK_MEDIA_S);
  });

  it("at 0.3x playback fires at media start+5 s, not after 5 s of wall clock", () => {
    const result = runScenario("slow");
    expect(result.fires, "exactly one auto-fire").toHaveLength(1);
    const fire = result.fires[0]!;
    expect(fire.media, `fired at media ${fire.media}, expected >= 65 (start 60 + 5)`).toBeGreaterThanOrEqual(65 - 1e-6);
    expect(fire.media).toBeLessThanOrEqual(65 + FIRE_SLACK_MEDIA_S);
    // 5 media seconds at 0.3x take ~16.7 s of wall clock after arming (wall 3.33).
    expect(fire.wall).toBeGreaterThan(3.33 + 16);
  });

  it("pause freezes the countdown and never fires; resume fires at media start+5 s", () => {
    const result = runScenario("pause");
    const before = checkpoint(result, "before-pause");
    const paused = checkpoint(result, "after-60s-paused");
    expect(before.fires).toBe(0);
    expect(paused.paused).toBe(true);
    expect(paused.fires, "no auto-fire during 60 s of pause").toBe(0);
    expect(paused.active).toBe(true);
    // Countdown frozen at the pre-pause value (~3 s left at media 62).
    expect(paused.countdown).toBeCloseTo(before.countdown!, 1);
    expect(paused.countdown!).toBeGreaterThan(2.5);
    expect(paused.countdown!).toBeLessThanOrEqual(3.05);
    expect(result.fires).toHaveLength(1);
    const fire = result.fires[0]!;
    expect(fire.media, `fired at media ${fire.media} right after resume`).toBeGreaterThanOrEqual(65 - 1e-6);
    expect(fire.media).toBeLessThanOrEqual(65 + FIRE_SLACK_MEDIA_S);
  });

  it("next episode fires at credits start+5 s at 0.5x and shows a boxed 'Opening next episode' notice", () => {
    const result = runScenario("next-episode");
    expect(result.fires).toHaveLength(1);
    const fire = result.fires[0]!;
    expect(fire.kind).toBe("next_episode");
    expect(fire.media).toBeGreaterThanOrEqual(605 - 1e-6);
    expect(fire.media).toBeLessThanOrEqual(605 + FIRE_SLACK_MEDIA_S);

    const shown = checkpoint(result, "notice-shown");
    expect(shown.overlay).toContain("Opening next episode");
    // Same box as the pills (ASS vector rectangle, pill fill, 2 px border,
    // same font size), with a neutral outline: amber marks a clickable action,
    // and the ultimate harness's pill detector keys on it.
    expect(shown.overlay).toMatch(/\\p1\\an7\\pos\(0,0\)\\1c&H1F2430&\\3c&HC8CCD4&\\1a&H22&\\bord2/);
    expect(shown.overlay).toContain("\\fs26");
    expect(result.openingOsdMessages, "no unboxed osd_message for the notice").toBe(0);

    const expired = checkpoint(result, "notice-expired");
    expect(expired.overlay).not.toContain("Opening next episode");
  });
});

/**
 * @bugfix sf-premature-eof-opens-next-episode
 * @regression-proof
 *
 * Ultimate-stress finding P6 (#25): a partial HLS segment at media 145.9 of a
 * 720 s episode made mpv report EOF; with keep-open it seeks to the last frame,
 * so time-pos jumps 145.9 -> 720. The end-of-media fallback in the 0.1 s
 * periodic timer only checked `duration - time_pos <= 0.35` and opened the
 * next episode at minute 2 (shard-2 mpv-12 log :2954-2998). Only a natural
 * approach to the real end may auto-advance.
 */
describe.skipIf(!lua)("sf.lua end-of-media auto-advance only on a genuine end (P6)", () => {
  it.each(["eof-premature", "eof-premature-autoplay"])(
    "%s: a time-pos jump to the end at a premature EOF opens no next episode",
    (scenario) => {
      const result = runScenario(scenario);
      const before = checkpoint(result, "before-eof");
      const after = checkpoint(result, "after-eof");
      console.info(`${TAG} ${scenario} before=${JSON.stringify(before)} after=${JSON.stringify(after)} requests=${result.nextEpisodeRequests}`);
      expect(before.media).toBeLessThan(150);
      expect(after.media).toBe(720);
      expect(result.nextEpisodeRequests, "next-episode requests after a premature EOF").toBe(0);
      expect(result.fires).toHaveLength(0);
    },
  );

  it("eof-natural: playing through to the real end still opens the next episode once", () => {
    const result = runScenario("eof-natural");
    expect(result.nextEpisodeRequests).toBe(1);
  });

  it("eof-seek-in-credits: a user seek past the end while the next-episode pill is up still opens it once", () => {
    const result = runScenario("eof-seek-in-credits");
    const before = checkpoint(result, "before-seek");
    console.info(`${TAG} eof-seek-in-credits before=${JSON.stringify(before)} requests=${result.nextEpisodeRequests}`);
    expect(before.kind).toBe("next_episode");
    expect(result.nextEpisodeRequests).toBe(1);
  });
});

/**
 * @bugfix sf-credits-pill-ignores-autoplay-off
 * @regression-proof
 *
 * PLAY-NEXT-01: with "Autoplay next episode" off, the credits-marker "Next
 * episode" pill took its auto-fire from `marker.autoSkip` alone (the credits
 * auto-skip setting), so the next episode still started by itself. Observed
 * live on staging (mpv 0.41, Xvfb, credits 170-195 autoSkip=true,
 * autoplayNextEpisode=false): `[sf-skip] firing kind=next_episode` at credits
 * start+5 s. The end-of-media fallback already ANDs both settings.
 */
describe.skipIf(!lua)("sf.lua credits pill obeys autoplay next episode @req PLAY-NEXT-01[badger-desktop]", () => {
  it("autoplay off: the credits 'Next episode' pill never starts the next episode by itself, a click still does", () => {
    const result = runScenario("credits-autoplay-off");
    const waited = checkpoint(result, "credits+17s");
    console.info(`${TAG} credits-autoplay-off waited=${JSON.stringify(waited)} before-click=${result.nextEpisodeRequestsBeforeClick} after=${result.nextEpisodeRequests} fires=${JSON.stringify(result.fires)}`);
    expect(waited.active, "credits pill shown").toBe(true);
    expect(waited.kind).toBe("next_episode");
    expect(waited.countdown, "no countdown with autoplay off").toBeUndefined();
    expect(result.fires, "no auto-fire").toHaveLength(0);
    expect(result.nextEpisodeRequestsBeforeClick, "next-episode requests before the click").toBe(0);
    expect(result.nextEpisodeRequests, "the click opens the next episode once").toBe(1);
  });

  it.each([
    ["eof-natural", 1],
    ["eof-natural-autoplay-off", 0],
  ] as const)("%s: at the real end of an episode without credits marker the next one starts by itself only with autoplay on", (scenario, expected) => {
    const result = runScenario(scenario);
    const after = checkpoint(result, "after-eof");
    console.info(`${TAG} ${scenario} after=${JSON.stringify(after)} requests=${result.nextEpisodeRequests} fires=${JSON.stringify(result.fires)}`);
    expect(after.media).toBe(720);
    expect(result.nextEpisodeRequests, "next-episode requests at the end").toBe(expected);
  });

  it("control: on a last episode 'Skip credits' still follows the credits auto-skip with autoplay off", () => {
    const result = runScenario("credits-last-episode-autoplay-off");
    console.info(`${TAG} credits-last-episode-autoplay-off fires=${JSON.stringify(result.fires)} requests=${result.nextEpisodeRequests}`);
    expect(result.fires).toHaveLength(1);
    expect(result.fires[0]!.kind).toBe("skip_credits");
    expect(result.fires[0]!.media).toBeGreaterThanOrEqual(605 - 1e-6);
    expect(result.nextEpisodeRequests).toBe(0);
  });
});
