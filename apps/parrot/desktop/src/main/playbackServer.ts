import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PARROT_DOWNLOAD_LANES_PER_FILE, type ParrotCoverImage, type ParrotLibraryFile } from "@space/parrot-ingest";
import {
  alacWavLayout,
  indexAlacMp4,
  isAlacCodec,
  parseByteRange,
  readAlacAsWav,
  readParrotFileRange,
  type AlacMp4Index,
  type ParrotChunkLoader,
  type ParrotChunkReads,
} from "@space/parrot-core";

/** Chunks fetched ahead of the one being sent (PAR-PLAY-08): one per download session a song may use. */
const READ_AHEAD_CHUNKS = PARROT_DOWNLOAD_LANES_PER_FILE - 1;

export type ParrotPlaybackServer = {
  /** The address the window's player reads the file from. */
  urlFor(fileId: string): string;
  /**
   * The address a background reader (the loudness pass, PAR-PLAY-03) reads the file from: the same bytes as `urlFor`,
   * through `loadForReading`, so its reads neither fill the player's chunk cache nor stand in for the player's own
   * measured downloads (PAR-PLAY-02).
   */
  readUrlFor(fileId: string): string;
  /** The address the window's <img> shows the album cover stored under `objectKey` from (PAR-META-04). */
  coverUrlFor(objectKey: string): string;
  close(): Promise<void>;
};

/**
 * Serves the user's songs to the window's player (PAR-PLAY-01), and their album covers to the window, from 127.0.0.1
 * on a random port, behind a random path secret so no other program on the computer can read them. Each song request
 * decrypts only the chunks its byte range covers, so playback starts after the first chunk and seeking fetches only
 * what it needs. An Apple Lossless song, which Chromium cannot play, is served as the WAV it decodes to (PAR-FMT-01):
 * the same address, and a byte range of the WAV decodes only the frames it covers, so seeking stays instant.
 * Background reads of a whole song (the loudness pass) have their own address and chunk loader beside the player's.
 * Every answer holds the chunks of the file it reads in `reads` until it ends (PAR-LYR-07), so a step replacing the
 * file meanwhile removes the old chunks only after it.
 */
