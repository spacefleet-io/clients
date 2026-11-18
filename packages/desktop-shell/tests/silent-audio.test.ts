// @req REL-ENV-36 @bugfix @regression-proof
/**
 * A Parrot AppImage started by hand with SF_SILENT=1, `--mute-audio` and PULSE_SINK=null still opened 2 unmuted
 * PipeWire streams that played on the machine's speakers (2026-11-13). Under SF_SILENT the app itself now asks Chromium for
 * no audio output, whoever launched it; the user's own run is untouched (agent reading, approved by Main (2026-11-13)).
 */
import { describe, expect, it } from "vitest";
import { applySilentAudio, isSilentEnv } from "../src/main-shell";

const fakeCommandLine = () => {
  const switches: string[] = [];
  return { switches, appendSwitch: (name: string) => void switches.push(name) };
};

describe("applySilentAudio", () => {
  it("SF_SILENT=1: Chromium gets no audio output and stays muted", () => {
    const commandLine = fakeCommandLine();
    const applied = applySilentAudio(commandLine, { SF_SILENT: "1" });
    console.log(`[silent-audio] SF_SILENT=1 -> ${JSON.stringify(commandLine.switches)}`);
    expect(commandLine.switches).toEqual(["mute-audio", "disable-audio-output"]);
    expect(applied).toEqual(["mute-audio", "disable-audio-output"]);
  });

  it("the user's own run (SF_SILENT unset, empty, 0, false, no) appends nothing", () => {
    for (const value of [undefined, "", " ", "0", "false", "NO"]) {
      const commandLine = fakeCommandLine();
      const applied = applySilentAudio(commandLine, { SF_SILENT: value });
      console.log(`[silent-audio] SF_SILENT=${JSON.stringify(value)} -> ${JSON.stringify(commandLine.switches)}`);
      expect(commandLine.switches).toEqual([]);
      expect(applied).toEqual([]);
      expect(isSilentEnv({ SF_SILENT: value })).toBe(false);
    }
  });

  it("any other SF_SILENT value counts as silent, as for mpv", () => {
    for (const value of ["1", "yes", "true", " 1 "]) expect(isSilentEnv({ SF_SILENT: value })).toBe(true);
  });
});
