import type { AirPlayRoute } from "@space/mobile-mpv-playback";
import type { CastTarget } from "./castFlow";

/** The part of a discovered Google Cast device the picker needs (`Device` of react-native-google-cast). */
export type CastDeviceInfo = { deviceId: string; friendlyName: string; modelName: string };

/** A cast target row: a Google Cast device or AirPlay. Shared by the Play picker and the "Play on TV" sheet (UX-TV-03). */
export type CastTargetEntry =
  | { kind: "google-cast"; target: Extract<CastTarget, { kind: "google-cast" }> }
  /** Apple's AirPlay button: the system sheet picks the route, then `airplay-route` appears. */
  | { kind: "airplay-button" }
  | { kind: "airplay-route"; target: Extract<CastTarget, { kind: "airplay" }> };

export type CastPickerEntry = { kind: "phone" } | CastTargetEntry;

type PickerInput = { devices: readonly CastDeviceInfo[]; platform: "android" | "ios" };
type EntriesInput = PickerInput & { airPlayRoute: AirPlayRoute | null };

/** Each Cast device once (by name), then AirPlay on an iPhone: the rows both the Play picker and "Play on TV" show. */
export const castTargetEntries = ({ devices, platform, airPlayRoute }: EntriesInput): CastTargetEntry[] => {
  const unique = new Map(devices.map((d) => [d.deviceId, d]));
  const entries: CastTargetEntry[] = [];
  for (const d of [...unique.values()].sort((a, b) => a.friendlyName.localeCompare(b.friendlyName))) {
    entries.push({ kind: "google-cast", target: { kind: "google-cast", deviceId: d.deviceId, name: d.friendlyName, modelName: d.modelName } });
  }
  if (platform === "ios") {
    entries.push({ kind: "airplay-button" });
    if (airPlayRoute?.active) entries.push({ kind: "airplay-route", target: { kind: "airplay", name: airPlayRoute.name ?? "AirPlay" } });
  }
  return entries;
};

/** "This phone" first, then the cast target rows. */
export const castPickerEntries = (input: EntriesInput): CastPickerEntry[] => [{ kind: "phone" }, ...castTargetEntries(input)];

/**
 * Whether the play button asks where to play (INTG-CAST-01). Without a discovered Cast device on Android it plays on the phone
 * at once, as before; an iPhone cannot know whether an AirPlay device is near, so it always asks.
 */
export const playButtonAsksTarget = ({ devices, platform }: PickerInput): boolean => platform === "ios" || devices.length > 0;
