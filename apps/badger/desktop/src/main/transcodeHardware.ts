/**
 * Hardware facts the first-start "fallback 360p copy" recommendation is made
 * from (#25). Runs once per computer (main/deviceSettings.ts only calls it when
 * nothing is stored yet), after `createWindow` has resolved SF_FFMPEG_PATH so
 * the encoder probe uses the bundled ffmpeg.
 */
import { probeHostCapacity } from "@space/desktop-platform/host-capacity";
import type { TranscodeHardware } from "@space/shared/transcodeHardware";
import { detectWorkingHardwareEncoder } from "./mediaIngest";
import { scopeLogger } from "./logger";

const logger = scopeLogger("transcode-default");
const ENCODER_PROBE_TIMEOUT_MS = 30_000;

export const probeTranscodeHardware = async (): Promise<TranscodeHardware> => {
  const { cpuModel, cores, ramGB, totalmemGB, cgroupLimitGB } = probeHostCapacity();
  let hwEncoder = "none";
  logger.info(
    { cpuModel, cores, totalmemGB, ffmpeg: process.env.SF_FFMPEG_PATH ?? null },
    "[transcode-default] probing hardware encoder (first start)",
  );
  const probeStartedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Only returns a hardware name after a real test encode succeeded. Tries
    // every advertised hardware encoder, vendor-preferred first, so a missing
    // or wrong GPU vendor can't store hwEncoder=none on a capable machine.
    // Bounded: ingest submits await this first-start result, so a wedged GPU
    // driver / ffmpeg must not hold them hostage.
    const encoder = await Promise.race([
      detectWorkingHardwareEncoder(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ENCODER_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (encoder === "timeout") {
      logger.warn(
        { timeoutMs: ENCODER_PROBE_TIMEOUT_MS },
        "[transcode-default] encoder probe timed out — treating as no hardware encoder",
      );
    } else {
      hwEncoder = encoder === "cpu" ? "none" : encoder;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "[transcode-default] encoder probe failed — treating as no hardware encoder");
  } finally {
    clearTimeout(timer);
  }
  const hardware: TranscodeHardware = { cpuModel, cores, ramGB, hwEncoder };
  logger.info(
    {
      ...hardware,
      totalmemGB,
      cgroupLimitGB,
      ffmpeg: process.env.SF_FFMPEG_PATH ?? null,
      probeMs: Date.now() - probeStartedAt,
    },
    "[transcode-default] hardware probed",
  );
  return hardware;
};
