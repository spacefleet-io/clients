import { advertisedHardwareEncoders, getDesktopPlatform, normalizeGpuVendor, pickHardwareEncoder } from "@space/desktop-platform";
import { app } from "electron";
import { spawnSync } from "node:child_process";

export type FfmpegCapability = {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  encoderOutputSample?: string | null;
  hwaccelOutputSample?: string | null;
  gpu: {
    vendor?: string | null;
    device?: string | null;
    driverVersion?: string | null;
    renderer?: string | null;
  } | null;
  encoders: string[];
  hwaccels: string[];
  preferredEncoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
  lastTest?: {
    encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
    ok: boolean;
    message?: string;
    logTail?: string;
    testedAt: string;
  };
};

let lastTest: FfmpegCapability["lastTest"];

const resolveFfmpegPath = () => {
  const raw = process.env.SF_FFMPEG_PATH?.trim();
  if (!raw || raw === "undefined" || raw === "null") return undefined;
  return raw;
};
const resolveFfprobePath = () => {
  const raw = process.env.SF_FFPROBE_PATH?.trim();
  if (!raw || raw === "undefined" || raw === "null") return undefined;
  return raw;
};

const parseEncoders = (output: string) => {
  const lines = output.split("\n");
  const encoders: string[] = [];
  lines.forEach((line) => {
    const match = line.match(/^\s*[A-Z.]{6}\s+([0-9A-Za-z_]+)\s+/);
    if (match) encoders.push(match[1]);
  });
  return encoders;
};

const parseHwaccels = (output: string) => {
  const lines = output.split("\n");
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().includes("hardware acceleration methods"));
};

const pickPreferredEncoder = (encoders: string[], gpuVendor: string) => {
  const { encoderPolicy } = getDesktopPlatform().hardware;
  return (
    pickHardwareEncoder(encoderPolicy, advertisedHardwareEncoders(encoderPolicy, encoders), normalizeGpuVendor(gpuVendor)) ?? "cpu"
  );
};

const resolveGpuInfo = async () => {
  try {
    const info = (await app.getGPUInfo("complete")) as {
      gpuDevice?: Array<{
        vendor?: string | null;
        device?: string | null;
        driverVersion?: string | null;
      }>;
      auxAttributes?: { glRenderer?: string | null };
    };
    const device = info.gpuDevice?.[0];
    if (!device) return null;
    return {
      vendor: device.vendor ?? null,
      device: device.device ?? null,
      driverVersion: device.driverVersion ?? null,
      renderer: info.auxAttributes?.glRenderer ?? null,
    };
  } catch {
    return null;
  }
};

const runFfmpegCommand = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...getDesktopPlatform().processes.spawnOptions({ detached: false }) });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return { stdout, stderr, status: result.status ?? 0 };
};

export const getFfmpegCapabilities = async (): Promise<FfmpegCapability> => {
  const ffmpegPath = resolveFfmpegPath();
  const ffprobePath = resolveFfprobePath();
  const encoderRes = runFfmpegCommand(ffmpegPath ?? "ffmpeg", ["-encoders"]);
  const hwRes = runFfmpegCommand(ffmpegPath ?? "ffmpeg", ["-hwaccels"]);
  const encoderOutput = [encoderRes.stdout, encoderRes.stderr].filter(Boolean).join("\n");
  const hwOutput = [hwRes.stdout, hwRes.stderr].filter(Boolean).join("\n");
  const encoders = parseEncoders(encoderOutput);
  const hwaccels = parseHwaccels(hwOutput);
  const gpu = await resolveGpuInfo();
  const preferredEncoder = pickPreferredEncoder(encoders, gpu?.vendor ?? "");

  return {
    ffmpegPath: ffmpegPath ?? null,
    ffprobePath: ffprobePath ?? null,
    encoderOutputSample: encoderOutput
      ? encoderOutput.split("\n").slice(0, 8).join("\n")
      : null,
    hwaccelOutputSample: hwOutput
      ? hwOutput.split("\n").slice(0, 8).join("\n")
      : null,
    gpu,
    encoders,
    hwaccels,
    preferredEncoder,
    lastTest,
  };
};

export const runFfmpegCapabilityTest = async (
  preferred?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu"
): Promise<FfmpegCapability["lastTest"]> => {
  const ffmpegPath = resolveFfmpegPath();
  const caps = await getFfmpegCapabilities();
  const encoder = preferred ?? caps.preferredEncoder;
  const args = [
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=1:size=128x128:rate=24",
  ];
  if (encoder === "vaapi") {
    const devicePath = getDesktopPlatform().hardware.deviceFor("vaapi");
    if (!devicePath) {
      lastTest = {
        encoder,
        ok: false,
        message: "VAAPI device not found at /dev/dri/renderD128",
        testedAt: new Date().toISOString(),
      };
      return lastTest;
    }
    args.push(
      "-vaapi_device",
      devicePath,
      "-vf",
      "format=nv12,hwupload,scale_vaapi=w=128:h=128:format=nv12"
    );
  }

  const encoderArgs =
    encoder === "nvenc"
      ? ["-c:v", "h264_nvenc"]
      : encoder === "qsv"
      ? ["-c:v", "h264_qsv"]
      : encoder === "vaapi"
      ? ["-c:v", "h264_vaapi"]
      : encoder === "amf"
      ? ["-c:v", "h264_amf"]
      : encoder === "videotoolbox"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "0"]
      : ["-c:v", "libx264"];

  const result = runFfmpegCommand(ffmpegPath ?? "ffmpeg", [...args, ...encoderArgs, "-f", "null", "-"]);

  const ok = (result.status ?? 0) === 0;
  let message: string | undefined;
  if (!ok) {
    const raw = result.stderr || result.stdout || "FFmpeg test failed";
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const filtered = lines.filter((line) => !line.startsWith("Input #0"));
    const preferred = filtered.find((line) => /error|failed|vaapi|permission|device/i.test(line));
    const tail = filtered.slice(-3);
    message = (preferred ?? tail.join(" | ") ?? lines[lines.length - 1] ?? "FFmpeg test failed").trim();
    const logTail = lines.slice(-8).join(" | ");
    if (result.status && result.status !== 0) {
      message = `${message} (exit ${result.status})`;
    }
    lastTest = {
      encoder,
      ok: false,
      message,
      logTail,
      testedAt: new Date().toISOString(),
    };
    return lastTest;
  }
  lastTest = {
    encoder,
    ok,
    message,
    testedAt: new Date().toISOString(),
  };
  return lastTest;
};
