/**
 * Reads the first subtitle stream of a Matroska file as raw packets via
 * ffprobe (`-show_packets -show_data`), which is shipped on every desktop OS.
 * ffprobe's `data` / `extradata` fields are hex dumps:
 * `\n%08x: ` + 16 bytes as "%02x" pairs (a space after every second byte,
 * blank-padded to 40 columns) + an ASCII column.
 */
import { spawn } from "node:child_process";

export type ProbedSubtitlePacket = { ptsMs: number; durationMs: number | null; data: Uint8Array };
export type ProbedSubtitleStream = {
  codec: string;
  width: number | null;
  height: number | null;
  extradata: Uint8Array;
  packets: ProbedSubtitlePacket[];
};

type FfprobeJson = {
  streams?: Array<{
    codec_name?: string;
    width?: number;
    height?: number;
    time_base?: string;
    extradata?: string;
  }>;
  packets?: Array<{ pts?: number; duration?: number; data?: string }>;
};

export const parseFfprobeHexDump = (dump: string | undefined): Uint8Array => {
  if (!dump) return new Uint8Array(0);
  const bytes: number[] = [];
  for (const line of dump.split("\n")) {
    if (!/^[0-9a-f]{8}: /.test(line)) continue;
    const hex = line.slice(10, 50).replace(/ /g, "");
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return Uint8Array.from(bytes);
};

const runFfprobe = (ffprobePath: string, inputPath: string, signal?: AbortSignal): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const args = ["-v", "error", "-select_streams", "s:0", "-show_streams", "-show_packets", "-show_data", "-of", "json", inputPath];
  // windowsHide: on Windows a console child of a console-less parent gets its own visible window (as in process.ts).
  const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
  const out: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
    else reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
  });
  return promise;
};

export const probeSubtitlePackets = async (
  ffprobePath: string,
  inputPath: string,
  signal?: AbortSignal
): Promise<ProbedSubtitleStream> => {
  const json = JSON.parse(await runFfprobe(ffprobePath, inputPath, signal)) as FfprobeJson;
  const stream = json.streams?.[0];
  if (!stream?.codec_name) throw new Error(`no subtitle stream in ${inputPath}`);
  const [num, den] = (stream.time_base ?? "1/1000").split("/").map(Number);
  const msPerTick = (num / den) * 1000;
  const packets = (json.packets ?? [])
    .filter((p) => typeof p.pts === "number")
    .map((p) => ({
      ptsMs: (p.pts as number) * msPerTick,
      durationMs: typeof p.duration === "number" && p.duration > 0 ? p.duration * msPerTick : null,
      data: parseFfprobeHexDump(p.data),
    }));
  return {
    codec: stream.codec_name,
    width: stream.width ?? null,
    height: stream.height ?? null,
    extradata: parseFfprobeHexDump(stream.extradata),
    packets,
  };
};
