import type { StorageTraffic } from "@space/shared/storageTunnel";

/**
 * What the main process tells the renderer about the silo of the playback in progress (STOR-BW-07, STOR-BW-08,
 * PLAY-QUAL-07). `qualityCap` is the cap that silo reports while saturated; `refusals` counts new playbacks the silo
 * refused; `stops` counts playbacks that ended because of the saturation. Both counters only go up.
 */
export type PlaybackSaturationState = {
  qualityCap: StorageTraffic["qualityCap"];
  refusals: number;
  stops: number;
};
