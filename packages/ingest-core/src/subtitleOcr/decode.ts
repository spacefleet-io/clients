import { open, readFile } from "node:fs/promises";
import { decodeDvbPackets } from "./dvb";
import { probeSubtitlePackets } from "./ffprobePackets";
import { decodePgsSup } from "./pgs";
import { closePictureTimeline, type DecodedPictureSubtitles, type SubtitlePicture } from "./types";
import { decodeVobSubPacket, parseVobSubIdx } from "./vobsub";

type OpenPicture = Omit<SubtitlePicture, "endMs"> & { endMs: number | null };

/**
 * Matroska PGS blocks hold bare segments (type + size + payload) without the
 * `.sup` "PG" + PTS/DTS header; rebuild a `.sup` stream from packet timestamps.
 */
const matroskaPgsToSup = (packets: Array<{ ptsMs: number; data: Uint8Array }>): Uint8Array => {
  const parts: Buffer[] = [];
  for (const packet of packets) {
    const pts = Math.round(packet.ptsMs * 90);
    let pos = 0;
    while (pos + 3 <= packet.data.length) {
      const size = (packet.data[pos + 1] << 8) | packet.data[pos + 2];
      const header = Buffer.alloc(10);
      header.write("PG", 0, "latin1");
      header.writeUInt32BE(pts >>> 0, 2);
      parts.push(header, Buffer.from(packet.data.subarray(pos, pos + 3 + size)));
      pos += 3 + size;
    }
  }
  return Buffer.concat(parts);
};

/**
 * Decodes a stored picture-subtitle object: a PGS `.sup` (detected by its
 * "PG" magic) or a single-track Matroska file holding dvd_subtitle,
 * dvb_subtitle or hdmv_pgs_subtitle (read through ffprobe).
 */
export const decodePictureSubtitleFile = async (
  inputPath: string,
  options: { ffprobePath: string; signal?: AbortSignal }
): Promise<DecodedPictureSubtitles> => {
  const handle = await open(inputPath, "r");
  const magic = Buffer.alloc(2);
  try {
    await handle.read(magic, 0, 2, 0);
  } finally {
    await handle.close();
  }
  if (magic.toString("latin1") === "PG") return decodePgsSup(await readFile(inputPath));

  const stream = await probeSubtitlePackets(options.ffprobePath, inputPath, options.signal);
  switch (stream.codec) {
    case "hdmv_pgs_subtitle":
      return decodePgsSup(matroskaPgsToSup(stream.packets));
    case "dvd_subtitle": {
      const idx = parseVobSubIdx(Buffer.from(stream.extradata).toString("latin1"));
      const open: OpenPicture[] = [];
      let failures = 0;
      for (const packet of stream.packets) {
        try {
          const picture = decodeVobSubPacket(packet.data, packet.ptsMs, idx);
          if (picture) open.push(picture);
          else failures += 1;
        } catch {
          failures += 1;
        }
      }
      return { codec: "dvd_subtitle", pictures: closePictureTimeline(open), failures };
    }
    case "dvb_subtitle": {
      let failures = 0;
      const open = decodeDvbPackets(stream.packets, () => {
        failures += 1;
      });
      return { codec: "dvb_subtitle", pictures: closePictureTimeline(open), failures };
    }
    default:
      throw new Error(`unsupported picture subtitle codec ${stream.codec}`);
  }
};
