// @bugfix @regression-proof
// On the real Google TV the snapshot poll (every 500 ms) logged
// `mpv_get_property(sid) format 4 ... unsupported format` because it read the track-id choice
// properties (vid/aid/sid) as INT64; they are "no" when no track is selected. Track ids must be
// read as strings and parsed, like MpvSurfaceView.TrackDelegate already does.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mainSrc = join(import.meta.dirname, "..", "android", "src", "main", "java", "com", "spacefleet", "mpvplayback", "mpv");
const controlModule = readFileSync(join(mainSrc, "MpvControlModule.kt"), "utf8");

describe("Android mpv track-id reads", () => {
  test("no INT64 read of vid/aid/sid in the control module", () => {
    const intReads = [...controlModule.matchAll(/(?:getPropertyInt|safeGetIntOrNull|safeGetInt)\("(vid|aid|sid)"\)/g)].map((m) => m[0]);
    console.log("[trackIdReads] INT64 track-id reads found:", intReads);
    expect(intReads).toEqual([]);
  });

  test("snapshot reads vid/aid/sid through the string-backed helper", () => {
    for (const id of ["vid", "aid", "sid"]) {
      expect(controlModule).toContain(`map.putInt("${id}", safeGetTrackIdOrNull("${id}") ?: -1)`);
    }
    expect(controlModule).toMatch(/private fun safeGetTrackIdOrNull\(name: String\): Int\? \{\s*return try \{\s*MpvGuard\.getPropertyString\(name\)\?\.toIntOrNull\(\)/);
  });
});
