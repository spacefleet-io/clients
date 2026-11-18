// The hidden encoder window (PAR-FMT-02): takes one job at a time from the main process, reads its original in pieces
// and answers with the light copy.
import { isAlacCodec } from "@space/parrot-core";
import { LIGHT_COPY_MAX_READ_BYTES, type LightCopyBridge } from "../../shared/lightCopy";
import { decodeAlacToPcm, decodesWhole, decodeToPcm, encodeOpusLightCopy, encodeStreamedLightCopy, readWhole } from "./encode";

declare global {
  interface Window {
    parrotLightCopy: LightCopyBridge;
  }
}

const bridge = window.parrotLightCopy;

bridge.onJob(async (job) => {
  const started = performance.now();
  const vendor = `Parrot ${job.appVersion} (Chromium WebCodecs Opus)`;
  // Never more than LIGHT_COPY_MAX_READ_BYTES per request, whatever the reader asks for.
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    if (end + 1 - start <= LIGHT_COPY_MAX_READ_BYTES) return bridge.read(job.id, start, end);
    const bytes = new Uint8Array(end + 1 - start);
    for (let at = start; at <= end; at += LIGHT_COPY_MAX_READ_BYTES)
      bytes.set(await bridge.read(job.id, at, Math.min(end, at + LIGHT_COPY_MAX_READ_BYTES - 1)), at - start);
    return bytes;
  };
  try {
    const whole = decodesWhole({ size: job.size, durationMs: job.durationMs });
    let bytes: Uint8Array;
    if (whole) {
      const original = await readWhole(read, job.size);
      const pcm = isAlacCodec(job.codec) ? await decodeAlacToPcm(original) : await decodeToPcm(original);
      bytes = await encodeOpusLightCopy(pcm, job.tags, vendor);
    } else {
      bytes = await encodeStreamedLightCopy({ read, size: job.size, container: job.container, codec: job.codec, tags: job.tags, vendor });
    }
    bridge.done({ id: job.id, ok: true, bytes, ms: Math.round(performance.now() - started), streamed: !whole });
  } catch (error) {
    bridge.done({ id: job.id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
});
bridge.ready();
