/**
 * The library op stream as every app reads it (LIB-OPS, LIB-FMT-07): the op list paging of `GET /library/db/ops` and
 * the payload of each op — inline (`payloadCiphertext`, the server's postgres copy) or downloaded by `objectKey`
 * through the storage tunnel, decrypted, unframed (v2 compressed frame, v1 plain JSON) and parsed. Used by the Badger
 * phone and the web players (@space/web-vault/opSync). Network and decrypt are passed in: no native import.
 */
import type { LibraryOpEntry, LibraryOpsResponse } from "@space/shared/contracts/library";
import { decodeCompressedFrame } from "@space/library-db-definition/payloadCompression";
import { deflateSync, inflateSync } from "fflate";
import type { DeflateCodec } from "@space/library-db-definition/payloadCompression";

/** Raw DEFLATE for storage format v2 (LIB-FMT-07), via fflate (pure JS, no native module). */
export const fflateCodec: DeflateCodec = {
  deflateRaw: (bytes) => deflateSync(bytes, { level: 6 }),
  inflateRaw: (bytes) => inflateSync(bytes),
};

/**
 * The API pages a long op tail (`hasMore`): `version` of a partial page is its last op and the next page starts
 * there. Walks every page and returns one response — all entries in order, `version` of the last page — so the
 * caller applies one batch and moves its cursor once. A page that turns `tooOld` is returned as is (the caller
 * falls back to the snapshot). `onPage` runs on every page after the first, before its ops are used (the op-stream
 * version gate).
 */
export const collectOpPages = async (
  first: LibraryOpsResponse,
  getPage: (sinceVersion: number) => Promise<LibraryOpsResponse>,
  onPage: (page: LibraryOpsResponse) => void
): Promise<LibraryOpsResponse> => {
  if (first.tooOld) return first;
  const ops = [...first.ops];
  let last = first;
  while (last.hasMore && last.ops.length > 0) {
    const page = await getPage(last.version);
    onPage(page);
    if (page.tooOld) return page;
    ops.push(...page.ops);
    last = page;
  }
  return { ...last, ops };
};

/** Longest a payload loop runs in one piece before yielding (a frame is ~16 ms, the UI budget 100 ms). */
export const OP_FETCH_SLICE_BUDGET_MS = 20;

/**
 * Inline payloads at least this long (base64 chars, ~24 KB) are opened by `openLarge` when given. Opening in JS costs
 * ~4 s per MB on a OnePlus 9 Pro, all of it one uninterruptible piece; below this size the in-thread path is cheaper
 * than a native round-trip.
 */
export const OP_OPEN_LARGE_MIN_BASE64 = 32 * 1024;

export type FetchOpPayloadsDeps = {
  download: (objectKey: string) => Promise<Uint8Array>;
  decrypt: (bytes: Uint8Array) => Promise<Uint8Array>;
  decode: (bytes: Uint8Array) => string;
  /** Opens a large inline payload (base64 envelope -> JSON text) off the JS thread (LIB-SYNC-14). */
  openLarge?: (payloadBase64: string) => Promise<string>;
  log?: (event: string, data: Record<string, unknown>) => void;
};

const DEFAULT_CONCURRENCY = 4;

/** A macrotask, not a microtask: lets the thread serve touches and frames between slices. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const decodeInlinePayload = (entry: Pick<LibraryOpEntry, "payloadCiphertext">): Uint8Array | null => {
  if (!entry.payloadCiphertext) return null;
  try {
    return Uint8Array.from(atob(entry.payloadCiphertext), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

export const fetchOpPayloads = async <Op = unknown>(
  ops: readonly LibraryOpEntry[],
  deps: FetchOpPayloadsDeps,
  concurrency = DEFAULT_CONCURRENCY
): Promise<Op[]> => {
  const out: Op[] = [];
  // Inline payloads can decrypt synchronously (native-JSI crypto on the phone), so awaiting them never reaches the
  // event loop: 2600 ops held the JS thread for 1.3 s on a OnePlus 6. Yield a macrotask once a slice's budget is spent.
  let sliceStartedAt = Date.now();
  for (let i = 0; i < ops.length; i += concurrency) {
    const batch = ops.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          const startedAt = Date.now();
          const inlineBase64 = entry.payloadCiphertext;
          let text: string;
          let source: string;
          if (deps.openLarge && inlineBase64 && inlineBase64.length >= OP_OPEN_LARGE_MIN_BASE64) {
            text = await deps.openLarge(inlineBase64);
            source = "native";
          } else {
            const inline = decodeInlinePayload(entry);
            const payload = inline ?? (await deps.download(entry.objectKey));
            const decrypted = await deps.decrypt(payload).catch(() => {
              throw new Error("DECRYPT_FAILED");
            });
            // v2 ops arrive as a compressed frame; v1 ops are plain JSON (LIB-FMT-07)
            text = deps.decode(decodeCompressedFrame(decrypted, fflateCodec));
            source = inline ? "inline" : "tunnel";
          }
          const openMs = Date.now() - startedAt;
          const parsed: unknown = JSON.parse(text);
          deps.log?.("library.ops.item", {
            id: entry.opId,
            type: parsed && typeof parsed === "object" && "type" in parsed ? parsed.type : undefined,
            version: entry.version,
            source,
            chars: text.length,
            openMs,
            parseMs: Date.now() - startedAt - openMs,
          });
          return parsed as Op;
        } catch (error) {
          deps.log?.("library.ops.parse.failed", {
            id: entry.opId,
            version: entry.version,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
    );
    out.push(...results);
    if (Date.now() - sliceStartedAt >= OP_FETCH_SLICE_BUDGET_MS) {
      await yieldToEventLoop();
      sliceStartedAt = Date.now();
    }
  }
  return out;
};
