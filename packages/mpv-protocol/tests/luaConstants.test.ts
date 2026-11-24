import { describe, expect, it } from "vitest";

import { LUA_CHANNELS, LUA_CHANNEL_REGISTRATIONS } from "../src/luaConstants";

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real constant-shape assertion. Dumps the full constant maps so a
// drifted channel name / file pairing is immediately visible.
const dumpLuaConstantsSnapshot = (label: string, extra?: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-protocol-luaConstants:${label}] snapshot ===`);
    console.error(`LUA_CHANNELS=${JSON.stringify(LUA_CHANNELS, null, 2)}`);
    console.error(
      `LUA_CHANNEL_REGISTRATIONS=${JSON.stringify(LUA_CHANNEL_REGISTRATIONS, null, 2)}`,
    );
    if (extra) console.error(`context=${JSON.stringify(extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("LUA_CHANNELS constants", () => {
  it("exports the ten expected channel names", () => {
    console.info(
      `[mpv-protocol-luaConstants:channel-names] LUA_CHANNELS keys=${JSON.stringify(Object.keys(LUA_CHANNELS))}`,
    );
    const expected = {
      SUBTITLES_JSON: "sf-subtitles-json",
      CHAPTERS_JSON: "sf-chapters-json",
      AUDIO_JSON: "sf-audio-json",
      LABELS_JSON: "sf-labels-json",
      PLAYBACK_JSON: "sf-playback-json",
      PREVIEW_SHEETS: "sf-preview-sheets",
      PREVIEW_PICTURE: "sf-preview-picture",
      AUDIO_STALL: "sf-audio-stall",
      SUBTITLE_FETCH_JSON: "sf-subtitle-fetch-json",
      SKIP_EDIT_JSON: "sf-skip-edit-json",
    };
    try {
      expect(LUA_CHANNELS).toEqual(expected);
    } catch (err) {
      dumpLuaConstantsSnapshot("channel-names", { expected });
      throw err;
    }
  });

  it("pairs every channel with its registering Lua file", () => {
    const channels = LUA_CHANNEL_REGISTRATIONS.map((entry) => entry.channel);
    const audioEntry = LUA_CHANNEL_REGISTRATIONS.find(
      (entry) => entry.channel === "sf-audio-json",
    );
    console.info(
      `[mpv-protocol-luaConstants:channel-file-pairs] registrations=${LUA_CHANNEL_REGISTRATIONS.length} channels=${JSON.stringify(channels)} audioFile=${JSON.stringify(audioEntry?.file)}`,
    );
    try {
      expect(LUA_CHANNEL_REGISTRATIONS).toHaveLength(11);
      expect(channels.sort()).toEqual(
        [
          "sf-audio-json",
          "sf-audio-stall",
          "sf-chapters-json",
          "sf-labels-json",
          "sf-labels-json",
          "sf-playback-json",
          "sf-preview-picture",
          "sf-preview-sheets",
          "sf-skip-edit-json",
          "sf-subtitle-fetch-json",
          "sf-subtitles-json",
        ].sort(),
      );
      expect(audioEntry?.file).toBe("sf-select.lua");
      expect(
        LUA_CHANNEL_REGISTRATIONS.filter((entry) => entry.channel === "sf-labels-json").map((entry) => entry.file).sort(),
        "sf-select.lua reads the menu prompts, sf.lua the audio notice text (MPV-AUDIO-02)",
      ).toEqual(["sf-select.lua", "sf.lua"]);
    } catch (err) {
      dumpLuaConstantsSnapshot("channel-file-pairs", {
        channels,
        audioEntryFile: audioEntry?.file,
      });
      throw err;
    }
  });
});