export const startParrotPlaybackServer = async (input: {
  findFile: (fileId: string) => ParrotLibraryFile | null;
  load: ParrotChunkLoader;
  /** The chunks behind `readUrlFor`: no cache shared with `load`. */
  loadForReading: ParrotChunkLoader;
  loadCover: (objectKey: string) => Promise<ParrotCoverImage | null>;
  reads: ParrotChunkReads;
  log: (line: string) => void;
}): Promise<ParrotPlaybackServer> => {
  const secret = randomBytes(16).toString("hex");
  // ALAC frame tables, per stored file: built once from the file's `moov` box, kept for the few songs around the queue.
  // Keyed by the file's version too (its first chunk and size): storing an older file again split (PAR-FMT-01) keeps
  // its id with its frames moved, so a table built before would read the wrong bytes.
  const alacIndexes = new Map<string, Promise<AlacMp4Index>>();
  const alacIndexOf = (file: ParrotLibraryFile, load: ParrotChunkLoader) => {
    const key = `${file.id}:${file.sizeBytes}:${file.chunks[0]?.objectKey ?? ""}`;
    let index = alacIndexes.get(key);
    if (!index) {
      index = indexAlacMp4(async (start, end) => {
        const parts: Uint8Array[] = [];
        for await (const part of readParrotFileRange(file.chunks, start, end, load)) parts.push(part);
        return Buffer.concat(parts);
      }, file.sizeBytes);
      index.catch(() => alacIndexes.delete(key));
      alacIndexes.set(key, index);
      if (alacIndexes.size > 8) alacIndexes.delete(alacIndexes.keys().next().value!);
    }
    return index;
  };
  const prefix = `/${secret}/file/`;
  const readPrefix = `/${secret}/read/`;
  const coverPrefix = `/${secret}/cover/`;

  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(404).end();
        return;
      }
      if (path.startsWith(coverPrefix)) {
        const objectKey = decodeURIComponent(path.slice(coverPrefix.length));
        const cover = await input.loadCover(objectKey);
        if (!cover) {
          res.writeHead(404).end();
          return;
        }
        // A cover's key never changes content: the window may keep it for the session (not on disk across starts). The
        // window also reads the bytes (fetch) to hand the system media panel a blob: picture (PLAY-OSMEDIA-01), so the
        // answer is readable cross-origin; the random path secret stays what keeps other programs out.
        res.writeHead(200, {
          "Content-Type": cover.mime,
          "Content-Length": String(cover.bytes.length),
          "Cache-Control": "private, max-age=86400, immutable",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(req.method === "HEAD" ? undefined : cover.bytes);
        return;
      }
      const reading = path.startsWith(readPrefix);
      if (!reading && !path.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const fileId = decodeURIComponent(path.slice(reading ? readPrefix.length : prefix.length));
      const load = reading ? input.loadForReading : input.load;
      const file = input.findFile(fileId);
      if (!file) {
        input.log(`[playback] ${fileId}: not in the library`);
        res.writeHead(404).end();
        return;
      }
      // Released when the answer ends, however it ends (sent, refused, failed or dropped by the player).
      res.once("close", input.reads.hold(file.chunks.map((chunk) => chunk.objectKey)));
      const alac = isAlacCodec(file.codec) ? await alacIndexOf(file, load).catch((error: unknown) => error as Error) : null;
      if (alac instanceof Error) {
        input.log(`[playback] ${fileId}: cannot read its Apple Lossless frames: ${alac.message}`);
        res.writeHead(500).end();
        return;
      }
      const total = alac ? alacWavLayout(alac).size : file.sizeBytes;
      const range = parseByteRange(req.headers.range ?? null, total);
      if (!range) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
        return;
      }
      const { start, end } = range;
      const status = req.headers.range ? 206 : 200;
      res.writeHead(status, {
        "Content-Type": alac ? "audio/wav" : file.mime,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        // The window's gapless player (PAR-PLAY-03) reads the song with fetch and Web Audio, which need CORS; the
        // random path secret stays what keeps other programs out, as for covers.
        "Access-Control-Allow-Origin": "*",
        ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const started = Date.now();
      let sent = 0;
      let aborted = false;
      req.on("close", () => {
        if (!res.writableFinished) aborted = true;
      });
      // A player that went away never drains: its "close" ends the wait (one listener for the whole answer).
      const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
      res.once("close", () => onClose());
      try {
        const parts = alac
          ? readAlacAsWav(alac, start, end, (from, to) => readParrotFileRange(file.chunks, from, to, load, READ_AHEAD_CHUNKS))
          : readParrotFileRange(file.chunks, start, end, load, READ_AHEAD_CHUNKS);
        for await (const part of parts) {
          if (aborted) break;
          sent += part.length;
          if (!res.write(part)) await Promise.race([once(res, "drain"), closed]);
        }
        res.end();
        input.log(
          `[playback] ${fileId} bytes ${start}-${end}/${total}: ${aborted ? "stopped by the player after" : "sent"} ${sent} bytes in ${Date.now() - started} ms`
        );
      } catch (error) {
        input.log(`[playback] ${fileId} bytes ${start}-${end}: failed after ${sent} bytes: ${error instanceof Error ? error.message : String(error)}`);
        res.destroy(error instanceof Error ? error : undefined);
      }
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  input.log(`[playback] serving on 127.0.0.1:${port}`);
  return {
    urlFor: (fileId) => `http://127.0.0.1:${port}${prefix}${encodeURIComponent(fileId)}`,
    readUrlFor: (fileId) => `http://127.0.0.1:${port}${readPrefix}${encodeURIComponent(fileId)}`,
    coverUrlFor: (objectKey) => `http://127.0.0.1:${port}${coverPrefix}${encodeURIComponent(objectKey)}`,
    close: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    },
  };
};
