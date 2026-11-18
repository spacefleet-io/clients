export type FfmpegCapability = {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  encoderOutputSample?: string | null;
  hwaccelOutputSample?: string | null;
  gpu: { vendor?: string | null; device?: string | null; driverVersion?: string | null; renderer?: string | null } | null;
  encoders: string[];
  hwaccels: string[];
  preferredEncoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
  lastTest?: { encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu"; ok: boolean; message?: string; logTail?: string; testedAt: string };
};

export const getFfmpegCapabilities = async (): Promise<FfmpegCapability | null> => {
  if (!window.sf?.getFfmpegCapabilities) return null;
  try {
    return await window.sf.getFfmpegCapabilities();
  } catch {
    return null;
  }
};

export const testFfmpegEncoder = async (
  encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu"
): Promise<FfmpegCapability["lastTest"] | null> => {
  if (!window.sf?.testFfmpegEncoder) return null;
  try {
    return await window.sf.testFfmpegEncoder(encoder);
  } catch {
    return null;
  }
};

export const formatEncoderLabel = (encoder?: string | null) => {
  if (!encoder) return "Unknown";
  if (encoder === "nvenc") return "NVENC";
  if (encoder === "qsv") return "Quick Sync";
  if (encoder === "vaapi") return "VAAPI";
  if (encoder === "amf") return "AMF";
  if (encoder === "videotoolbox") return "VideoToolbox";
  if (encoder === "cpu") return "CPU (libx264)";
  return encoder.toUpperCase();
};
