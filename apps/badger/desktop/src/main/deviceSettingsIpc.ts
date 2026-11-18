/**
 * #25: device-local settings (this computer only, never synced to the account).
 * Owns the store, the first-start hardware detection and the
 * `sf-device-*` IPC handlers so the main entry only wires it.
 */
import { app, ipcMain } from "electron";
import { join } from "node:path";
import {
  createDeviceSettingsStore,
  parseForcedFallbackCopy,
  parseForcedUploadsDuringPlayback,
  type DeviceSettingsStore,
} from "./deviceSettings";
import { isUploadsDuringPlayback, type UploadsFirstRunAnswer } from "../shared/uploadPlaybackDefault";
import { coerceDeviceCapacity } from "../shared/deviceCapacity";
import { scopeLogger } from "./logger";
import { probeTranscodeHardware } from "./transcodeHardware";

const logger = scopeLogger("transcode-default");

export const registerDeviceSettingsIpc = (): DeviceSettingsStore => {
  const store = createDeviceSettingsStore({
    filePath: join(app.getPath("userData"), "device-settings.json"),
    probeHardware: probeTranscodeHardware,
    forcedDefault: parseForcedFallbackCopy(process.env.SF_TRANSCODE_FALLBACK_COPY),
    forcedUploadsDuringPlayback: parseForcedUploadsDuringPlayback(process.env.SF_UPLOADS_DURING_PLAYBACK),
    log: (line) => logger.info(line),
  });
  ipcMain.handle("sf-device-transcode-get", () => store.getTranscode());
  ipcMain.handle("sf-device-transcode-answer", (_event, answer: unknown) => {
    if (answer !== "accepted" && answer !== "overridden") {
      throw new Error(`invalid first-run answer: ${String(answer)}`);
    }
    return store.answerFirstRun(answer);
  });
  ipcMain.handle("sf-device-transcode-set", (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new Error(`invalid fallbackCopy value: ${String(value)}`);
    return store.setFallbackCopy(value);
  });
  ipcMain.handle("sf-device-uploads-playback-get", () => store.getUploadsDuringPlayback());
  ipcMain.handle("sf-device-uploads-playback-answer", (_event, answer: unknown) =>
    store.answerUploadsFirstRun(parseUploadsFirstRunAnswer(answer)),
  );
  ipcMain.handle("sf-device-uploads-playback-set", (_event, value: unknown) => {
    if (!isUploadsDuringPlayback(value)) throw new Error(`invalid uploadsDuringPlayback value: ${String(value)}`);
    return store.setUploadsDuringPlayback(value);
  });
  // ACCT-SQUAD-03: capacity settings are this computer's; values are clamped by the store.
  ipcMain.handle("sf-device-capacity-adopt", (_event, seed: unknown) => store.adoptCapacity(coerceDeviceCapacity(seed)));
  ipcMain.handle("sf-device-capacity-set", (_event, values: unknown) => store.setCapacity(coerceDeviceCapacity(values)));
  return store;
};

const parseUploadsFirstRunAnswer = (answer: unknown): UploadsFirstRunAnswer => {
  if (typeof answer === "object" && answer !== null && "kind" in answer) {
    if (answer.kind === "accepted") return { kind: "accepted" };
    if (answer.kind === "chosen" && "mode" in answer && isUploadsDuringPlayback(answer.mode)) {
      return { kind: "chosen", mode: answer.mode };
    }
  }
  throw new Error(`invalid uploads first-run answer: ${JSON.stringify(answer)}`);
};

/**
 * First-start detection. Call after the window is created (SF_FFMPEG_PATH is
 * resolved by then, so the encoder probe uses the bundled ffmpeg). A stored
 * value is just read back and logged — never re-detected.
 */
export const detectOnFirstStart = (store: DeviceSettingsStore): void => {
  void store.getTranscode().catch((err: unknown) => {
    logger.error({ err: String(err) }, "[transcode-default] first-start detection failed");
  });
};
