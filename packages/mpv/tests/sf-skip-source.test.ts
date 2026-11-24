import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sfLuaUrl = new URL("../resources/osc/sf.lua", import.meta.url);
const source = readFileSync(sfLuaUrl, "utf8");
console.info(
  `[sf-skip-source:setup] loaded sf.lua from ${sfLuaUrl.pathname} (${source.length} chars, ${source.split("\n").length} lines)`,
);

// On a missing-needle failure, dump which contract markers were absent + a few
// lines of context around the first present marker, so a drift in sf.lua is
// diagnosable from CI logs alone (per "Tests log generously"). Wrapped in
// try/catch so a dump fault can't mask the real assertion failure.
const dumpSkipSourceSnapshot = (label: string, needles: string[]) => {
  try {
    const missing = needles.filter((needle) => !source.includes(needle));
    const present = needles.filter((needle) => source.includes(needle));
    console.error(`=== [sf-skip-source:${label}] snapshot ===`);
    console.error(`needles.total=${needles.length} present=${present.length} missing=${missing.length}`);
    console.error(`missing needles:\n${JSON.stringify(missing, null, 2)}`);
    console.error(`present needles:\n${JSON.stringify(present, null, 2)}`);
    if (present.length > 0) {
      const anchorIdx = source.indexOf(present[0]);
      const lineNo = source.slice(0, anchorIdx).split("\n").length;
      console.error(`anchor "${present[0]}" first appears around line ${lineNo}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const assertContainsAll = (label: string, needles: string[]) => {
  console.info(`[sf-skip-source:${label}] asserting ${needles.length} contract needles present`);
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    dumpSkipSourceSnapshot(label, needles);
  }
  for (const needle of needles) {
    expect(source).toContain(needle);
  }
};

describe("sf.lua skip and up-next contract", () => {
  it("accepts playback metadata and exposes a top-left pill", () => {
    assertContainsAll("pill-overlay", [
      'mp.register_script_message("sf-playback-json", apply_playback_json)',
      "local left = PILL_MARGIN_X",
      "local top = PILL_MARGIN_Y",
      'osd = mp.create_osd_overlay("ass-events")',
    ]);
  });

  it("uses the pill for skip intro, skip credits, and next episode actions", () => {
    assertContainsAll("pill-actions", [
      'label = "Skip intro"',
      'label = "Skip credits"',
      'label = "Next episode"',
      'write_next_episode_action()',
    ]);
  });

  it("routes Enter and mouse clicks through the active pill action instead of always toggling pause", () => {
    assertContainsAll("input-routing", [
      'if not trigger_active_action() then',
      'mp.add_forced_key_binding("MBTN_LEFT", "sf-pill-click", handle_pill_mouse, { complex = true })',
      'mp.register_script_message("sf-pill-mouse", function(what)',
      'mp.set_property_native(PILL_RECT_PROPERTY, value)',
      'if event.event == "down" then',
      'if event.event == "up" then',
    ]);
  });
});
