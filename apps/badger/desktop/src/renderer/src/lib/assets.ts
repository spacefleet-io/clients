import { downloadStorageObjectViaTunnel, uploadStorageObjectViaTunnel } from "@/api";
import { decryptBase64ToBytes, encryptBytesToBase64 } from "@/lib/crypto";
import type { ImageKind } from "@space/metadata-client";
import { AssetArtworkError } from "@/lib/assetArtworkError";
import { resolveArtwork } from "@/lib/metadataTickets";

const assetUrlCache = new Map<string, string>();
const assetPromiseCache = new Map<string, Promise<string>>();

export const clearAssetCaches = () => {
  for (const url of assetUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  assetUrlCache.clear();
  assetPromiseCache.clear();
};
const LEGACY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const guessContentType = (url: string) => {
  const lower = url.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
};

const normalizeContentType = (value: string) => value.split(";")[0]?.trim() || "application/octet-stream";

const buildAssetRef = (objectKey: string, contentType: string) =>
  `asset:${normalizeContentType(contentType)}::${objectKey}`;

const parseAssetRef = (value: string) => {
  if (value.startsWith("asset:")) {
    const payload = value.slice("asset:".length);
    const splitIndex = payload.indexOf("::");
    if (splitIndex > 0) {
      return {
        objectKey: payload.slice(splitIndex + 2),
        contentType: payload.slice(0, splitIndex),
        cacheKey: value,
      };
    }
  }

  const lower = value.toLowerCase();
  const contentType = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
    ? "image/webp"
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
    ? "image/jpeg"
    : "application/octet-stream";

  return { objectKey: value, contentType, cacheKey: value };
};

export const resolveAssetObjectKeyCandidates = (objectKey: string) => {
  const trimmed = objectKey.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  if (LEGACY_UUID_RE.test(trimmed)) {
    candidates.push(`assets/${trimmed}.txt`, `assets/${trimmed}`);
  }
  return candidates;
};

const uploadObjectViaTunnel = async (token: string, objectKey: string, payload: Uint8Array) => {
  return uploadStorageObjectViaTunnel(token, objectKey, payload, {
    clientType: "desktop",
    clientVersion: "desktop-renderer-assets",
    objectNamespace: "library",
    logicalRef: objectKey,
    counting: { role: "artwork" },
  });
};

const downloadObjectViaTunnel = async (token: string, objectKey: string) => {
  return downloadStorageObjectViaTunnel(token, objectKey, {
    clientType: "desktop",
    clientVersion: "desktop-renderer-assets",
    // Posters/backdrops of the user's own library: readable when unpaid (#145), exempt at saturation (STOR-BW-09).
    purpose: "library",
  });
};

/** Encrypts `bytes` with the library key and uploads them under a new `assets/<uuid>.txt`; returns the asset reference. */
export const uploadEncryptedAssetBytes = async (token: string, keyBase64: string, bytes: Uint8Array, contentType: string) => {
  const encryptedBase64 = await encryptBytesToBase64(keyBase64, bytes);
  const objectKey = `assets/${crypto.randomUUID()}.txt`;
  const persistedObjectKey = await uploadObjectViaTunnel(token, objectKey, new TextEncoder().encode(encryptedBase64));
  return buildAssetRef(persistedObjectKey, contentType);
};

const encryptAndUploadResponse = async (token: string, keyBase64: string, res: Response, guessFrom: string) => {
  if (!res.ok) {
    throw new Error("ASSET_FETCH_FAILED");
  }
  const contentType = res.headers.get("Content-Type") ?? guessContentType(guessFrom);
  return uploadEncryptedAssetBytes(token, keyBase64, new Uint8Array(await res.arrayBuffer()), contentType);
};

/** Uploads an image the user pointed at (their own URL). Looked-up artwork goes through `uploadEncryptedAssetFromMetadata`. */
export const uploadEncryptedAssetFromUrl = async (token: string, keyBase64: string, sourceUrl: string) =>
  encryptAndUploadResponse(token, keyBase64, await fetch(sourceUrl), sourceUrl);

/**
 * Uploads artwork fetched from the metadata service (META-ART-02: never from the TMDB image CDN). The service's
 * answer is a `data:` URI, read back here as bytes; one
 * ticket is spent unless the image is already cached. Throws `AssetArtworkError` when there is no image to upload.
 */
export const uploadEncryptedAssetFromMetadata = async (
  token: string,
  keyBase64: string,
  kind: ImageKind,
  path: string
) => {
  const outcome = await resolveArtwork(kind, path);
  if (outcome.status !== "ok") {
    throw new AssetArtworkError(outcome.status, outcome.status === "rate_limited" ? outcome.retryAfterMs : undefined);
  }
  return encryptAndUploadResponse(token, keyBase64, await fetch(outcome.url), path);
};

export const uploadEncryptedAssetFromFile = async (token: string, keyBase64: string, file: File) =>
  uploadEncryptedAssetBytes(token, keyBase64, new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream");

export const getDecryptedAssetUrl = async (token: string, keyBase64: string, assetRef: string) => {
  const { objectKey, contentType, cacheKey } = parseAssetRef(assetRef);
  if (assetUrlCache.has(cacheKey)) {
    return assetUrlCache.get(cacheKey) ?? null;
  }
  if (assetPromiseCache.has(cacheKey)) {
    return assetPromiseCache.get(cacheKey) ?? null;
  }

  const task = (async () => {
    let encryptedBytes: Uint8Array | null = null;
    const candidates = resolveAssetObjectKeyCandidates(objectKey);
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        encryptedBytes = await downloadObjectViaTunnel(token, candidate);
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "download_source_missing") {
          throw error;
        }
      }
    }
    if (!encryptedBytes) {
      throw lastError instanceof Error ? lastError : new Error("download_source_missing");
    }
    const payloadBase64 = new TextDecoder().decode(encryptedBytes);
    const decrypted = await decryptBase64ToBytes(keyBase64, payloadBase64);
    const blob = new Blob([decrypted], { type: normalizeContentType(contentType) });
    const url = URL.createObjectURL(blob);
    assetUrlCache.set(cacheKey, url);
    return url;
  })();

  assetPromiseCache.set(cacheKey, task);
  try {
    const url = await task;
    assetPromiseCache.delete(cacheKey);
    return url;
  } catch (error) {
    assetPromiseCache.delete(cacheKey);
    throw error;
  }
};

export const isAssetKey = (value: string | null) => {
  if (!value) return false;
  return value.startsWith("asset:") || value.startsWith("assets/");
};

export const extractAssetObjectKey = (value: string | null) => {
  if (!value) return null;
  const { objectKey } = parseAssetRef(value);
  return objectKey || null;
};
