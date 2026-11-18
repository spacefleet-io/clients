/**
 * @req MPV-AUDIO-01[badger-desktop]
 *
 * Frozen-audio notice in the OSC (resources/osc/sf.lua). The main process (mpvAudioStall) sends
 * `sf-audio-stall {"state":"stalled",...}` when the audio output stops taking sound and it dropped to no sound; the
 * OSC then shows a "Retry with sound" pill (clickable, Enter) with a line saying the audio device is not responding
 * and to check the headphones or sound output. The action sends `sf-audio-retry` back and hides the notice;
 * `{"state":"cleared"}` hides it too.
 *
 * Runs the REAL sf.lua under tests/lua/mp_mock.lua. Skips loudly when no Lua interpreter is on PATH; in CI
 * (SF_REQUIRE_MEDIA_BINARIES=1) a missing one fails the file.
 */
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TAG = "[sf-audio-stall-notice]";
const sfLua = fileURLToPath(new URL("../resources/osc/sf.lua", import.meta.url));
const driver = fileURLToPath(new URL("./lua/sf_audio_stall_scenario.lua", import.meta.url));

const LUA_CANDIDATES = ["luajit", "lua5.1", "lua5.2", "lua"];
const lua = LUA_CANDIDATES.find((bin) => spawnSync(bin, ["-v"]).status === 0) ?? null;
requireMediaBinary("a Lua interpreter (luajit, lua5.1, lua5.2 or lua)", lua !== null);
if (!lua) {
  console.warn(`${TAG} SKIP: no Lua interpreter on PATH (tried ${LUA_CANDIDATES.join(", ")})`);
} else {
  console.info(`${TAG} using ${lua}: ${spawnSync(lua, ["-v"]).stdout.toString().trim()} sf.lua=${sfLua}`);
}

type Checkpoint = { label: string; active: boolean; kind?: string; label_text?: string; overlay: string; retries: number };

const runScenario = (scenario: string) => {
  const proc = spawnSync(lua!, [driver, sfLua, scenario], { encoding: "utf8", timeout: 30_000 });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const resultLine = (proc.stdout ?? "").split("\n").find((line) => line.startsWith("RESULT "));
  if (proc.status !== 0 || !resultLine) {
    console.error(`${TAG} scenario=${scenario} exit=${proc.status} signal=${proc.signal}\n${log}`);
    throw new Error(`scenario ${scenario} failed (exit ${proc.status})`);
  }
  const relevant = log
    .split("\n")
    .filter((line) => /audio|pill|rror|warn/.test(line))
    .join("\n");
  console.info(`${TAG} scenario=${scenario}\n${relevant}`);
  const parsed = JSON.parse(resultLine.slice("RESULT ".length)) as { checkpoints: Checkpoint[]; pausedAfterEnter: boolean };
  const at = (label: string): Checkpoint => {
    const found = parsed.checkpoints.find((c) => c.label === label);
    if (!found) throw new Error(`${TAG} no checkpoint ${label}: ${JSON.stringify(parsed.checkpoints)}`);
    return found;
  };
  return { ...parsed, at };
};

describe.skipIf(!lua)("sf.lua frozen-audio notice (MPV-AUDIO-01)", () => {
  it("shows Retry with sound with the explanation, Enter retries and hides it, cleared hides it", () => {
    const r = runScenario("notice");
    expect(r.at("playing").active).toBe(false);

    const stalled = r.at("stalled");
    expect(stalled.active).toBe(true);
    expect(stalled.kind).toBe("audio_retry");
    expect(stalled.label_text).toBe("Retry with sound");
    expect(stalled.overlay).toContain("Retry with sound");
    expect(stalled.overlay).toContain("Audio device not responding");
    expect(stalled.overlay).toContain("headphones or sound output");

    expect(r.at("playing silent").kind, "stays while the video plays without sound").toBe("audio_retry");

    const afterEnter = r.at("after Enter");
    expect(afterEnter.retries).toBe(1);
    expect(afterEnter.kind).not.toBe("audio_retry");
    expect(afterEnter.overlay).toContain("Retrying with sound");
    expect(r.pausedAfterEnter, "Enter retries, it does not toggle pause").toBe(false);

    expect(r.at("after retry notice").overlay).not.toContain("Retry");

    expect(r.at("stalled again").kind).toBe("audio_retry");
    const cleared = r.at("cleared");
    expect(cleared.active).toBe(false);
    expect(cleared.overlay).not.toContain("Audio device");
    expect(cleared.retries, "a cleared from the app sends no retry").toBe(1);
  });
});

/**
 * @req MPV-AUDIO-02[badger-desktop]
 * @bugfix pc-no-sound-output-silently-dropped
 *
 * No sound output could be opened: `sf-audio-stall {"state":"stalled","reason":"no-output"}` shows the same pill with
 * its own explanation, and the whole notice reads in the UI language sent on `sf-labels-json`.
 */
describe.skipIf(!lua)("sf.lua no-sound-output notice, translated (MPV-AUDIO-02)", () => {
  it("shows the no-output explanation and the retry in the UI language", () => {
    const r = runScenario("no-output-translated");
    const shown = r.at("no output");
    expect(shown.kind).toBe("audio_retry");
    expect(shown.label_text).toBe("Réessayer avec le son");
    expect(shown.overlay).toContain("Aucune sortie audio n'a pu être ouverte.");
    expect(shown.overlay).toContain("Sortie audio : auto (system default output)");
    expect(shown.overlay).not.toContain("Retry with sound");
    expect(shown.overlay).not.toContain("Audio device not responding");

    const afterEnter = r.at("after Enter");
    expect(afterEnter.retries).toBe(1);
    expect(afterEnter.overlay).toContain("Nouvel essai avec le son");

    const frozen = r.at("frozen");
    expect(frozen.overlay).toContain("Le périphérique audio ne répond pas.");
    expect(frozen.overlay).not.toContain("Aucune sortie audio");
  });
});
