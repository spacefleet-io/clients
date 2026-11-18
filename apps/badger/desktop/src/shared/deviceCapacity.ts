/**
 * ACCT-SQUAD-03 (Chris 2026-10-30): the settings tied to a computer's capacity belong to that computer, never to the
 * account or a profile. Kept in `<userData>/device-settings.json` (main/deviceSettings.ts); the renderer shows them in
 * its `ClientConfig` view but never writes them to the synced `client_config_v1`. OFFL-FILE-01: the download file
 * format is this computer's too (it is about the players on this computer), stored with them.
 */

export type OfflineExportFormat = "mkv" | "mp4";

export const isOfflineExportFormat = (value: unknown): value is OfflineExportFormat => value === "mkv" || value === "mp4";

export type WatchedDirectory = {
  id: string;
  label: string;
  path: string;
  library: "movies" | "tv";
};

export type DeviceCapacityValues = {
  /** engineV2 `format` (transcode) lane cap, 1-3. */
  maxParallelTranscodes: number;
  /** engineV2 `source` (extraction) lane cap, 1-3. */
  maxParallelExtractions: number;
  watchedDirectories: WatchedDirectory[];
  /** OFFL-FILE-01: the file format downloads are saved in on this computer. */
  offlineExportFormat: OfflineExportFormat;
};

/** Where this computer's values came from: copied once from the synced config, or set in Settings since. */
export type DeviceCapacitySource = "synced-config" | "settings";

export type DeviceCapacitySettings = DeviceCapacityValues & { source: DeviceCapacitySource; updatedAt: string };

/**
 * The entry as stored. A file written before the download format moved here has no `offlineExportFormat`; it is copied
 * once from the synced config (`adoptCapacity`), so a format someone already chose is kept.
 */
export type StoredDeviceCapacity = Omit<DeviceCapacitySettings, "offlineExportFormat"> & {
  offlineExportFormat?: OfflineExportFormat;
};

export const DEVICE_CAPACITY_FIELDS = [
  "maxParallelTranscodes",
  "maxParallelExtractions",
  "watchedDirectories",
  "offlineExportFormat",
] as const;

/** A lane cap: an integer in [1, 3]; anything else is 1. */
export const coerceLaneCap = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(3, Math.trunc(value)));
};

const isWatchedDirectory = (value: unknown): value is WatchedDirectory => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.label === "string" &&
    typeof entry.path === "string" &&
    entry.path !== "" &&
    (entry.library === "movies" || entry.library === "tv")
  );
};

export const coerceWatchedDirectories = (value: unknown): WatchedDirectory[] =>
  Array.isArray(value)
    ? value.filter(isWatchedDirectory).map(({ id, label, path, library }) => ({ id, label, path, library }))
    : [];

export const coerceDeviceCapacity = (value: unknown): DeviceCapacityValues => {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    maxParallelTranscodes: coerceLaneCap(raw.maxParallelTranscodes),
    maxParallelExtractions: coerceLaneCap(raw.maxParallelExtractions),
    watchedDirectories: coerceWatchedDirectories(raw.watchedDirectories),
    // MKV keeps every audio and subtitle track; anything else falls back to it.
    offlineExportFormat: raw.offlineExportFormat === "mp4" ? "mp4" : "mkv",
  };
};

export const isStoredDeviceCapacity = (value: unknown): value is StoredDeviceCapacity => {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    (raw.source === "synced-config" || raw.source === "settings") &&
    typeof raw.updatedAt === "string" &&
    typeof raw.maxParallelTranscodes === "number" &&
    typeof raw.maxParallelExtractions === "number" &&
    Array.isArray(raw.watchedDirectories)
  );
};
