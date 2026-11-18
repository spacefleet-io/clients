// Local copy of the play-time backdrop for mpv (#25 P5/B3).
//
// mpv shows the backdrop still while the stream loads, but it must open it as
// a LOCAL FILE: the bundled mpv has no https protocol (and gains nothing from
// one — every stream is served over 127.0.0.1 http). The renderer resolves the
// image through the metadata service (META-ART-02: artwork never comes from the
// catalog image CDN), which answers a base64 `data:` URI. The main process writes
// it to a file once, keyed by the URI, and hands mpv the path. It makes no
// network request. Anything that is not a small image data URI returns null and
// the launch falls back to an idle (black) window — never a slower start.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scopeLogger } from "./logger";

const logger = scopeLogger("mpv-backdrop-cache");

/** Metadata-service backdrops are ~100-400 KiB; anything far larger is not a backdrop. */
const MAX_BACKDROP_BYTES = 8 * 1024 * 1024;
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i;

export type MpvBackdropCacheOptions = {
  dir: string;
};

/**
 * Path of a local copy of the image in `dataUrl` (written now unless already cached), or null.
 * The file name is the URI hash plus the image type's extension, so mpv picks the demuxer by
 * extension and a re-play never rewrites it. The URI itself is never logged (it is the artwork
 * of a title).
 */
export const cacheMpvBackdrop = async (dataUrl: string, options: MpvBackdropCacheOptions): Promise<string | null> => {
  const startedAt = Date.now();
  const trimmed = dataUrl.trim();
  const match = DATA_URL_RE.exec(trimmed);
  if (!match) {
    logger.warn({ scheme: trimmed.slice(0, Math.max(0, trimmed.indexOf(":") + 1)) }, "backdrop is not a base64 data URI; launching idle");
    return null;
  }
  const type = match[1].trim().toLowerCase();
  const extension = EXTENSION_BY_TYPE[type];
  if (!extension) {
    logger.warn({ type }, "backdrop is not a supported image type; launching idle");
    return null;
  }
  const key = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  try {
    await fs.mkdir(options.dir, { recursive: true });
    const cached = (await fs.readdir(options.dir)).find((name) => name.startsWith(`${key}.`) && !name.endsWith(".part"));
    if (cached) {
      const file = path.join(options.dir, cached);
      logger.info({ file }, "backdrop cache hit");
      return file;
    }
    const body = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (body.length === 0 || body.length > MAX_BACKDROP_BYTES) {
      logger.warn({ bytes: body.length }, "backdrop: bad size; launching idle");
      return null;
    }
    const file = path.join(options.dir, `${key}${extension}`);
    const partial = `${file}.${process.pid}.part`;
    await fs.writeFile(partial, body);
    await fs.rename(partial, file);
    logger.info({ file, bytes: body.length, ms: Date.now() - startedAt }, "backdrop cached");
    return file;
  } catch (error) {
    logger.warn(
      { ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
      "backdrop cache failed; launching idle",
    );
    return null;
  }
};
