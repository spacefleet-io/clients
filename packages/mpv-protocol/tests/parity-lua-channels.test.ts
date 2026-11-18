/**
 * Parity test: every channel name declared in `LUA_CHANNELS` MUST appear
 * as the first argument of an `mp.register_script_message(...)` call in
 * the corresponding Lua file.
 *
 * Catches JS-side drift — if someone renames a channel in `luaConstants.ts`
 * but forgets to rename the handler registration in `sf.lua` /
 * `sf-select.lua`, the renderer's `script-message` lands on a handler that
 * doesn't exist and mpv silently drops the payload. Locking the assertion
 * at CI time means the rename never makes it past the local test gate.
 *
 * Sister assertion: every Lua registration in `sf.lua` / `sf-select.lua`
 * for a channel name beginning `sf-` MUST also appear in `LUA_CHANNELS`.
 * Without it, the Lua side could grow a private channel that the JS side
 * never validates — drift in the other direction.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LUA_CHANNELS,
  LUA_CHANNEL_REGISTRATIONS,
  type LuaChannelName,
} from "../src/luaConstants";

const here = resolve(fileURLToPath(import.meta.url), "..");
const LUA_FILES = {
  "sf.lua": resolve(here, "..", "..", "mpv", "resources", "osc", "sf.lua"),
  "sf-select.lua": resolve(here, "..", "..", "mpv", "resources", "osc", "sf-select.lua"),
  "tog4in1/tog4in1.lua": resolve(here, "..", "..", "mpv", "resources", "osc", "tog4in1", "tog4in1.lua"),
} as const;

const REGISTER_REGEX = /mp\.register_script_message\s*\(\s*"([^"]+)"/g;

const readLua = (file: keyof typeof LUA_FILES): string =>
  readFileSync(LUA_FILES[file], "utf8");

const findRegistrationsInFile = (file: keyof typeof LUA_FILES): string[] => {
  const source = readLua(file);
  const channels: string[] = [];
  for (const match of source.matchAll(REGISTER_REGEX)) {
    channels.push(match[1]);
  }
  return channels;
};

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real parity assertion that triggered it. Re-reads the Lua files so
// the snapshot reflects exactly what the matcher saw on disk.
const dumpParitySnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-protocol-parity-lua-channels:${label}] snapshot ===`);
    console.error(`LUA_CHANNELS=${JSON.stringify(LUA_CHANNELS, null, 2)}`);
    console.error(
      `LUA_CHANNEL_REGISTRATIONS=${JSON.stringify(LUA_CHANNEL_REGISTRATIONS, null, 2)}`,
    );
    for (const file of Object.keys(LUA_FILES) as (keyof typeof LUA_FILES)[]) {
      console.error(
        `registrations in ${file}=${JSON.stringify(findRegistrationsInFile(file))}`,
      );
    }
    console.error(`context=${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("parity: LUA_CHANNELS ↔ mp.register_script_message in sf.lua / sf-select.lua", () => {
  it("every LUA_CHANNELS value is registered in the expected Lua file", () => {
    console.info(
      `[mpv-protocol-parity-lua-channels:js-to-lua] checking ${LUA_CHANNEL_REGISTRATIONS.length} declared channels are registered in their Lua files`,
    );
    for (const entry of LUA_CHANNEL_REGISTRATIONS) {
      const registrations = findRegistrationsInFile(entry.file);
      console.info(
        `[mpv-protocol-parity-lua-channels:js-to-lua] channel=${entry.channel} file=${entry.file} present=${registrations.includes(entry.channel)}`,
      );
      if (!registrations.includes(entry.channel)) {
        dumpParitySnapshot("js-to-lua", {
          missingChannel: entry.channel,
          expectedFile: entry.file,
          registrationsInFile: registrations,
        });
      }
      expect(
        registrations,
        `expected ${entry.channel} to be registered via mp.register_script_message in ${entry.file}`,
      ).toContain(entry.channel);
    }
  });

  // Payload-less control / E2E script-messages that are intentionally NOT JSON
  // envelope channels: they carry no validated payload, have no Zod schema, and
  // are deliberately absent from LUA_CHANNELS (which is the envelope registry).
  // The envelope-parity rule below therefore does not apply to them.
  //   - sf-skip-confirm: E2E hook that fires the skip pill without key synthesis
  //     (production triggers it via the ENTER key bindings, not a payload).
  //   - sf-e2e-pill: E2E hook (ultimate suite) that replies with the pill rect
  //     on sf-e2e-pill-json; takes no payload.
  //   - sf-pill-mouse: tog4in1 forwards MBTN_LEFT "down"/"up" that land in the
  //     pill rect (P9, #25); a bare event-name string, not a JSON envelope.
  //   - sf-bindings-query: tog4in1 asks sf.lua to (re)send sf-bindings-ready
  //     (#25 input-section handshake, Lua to Lua); no payload.
  //   - sf-episode-nav: tog4in1's centre episode buttons tell sf.lua
  //     "previous"/"next" (PLAY-OVL-03, Lua to Lua); a bare word, not a JSON envelope.
  const NON_ENVELOPE_SF_REGISTRATIONS = new Set(["sf-skip-confirm", "sf-e2e-pill", "sf-pill-mouse", "sf-bindings-query", "sf-episode-nav"]);

  it("every Lua sf-* envelope registration has a matching LUA_CHANNELS entry", () => {
    const knownChannels = new Set<LuaChannelName>(
      Object.values(LUA_CHANNELS) as LuaChannelName[],
    );
    const luaSfRegistrations = [
      ...findRegistrationsInFile("sf.lua"),
      ...findRegistrationsInFile("sf-select.lua"),
    ].filter((name) => name.startsWith("sf-") && !NON_ENVELOPE_SF_REGISTRATIONS.has(name));
    console.info(
      `[mpv-protocol-parity-lua-channels:lua-to-js] checking ${luaSfRegistrations.length} sf-* envelope registrations are declared in LUA_CHANNELS`,
    );
    for (const name of luaSfRegistrations) {
      const known = knownChannels.has(name as LuaChannelName);
      console.info(`[mpv-protocol-parity-lua-channels:lua-to-js] registration=${name} declared=${known}`);
      if (!known) {
        dumpParitySnapshot("lua-to-js", {
          undeclaredRegistration: name,
          knownChannels: [...knownChannels],
          luaSfRegistrations,
        });
      }
      expect(
        known,
        `Lua registers script-message "${name}" but it is not declared in LUA_CHANNELS`,
      ).toBe(true);
    }
  });

  it("LUA_CHANNEL_REGISTRATIONS covers every LUA_CHANNELS value exactly once", () => {
    const declared = new Set(Object.values(LUA_CHANNELS));
    const covered = new Set(LUA_CHANNEL_REGISTRATIONS.map((entry) => entry.channel));
    console.info(
      `[mpv-protocol-parity-lua-channels:coverage] declared.size=${declared.size} covered.size=${covered.size}`,
    );
    if (covered.size !== declared.size) {
      dumpParitySnapshot("coverage", {
        declared: [...declared],
        covered: [...covered],
      });
    }
    expect(covered.size).toBe(declared.size);
    for (const channel of declared) {
      if (!covered.has(channel as LuaChannelName)) {
        dumpParitySnapshot("coverage", {
          uncoveredChannel: channel,
          declared: [...declared],
          covered: [...covered],
        });
      }
      expect(covered.has(channel as LuaChannelName)).toBe(true);
    }
  });
});
