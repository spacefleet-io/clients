/**
 * @test-id MOBILE-CAST-005
 * @level unit
 * @why The play-target picker (UX-TV-03, INTG-CAST-01): the play button asks where to send playback only when a cast
 *   target can exist, always lists "This phone" first, lists each discovered Cast device once with its model, and on an
 *   iPhone offers AirPlay (the system button, or the route already chosen).
 */
import { describe, expect, it } from "vitest";
import { castPickerEntries, castTargetEntries, playButtonAsksTarget, type CastDeviceInfo } from "../src/lib/cast/castPicker";

const device = (deviceId: string, friendlyName: string, modelName = "Chromecast"): CastDeviceInfo => ({ deviceId, friendlyName, modelName });

describe("play-target picker entries", () => {
  /** @req UX-TV-03[badger-mobile] */
  /** @req INTG-CAST-01[badger-mobile] */
  it("lists This phone first, then devices by name, each once", () => {
    const devices = [device("b", "Living room", "Google TV Streamer"), device("a", "Bedroom"), device("b", "Living room", "Google TV Streamer")];
    const entries = castPickerEntries({ devices, platform: "android", airPlayRoute: null });
    expect(entries.map((e) => e.kind)).toEqual(["phone", "google-cast", "google-cast"]);
    expect(entries.slice(1).map((e) => (e.kind === "google-cast" ? e.target.name : ""))).toEqual(["Bedroom", "Living room"]);
    const first = entries[1];
    expect(first.kind === "google-cast" && first.target).toEqual({ kind: "google-cast", deviceId: "a", name: "Bedroom", modelName: "Chromecast" });
  });

  /** @req UX-TV-03[badger-mobile] */
  it("offers the AirPlay button on an iPhone, and the chosen route once there is one", () => {
    const noRoute = castPickerEntries({ devices: [], platform: "ios", airPlayRoute: null });
    expect(noRoute.map((e) => e.kind)).toEqual(["phone", "airplay-button"]);
    const withRoute = castPickerEntries({ devices: [], platform: "ios", airPlayRoute: { active: true, name: "Apple TV" } });
    expect(withRoute.map((e) => e.kind)).toEqual(["phone", "airplay-button", "airplay-route"]);
    const route = withRoute[2];
    expect(route.kind === "airplay-route" && route.target).toEqual({ kind: "airplay", name: "Apple TV" });
  });

  /** @req UX-TV-03[badger-mobile] */
  it("never offers AirPlay on Android", () => {
    const entries = castPickerEntries({ devices: [], platform: "android", airPlayRoute: { active: true, name: "Apple TV" } });
    expect(entries.map((e) => e.kind)).toEqual(["phone"]);
  });

  /** @req UX-TV-03[badger-mobile] */
  it("gives the Play on TV sheet the same cast rows as the Play picker, without This phone", () => {
    const devices = [device("b", "Salon", "Google TV Streamer"), device("a", "Bedroom")];
    for (const platform of ["android", "ios"] as const) {
      const airPlayRoute = { active: true, name: "Apple TV" };
      const rows = castTargetEntries({ devices, platform, airPlayRoute });
      expect(rows.some((e) => (e.kind as string) === "phone")).toBe(false);
      expect(castPickerEntries({ devices, platform, airPlayRoute })).toEqual([{ kind: "phone" }, ...rows]);
    }
    expect(castTargetEntries({ devices, platform: "android", airPlayRoute: null }).map((e) => (e.kind === "google-cast" ? e.target.name : e.kind))).toEqual(["Bedroom", "Salon"]);
    expect(castTargetEntries({ devices: [], platform: "android", airPlayRoute: null })).toEqual([]);
  });

  /** @req INTG-CAST-01[badger-mobile] */
  it("keeps the play button instant when there is nothing to cast to", () => {
    expect(playButtonAsksTarget({ devices: [], platform: "android" })).toBe(false);
    expect(playButtonAsksTarget({ devices: [device("a", "Bedroom")], platform: "android" })).toBe(true);
    expect(playButtonAsksTarget({ devices: [], platform: "ios" })).toBe(true);
  });
});
