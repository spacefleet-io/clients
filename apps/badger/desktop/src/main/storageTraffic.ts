// The storage client's traffic reads, for index.ts: the main entry may not import ./api (main-process ownership guard),
// so the playback hooks that need the merged traffic state (STOR-BW-01) get it through this module.
export { getStorageTraffic, onStorageTrafficChange } from "./api";
