/**
 * AAC channel layouts every client decodes (#1176).
 *
 * ffmpeg's AAC encoder writes a standard channel configuration (1-6) only for
 * mono, stereo, 3.0, 4.0, 5.0 and 5.1. Any other layout (5.1(side), the usual
 * layout of AC-3, E-AC-3 and DTS sources, 5.0(side), 2.1, quad, 4.1 ...) is
 * written as channel configuration 0 plus a program config element. mpv plays
 * both; Chrome's MSE parser rejects configuration 0 with
 * `CHUNK_DEMUXER_ERROR_APPEND_FAILED`, so the browser cannot play the track.
 *
 * Only a lossless relabel is applied: 5.1(side) and 5.0(side) become 5.1 and
 * 5.0 (the side channels renamed back channels, no remix). Every other layout
 * (2.1, quad, 4.1, 6.0, seven and more channels ...) would need a remix that
 * drops the LFE or merges channels for every client, so it is stored as it is
 * until INGS-AUDIO-01 is decided: desktop, phone and TV keep every channel.
 */
const STANDARD_AAC_LAYOUT: Readonly<Record<string, string>> = {
  mono: "mono",
  stereo: "stereo",
  "3.0": "3.0",
  "4.0": "4.0",
  "5.0": "5.0",
  "5.1": "5.1",
  "5.0(side)": "5.0",
  "5.1(side)": "5.1",
};

/** The standard layout an AAC encode of the probed `layout` is stored as, or null to leave the layout alone. */
export const standardAacLayoutFor = (layout: string | null): string | null =>
  (layout && STANDARD_AAC_LAYOUT[layout]) || null;

const readDescriptorHeader = (bytes: Uint8Array, offset: number) => {
  const tag = bytes[offset];
  let cursor = offset + 1;
  let size = 0;
  for (let i = 0; i < 4 && cursor < bytes.length; i += 1) {
    const byte = bytes[cursor];
    cursor += 1;
    size = (size << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { tag, size, body: cursor };
};

/**
 * Layouts a program config element names, keyed `front/side/back/lfe` channel counts. A PCE carries element
 * positions, not channel names, so the shape decides: the shapes the spec gives (an LFE element for `.1`) plus
 * the ones FFmpeg 8's AAC encoder (the shipped media-deps ffmpeg) writes. FFmpeg 8 writes 5.1(side) as a front
 * pair + centre, a side single and a back pair with no LFE element (`aac_pce_configs` in libavcodec/aacenc.c),
 * and its decoder reads that shape back as 5.1; no other layout it encodes with a PCE has that shape.
 */
const PCE_LAYOUT: Readonly<Record<string, string>> = {
  "1/0/0/0": "mono",
  "2/0/0/0": "stereo",
  "2/0/0/1": "2.1",
  "3/0/0/0": "3.0",
  "2/2/0/0": "quad(side)",
  "2/0/2/0": "quad",
  "3/0/1/0": "4.0",
  "3/2/0/0": "5.0(side)",
  "3/0/2/0": "5.0",
  "3/2/0/1": "5.1(side)",
  "3/1/2/0": "5.1(side)",
  "3/0/2/1": "5.1",
};

/**
 * The AudioSpecificConfig of an MP4 init segment's `esds` box: its channel configuration and, for configuration 0,
 * the layout its program config element names (null when the PCE's layout has no name here). Null when the bytes
 * hold no AAC `esds`.
 */
const readAudioSpecificConfig = (init: Uint8Array): { config: number; pceLayout: string | null } | null => {
  // "esds" box type, then 4 bytes of version + flags.
  let esds = -1;
  for (let i = 0; i + 4 <= init.length; i += 1) {
    if (init[i] === 0x65 && init[i + 1] === 0x73 && init[i + 2] === 0x64 && init[i + 3] === 0x73) {
      esds = i + 8;
      break;
    }
  }
  if (esds < 0) return null;
  const es = readDescriptorHeader(init, esds);
  if (es.tag !== 0x03) return null;
  const esFlags = init[es.body + 2];
  let cursor = es.body + 3;
  if (esFlags & 0x80) cursor += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) cursor += 1 + init[cursor]; // URL
  if (esFlags & 0x20) cursor += 2; // OCR_ES_Id
  const decoderConfig = readDescriptorHeader(init, cursor);
  if (decoderConfig.tag !== 0x04) return null;
  const specific = readDescriptorHeader(init, decoderConfig.body + 13);
  if (specific.tag !== 0x05 || specific.size < 2) return null;
  // AudioSpecificConfig: audioObjectType (5 bits, 6 more when 31),
  // samplingFrequencyIndex (4 bits, 24 more when 15), channelConfiguration (4 bits).
  let bit = specific.body * 8;
  const readBits = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = init[bit >> 3];
      if (byte === undefined) return -1;
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit += 1;
    }
    return value;
  };
  let objectType = readBits(5);
  if (objectType === 31) objectType = 32 + readBits(6);
  if (readBits(4) === 15) readBits(24);
  const config = readBits(4);
  if (config < 0) return null;
  // A program config element follows the GASpecificConfig of the AAC object types (1-4, 6, 7, 17, 19-23).
  if (config !== 0 || ![1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(objectType)) return { config, pceLayout: null };
  readBits(1); // frameLengthFlag
  if (readBits(1) === 1) readBits(14); // dependsOnCoreCoder: coreCoderDelay
  readBits(1); // extensionFlag
  // program_config_element(): element_instance_tag, object_type, sampling_frequency_index, then element counts.
  readBits(4 + 2 + 4);
  const counts = [readBits(4), readBits(4), readBits(4), readBits(2)];
  readBits(3); // num_assoc_data_elements
  readBits(4); // num_valid_cc_elements
  if (readBits(1) === 1) readBits(4); // mono_mixdown
  if (readBits(1) === 1) readBits(4); // stereo_mixdown
  if (readBits(1) === 1) readBits(3); // matrix_mixdown
  // front, side and back elements: is_cpe (a pair) + tag; LFE elements: tag only.
  const channels = counts.slice(0, 3).map((elements) => {
    let total = 0;
    for (let i = 0; i < elements; i += 1) {
      total += readBits(1) === 1 ? 2 : 1;
      readBits(4); // element tag
    }
    return total;
  });
  if (counts.some((count) => count < 0) || bit > init.length * 8) return { config, pceLayout: null };
  return { config, pceLayout: PCE_LAYOUT[[...channels, counts[3]].join("/")] ?? null };
};

/**
 * Channel configuration of the AudioSpecificConfig in an MP4 init segment's
 * `esds` box, or null when the bytes hold no AAC `esds`.
 */
export const readAacChannelConfiguration = (init: Uint8Array): number | null => readAudioSpecificConfig(init)?.config ?? null;

/**
 * Layout the program config element of a configuration-0 AAC init segment names, or null. ffprobe reports no
 * layout for such a track (FFmpeg 8), so the PCE is the only place ingest can learn it is 5.1(side).
 */
export const readAacPceLayout = (init: Uint8Array): string | null => readAudioSpecificConfig(init)?.pceLayout ?? null;
