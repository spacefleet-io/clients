import {
  buildMediaObjectKey,
  buildShardedObjectKey,
  MEDIA_PLACEMENT_PREFIX,
  parseMediaPlacementIdFromObjectKey,
  pickPlacementShard,
  STORAGE_SHARD_PREFIX,
  type MediaPlacement,
  type StoragePlacementPolicy,
} from "./storagePlacement";
import { DEFAULT_SPACE_APP_ID, normalizeSpaceAppId, SPACE_APP_HEADER, type SpaceAppId } from "./appScope";
import type { StorageObjectCounting } from "./storageCounting";
import { clientIdentityHeaders } from "./appVersion";
import {
  PLAYBACK_PROFILE_FIELD,
  PLAYBACK_PROFILE_NOT_OWNED_CODE,
  PLAYBACK_PROFILE_REQUIRED_CODE,
  readProfileId,
  sessionNeedsProfile,
} from "./playbackProfile";

// Transport helpers exported from this module but not from the package index are shared with the service
// tunnel client on the server side; they are not public API.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
// Bun types `onerror` with ErrorEvent, the DOM and React Native with Event: declared as a method so both fit.
type WsLike = {
  onopen: ((event: Event) => void) | null;
  onerror: { handler(event: Event): void }["handler"] | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send: (data: string | Uint8Array<ArrayBuffer> | ArrayBuffer) => void;
  close: () => void;
};
type WsCtor = new (url: string) => WsLike;

export type TunnelClientFrame = Record<string, unknown>;
export type TunnelGatewayFrame = Record<string, unknown>;

/**
 * Why a tunnel session is opened (#145 unpaid access). The gateway/API refuse
 * `playback` and `upload` for an unpaid account (402 `subscription_unpaid`) but
 * allow `export` (offline downloads, exports to standard files), `library`
 * (library data sync, artwork/images) and `reseal` (downloads the media and
 * uploads only re-sealed copies during a media library key change,
 * STOR-RESEAL-03) at free QoS. Omitted = `playback`.
 */
export type StorageTunnelPurpose = "playback" | "export" | "upload" | "library" | "reseal";

/** The highest quality an account's plan may play while its silo is saturated (PLAY-QUAL-07). */
export type StorageQualityCap = "480p" | "1080p";

/**
 * What one gateway (one silo, one link) reports with every session response and `session.ack`, on `GET /storage/traffic`, and
 * with a refusal or a stop:
 * - `state` / `playbackBufferSeconds` (STOR-BW-01): `high` while the silo's link is busy or saturated; the playback look-ahead the
 *   client keeps meanwhile (`null` when normal). The only part merged across silos ("any silo high").
 * - `saturated`, `qualityCap`, `playbackStopped` (STOR-BW-07..09, PLAY-QUAL-07) are PER SILO and never merged: the silo is saturated;
 *   the quality cap of this account while it is (`null` = none); this viewer's playback was stopped on this silo.
 * A gateway that does not know the per-silo fields reads as not saturated, no cap, not stopped.
 */
export type StorageTraffic = {
  state: "normal" | "high";
  playbackBufferSeconds: number | null;
  saturated: boolean;
  qualityCap: StorageQualityCap | null;
  playbackStopped: boolean;
};

/** What a client knows about the load across its gateways: "any silo high"; `observedAt` null = nothing heard yet. */
export type StorageTrafficSnapshot = {
  state: "normal" | "high";
  playbackBufferSeconds: number | null;
  observedAt: number | null;
};

/** A gateway's traffic report is trusted for this long without a fresher ack (acks arrive with every session). */
export const STORAGE_TRAFFIC_STATE_TTL_MS = 5 * 60_000;
/** `GET /storage/traffic` is polled at most this often per silo. */
export const STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS = 60_000;

/** The error code of a 503 on a session request: the silo is saturated and a new free playback session is refused (STOR-BW-07). */
export const STORAGE_FREE_PLAYBACK_REFUSED_CODE = "free_playback_refused";
/** The error code of a stopped viewer's download (STOR-BW-08): `download.error` code, or the 503 of the HTTP fast path. */
export const STORAGE_PLAYBACK_STOPPED_CODE = "playback_stopped";

/** Reads the wire `traffic` object; anything that is not a known state yields null (old gateways send none). */
export const parseStorageTraffic = (value: unknown): StorageTraffic | null => {
  if (!value || typeof value !== "object") return null;
  const state = "state" in value ? value.state : undefined;
  if (state !== "normal" && state !== "high") return null;
  const seconds = "playbackBufferSeconds" in value ? value.playbackBufferSeconds : undefined;
  return {
    state,
    playbackBufferSeconds:
      state === "high" && typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
    saturated: "saturated" in value && value.saturated === true,
    qualityCap: "qualityCap" in value && (value.qualityCap === "480p" || value.qualityCap === "1080p") ? value.qualityCap : null,
    playbackStopped: "playbackStopped" in value && value.playbackStopped === true,
  };
};

/** True for the 503 that refuses a new free playback session while the silo is saturated (STOR-BW-07). */
export const isFreePlaybackRefusedError = (error: unknown): boolean =>
  error instanceof StorageTunnelError && error.status === 503 && error.code === STORAGE_FREE_PLAYBACK_REFUSED_CODE;

/** True when a download ended because the viewer was stopped at saturation (STOR-BW-08); it stays refused until the silo lifts. */
export const isPlaybackStoppedError = (error: unknown): boolean =>
  error instanceof StorageTunnelError && error.status === 503 && error.code === STORAGE_PLAYBACK_STOPPED_CODE;

/** The silo's report a refusal or a stop carries (`error.payload.traffic`), null when absent or malformed. */
export const storageTrafficFromError = (error: unknown): StorageTraffic | null =>
  error instanceof StorageTunnelError ? parseStorageTraffic(error.payload.traffic) : null;

/** A refusal that no other gateway address would answer differently: the waterfall stops there. */
const isFinalSessionRefusal = (error: unknown) =>
  (error instanceof StorageTunnelError &&
    (error.status === 402 || error.code === PLAYBACK_PROFILE_REQUIRED_CODE || error.code === PLAYBACK_PROFILE_NOT_OWNED_CODE)) ||
  isFreePlaybackRefusedError(error);

/** The error of a `download.error` frame: a stopped viewer gets the typed 503 with the silo's report, anything else the generic one. */
export const errorFromDownloadFrame = (frame: TunnelGatewayFrame): Error => {
  const code = String(frame.code ?? "unknown");
  if (code !== STORAGE_PLAYBACK_STOPPED_CODE) return new Error(`TUNNEL_DOWNLOAD_ERROR_${code}`);
  const traffic = frame.traffic;
  return new StorageTunnelError(503, { error: STORAGE_PLAYBACK_STOPPED_CODE, ...(traffic === undefined ? {} : { traffic }) });
};

/**
 * Optional playback hints for the gateway's per-viewer scheduler (all server-side
 * enforced; a client that omits them is served with the server's defaults).
 * `getBufferedMs` is read at each ack/credit so it follows the live buffer.
 * `onTraffic` receives the report of THIS session's silo when the session opens, on every
 * `session.ack`, and when the session is refused or stopped.
 */
export type StorageDownloadHints = {
  getBufferedMs?: () => number | null | undefined;
  playbackBps?: number;
  /** Only on the first objects of a playback (`start`) or right after a seek (`seek`). */
  burst?: "start" | "seek";
  onTraffic?: (traffic: StorageTraffic) => void;
};

const buildDownloadHintFields = (hints: StorageDownloadHints | undefined, withBurst: boolean) => {
  const fields: { bufferedMs?: number; playbackBps?: number; burst?: "start" | "seek" } = {};
  if (!hints) return fields;
  const bufferedMs = hints.getBufferedMs?.();
  if (typeof bufferedMs === "number" && Number.isFinite(bufferedMs) && bufferedMs >= 0) {
    fields.bufferedMs = Math.round(bufferedMs);
  }
  const playbackBps = hints.playbackBps;
  if (typeof playbackBps === "number" && Number.isFinite(playbackBps) && playbackBps > 0) {
    fields.playbackBps = Math.round(playbackBps);
  }
  if (withBurst && (hints.burst === "start" || hints.burst === "seek")) fields.burst = hints.burst;
  return fields;
};

export type StorageTunnelSession = {
  sessionId: string;
  protocolVersion: 1;
  createdAt: number;
  expiresAt: number;
  qosTier?: "free" | "paid";
  shardId?: string;
  placementEpoch?: number;
  resolvedObjectKey?: string | null;
  objectKeyPrefix?: string;
  features?: {
    upload?: boolean;
    download?: boolean;
  };
  /** Current load of the gateway that opened the session; absent on gateways that predate STOR-BW-01. */
  traffic?: StorageTraffic;
};

export class StorageTunnelError extends Error {
  status: number;
  code: string;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    const code = typeof payload.error === "string" ? payload.error : "storage_tunnel_error";
    super(code);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export type StorageMediaPlacementErrorCode =
  | "placement_silo_unavailable"
  | "no_storage_capacity"
  | "placement_not_found"
  | "placement_moving";

const PLACEMENT_MOVING_CODE = "placement_moving";

// Waits between upload retries while a media move copies the placement (#145
// step 3): 5 retries over ~2 minutes.
const PLACEMENT_MOVING_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 45_000];

const frameMessage = (frame: TunnelGatewayFrame): string => {
  const message = (frame as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
};

/**
 * A media placement could not be used: its silo is down (503
 * placement_silo_unavailable), no silo is online to take a new media (503
 * no_storage_capacity; fill never causes it), the placement is unknown to the caller (404), or a
 * move is copying it so new writes are refused (409 placement_moving; the
 * client retries those before surfacing it).
 */
export class StorageMediaPlacementError extends StorageTunnelError {
  override code: StorageMediaPlacementErrorCode;
  readonly placementId: string;

  constructor(
    status: number,
    code: StorageMediaPlacementErrorCode,
    placementId: string,
    payload: Record<string, unknown> = {}
  ) {
    super(status, { ...payload, error: code, placementId });
    this.code = code;
    this.placementId = placementId;
  }
}

// Error codes fetch/sockets raise when the gateway is down or drops the
// connection: Bun (`ConnectionRefused`, `ConnectionClosed`), Node/undici
// (`ECONN*`, `UND_ERR_*`; undici nests it under `cause`).
const TRANSIENT_NETWORK_ERROR_CODES: Record<string, true> = {
  ConnectionRefused: true,
  ConnectionClosed: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EPIPE: true,
  UND_ERR_SOCKET: true,
  UND_ERR_CONNECT_TIMEOUT: true,
};
const TRANSIENT_NETWORK_ERROR_MESSAGE =
  /unable to connect|socket connection was closed unexpectedly|fetch failed|econnrefused|econnreset|socket hang up|^ws_closed$/i;

/** True when `value` is an object whose `code` is a transient network error code. */
const hasTransientNetworkCode = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof value.code === "string" &&
  TRANSIENT_NETWORK_ERROR_CODES[value.code] === true;

/**
 * True when a storage-tunnel failure is a transient gateway outage (restart,
 * roll, crash) that an idempotent operation can retry: a network-level fetch
 * failure, a 5xx, or the 404 `invalid_session` a restarted gateway answers
 * for a session it no longer knows. Everything else — 4xx, quota, decrypt
 * and integrity errors — is permanent.
 */
export const isTransientStorageTransportError = (err: unknown): boolean => {
  if (err instanceof StorageTunnelError) {
    return err.status >= 500 || (err.status === 404 && err.code === "invalid_session");
  }
  if (!(err instanceof Error)) return false;
  return (
    hasTransientNetworkCode(err) ||
    hasTransientNetworkCode(err.cause) ||
    TRANSIENT_NETWORK_ERROR_MESSAGE.test(err.message)
  );
};

export const bytesToBase64 = (value: Uint8Array) => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < value.length; i += 1) binary += String.fromCharCode(value[i] ?? 0);
  return btoa(binary);
};

const WS_BINARY_MAGIC = "SFV1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const encodeWsBinaryEnvelope = (frame: TunnelClientFrame | TunnelGatewayFrame): Uint8Array<ArrayBuffer> | null => {
  if (!frame || typeof frame !== "object") return null;
  const record = frame as Record<string, unknown>;
  if (!(record.ciphertext instanceof Uint8Array)) return null;
  const metadata = {
    frame: {
      ...record,
      ciphertextLength: record.ciphertext.byteLength,
    },
  };
  delete (metadata.frame as Record<string, unknown>).ciphertext;
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const out = new Uint8Array(8 + metadataBytes.byteLength + record.ciphertext.byteLength);
  out[0] = WS_BINARY_MAGIC.charCodeAt(0);
  out[1] = WS_BINARY_MAGIC.charCodeAt(1);
  out[2] = WS_BINARY_MAGIC.charCodeAt(2);
  out[3] = WS_BINARY_MAGIC.charCodeAt(3);
  const view = new DataView(out.buffer);
  view.setUint32(4, metadataBytes.byteLength, false);
  out.set(metadataBytes, 8);
  out.set(record.ciphertext, 8 + metadataBytes.byteLength);
  return out;
};

const parseWsBinaryEnvelope = (data: unknown): { frame: TunnelGatewayFrame } | null => {
  let payload: Uint8Array | null = null;
  if (data instanceof Uint8Array) payload = data;
  else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) payload = new Uint8Array(data);
  else if (data instanceof ArrayBuffer) payload = new Uint8Array(data);
  if (!payload || payload.byteLength < 8) return null;
  if (payload[0] !== 83 || payload[1] !== 70 || payload[2] !== 86 || payload[3] !== 49) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metadataLength = view.getUint32(4, false);
  const metadataStart = 8;
  const metadataEnd = metadataStart + metadataLength;
  if (metadataEnd > payload.byteLength) return null;
  const metadataText = textDecoder.decode(payload.subarray(metadataStart, metadataEnd));
  const parsed = JSON.parse(metadataText) as { frame?: Record<string, unknown> };
  if (!parsed.frame || typeof parsed.frame !== "object") return null;
  const ciphertext = payload.subarray(metadataEnd);
  const expectedLength = Number(parsed.frame.ciphertextLength ?? ciphertext.byteLength);
  if (!Number.isFinite(expectedLength) || expectedLength !== ciphertext.byteLength) return null;
  return {
    frame: {
      ...parsed.frame,
      ciphertext: new Uint8Array(ciphertext),
    },
  };
};

export const parseCiphertextBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
  if (typeof value === "string") {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((entry) => Number(entry) & 0xff));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      return Uint8Array.from(record.data.map((entry) => Number(entry) & 0xff));
    }
    const numericKeys = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      return Uint8Array.from(numericKeys.map((key) => Number(record[key]) & 0xff));
    }
  }
  return new Uint8Array();
};

export const appendChunk = (target: Uint8Array, offset: number, chunk: Uint8Array) => {
  target.set(chunk, offset);
  return offset + chunk.byteLength;
};

const bytesToHex = (value: Uint8Array) => [...value].map((entry) => entry.toString(16).padStart(2, "0")).join("");

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;

const sha256Hex = async (value: Uint8Array) => {
  const cryptoImpl = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoImpl?.subtle) throw new Error("CRYPTO_UNAVAILABLE");
  const digest = await cryptoImpl.subtle.digest("SHA-256", toArrayBuffer(value));
  return bytesToHex(new Uint8Array(digest));
};

export const buildChecksum = async (value: Uint8Array) => `sha256:${await sha256Hex(value)}`;

export const verifyChecksum = async (value: Uint8Array, checksum: unknown) => {
  const normalized = String(checksum ?? "").trim().toLowerCase();
  if (!normalized.startsWith("sha256:")) return false;
  const digest = normalized.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  return (await sha256Hex(value)) === digest;
};

const normalizeOutgoingChecksum = (value: string) => {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(trimmed)) return `sha256:${trimmed}`;
  return trimmed;
};

export const normalizeOutgoingFrame = (frame: TunnelClientFrame): TunnelClientFrame => {
  if (!frame || typeof frame !== "object") return frame;
  if (String(frame.kind ?? "") !== "upload.data") return frame;
  const checksum = (frame as Record<string, unknown>).checksum;
  if (typeof checksum !== "string") return frame;
  const normalized = normalizeOutgoingChecksum(checksum);
  if (normalized === checksum) return frame;
  return {
    ...(frame as Record<string, unknown>),
    checksum: normalized,
  };
};

export const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const DEFAULT_WS_UPLOAD_WINDOW = 8;
const DEFAULT_DOWNLOAD_WINDOW = 32;
const DOWNLOAD_WS_READ_TIMEOUT_MS = 5000;
const CONTROL_FRAME_TIMEOUT_MS = 5000;

export const resolveUploadWindow = (requested: number | undefined, defaultWindow: number) => {
  const candidate = Number.isFinite(requested) ? Number(requested) : defaultWindow;
  return Math.max(1, Math.floor(candidate));
};

export const resolveDownloadWindow = (requested: number | undefined) => {
  const candidate = Number.isFinite(requested) ? Number(requested) : DEFAULT_DOWNLOAD_WINDOW;
  return Math.max(1, Math.floor(candidate));
};

const assertUploadAckFrame = (ack: TunnelGatewayFrame) => {
  if (String(ack.kind ?? "") === "upload.ack") return;
  const errorCode = String((ack as Record<string, unknown>).error ?? "unknown");
  throw new Error(`TUNNEL_UPLOAD_ACK_FAILED:${errorCode}`);
};

/** A re-sealed copy (STOR-RESEAL-03): the media reseal run it belongs to and the old object it replaces at the switch. */
export type StorageResealCopy = { runId: string; of: string };

/** Per-object options of an upload on a reused session; the placement and client are the session's. */
export type StorageUploadSessionObjectOptions = {
  objectNamespace?: string;
  logicalRef?: string;
  contentType?: string;
  chunkSize?: number;
  uploadWindow?: number;
  uploadId?: string;
  counting?: StorageObjectCounting;
};

/** A reused upload session of one media placement (STOR-REUSE-01); `upload` returns the stored key. */
export type StorageUploadSession = {
  upload(objectKey: string, payload: Uint8Array | TunnelUploadSource, options?: StorageUploadSessionObjectOptions): Promise<string>;
  /** Waits for the queued uploads, then ends the session. */
  close(): Promise<void>;
};

/** Per-object options of a download on a reused session; the purpose, profile and client are the session's. */
export type StorageDownloadSessionObjectOptions = {
  downloadId?: string;
  receiveWindow?: number;
};

/**
 * A reused download session of one media placement (STOR-REUSE-02): `download` returns the object's stored (sealed)
 * bytes. Downloads on one handle run one after another; open several handles to run them side by side.
 */
export type StorageDownloadSession = {
  download(objectKey: string, options?: StorageDownloadSessionObjectOptions): Promise<Uint8Array>;
  /** Waits for the queued downloads, then ends the session. */
  close(): Promise<void>;
};

/**
 * An upload payload that never sits in JS memory (a file slice on a phone). Moving bytes through Hermes is
 * slow (base64 decode of 64 KB ~50 ms, WebSocket.send of 128 KB ~100 ms on a OnePlus 6), so a host that can
 * read, hash and frame a slice natively passes one of these instead of a `Uint8Array`.
 */
export type TunnelUploadSource = {
  byteLength: number;
  /** Plain bytes of one range; used when the tunnel has to fall back to HTTP frames. */
  read: (offset: number, length: number) => Promise<Uint8Array>;
  /** The finished binary WebSocket `upload.data` message for one range (checksum included). */
  buildWsMessage: (frame: {
    uploadId: string;
    seq: number;
    offset: number;
    length: number;
  }) => Promise<{ message: Blob; release: () => void }>;
};

/**
 * What one `uploadObject` call carries from attempt to attempt: the id the gateway gave the multipart upload (`resumeId`
 * of its `upload.progress` answer) and how many resumes are left.
 */
type UploadResumeState = { resumeId: string | null; resumesLeft: number };

/** Waits before each resume of an interrupted upload (a gateway restart or drain, a dropped connection); its length is the resume budget. */
const UPLOAD_RESUME_RETRY_DELAYS_MS = [250, 1_000, 3_000, 8_000, 15_000] as const;
/** A reused upload or download session is renewed past this age, well inside the gateway's 10-minute session TTL. */
const REUSED_SESSION_RENEW_MS = 4 * 60_000;

export const streamUploadFrames = async (input: {
  byteLength: number;
  /** Byte to start at (a resumed upload); sequence numbers still start at 0 on the new upload. */
  startOffset?: number;
  chunkSize: number;
  uploadWindow: number;
  sendChunk: (range: { offset: number; length: number }, seq: number) => Promise<TunnelGatewayFrame>;
  onInFlightChange?: (size: number) => void;
}) => {
  const inFlight = new Set<Promise<void>>();
  const payloadBytes = input.byteLength;
  let offset = input.startOffset ?? 0;
  let seq = 0;
  // The first refused frame (STOR-UPLOAD-07): kept here because a frame that settles while the loop waits on another one
  // leaves `inFlight` before the next race, so the race alone would never see its rejection.
  let failure: { error: unknown } | null = null;

  while ((offset < payloadBytes && !failure) || inFlight.size > 0) {
    while (offset < payloadBytes && !failure && inFlight.size < input.uploadWindow) {
      const currentSeq = seq;
      const range = { offset, length: Math.min(payloadBytes, offset + input.chunkSize) - offset };
      offset += input.chunkSize;
      seq += 1;

      const op = input
        .sendChunk(range, currentSeq)
        .then((ack) => {
          assertUploadAckFrame(ack);
        })
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => {
          inFlight.delete(op);
          input.onInFlightChange?.(inFlight.size);
        });
      inFlight.add(op);
      input.onInFlightChange?.(inFlight.size);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }
  if (failure) throw (failure as { error: unknown }).error;
};

export const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

/** Keys per POST /storage/head request (the API's and the gateway's cap). */
export const STORAGE_HEAD_BATCH_KEYS = 500;

const getWsEndpoint = (gatewayBaseUrl: string) => {
  const url = new URL(gatewayBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/storage/tunnel/ws";
  url.search = "";
  return url.toString();
};

export const readJsonResponse = async <T>(res: Response): Promise<T> => {
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new StorageTunnelError(res.status, payload);
  }
  return payload as T;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), Math.max(1, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const getBearerHeaders = (token: string, appId: SpaceAppId) => ({
  Authorization: `Bearer ${token}`,
  [SPACE_APP_HEADER]: appId,
  ...clientIdentityHeaders(),
  "Content-Type": "application/json",
});


type PendingFrameRead = {
  resolve: (frame: TunnelGatewayFrame) => void;
  reject: (error: Error) => void;
};

const isArrayBufferLike = (value: unknown): value is ArrayBuffer =>
  typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;

const isBlobLike = (value: unknown): value is { arrayBuffer: () => Promise<ArrayBuffer> } =>
  Boolean(value) &&
  typeof value === "object" &&
  "arrayBuffer" in (value as Record<string, unknown>) &&
  typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function";

const parseWsMessagePayload = async (data: unknown): Promise<{ frame: TunnelGatewayFrame } | null> => {
  const binaryParsed = parseWsBinaryEnvelope(data);
  if (binaryParsed) return binaryParsed;

  let raw = "";
  if (typeof data === "string") {
    raw = data;
  } else if (data instanceof Uint8Array) {
    raw = textDecoder.decode(data);
  } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    raw = Buffer.from(data).toString("utf8");
  } else if (isArrayBufferLike(data)) {
    raw = textDecoder.decode(new Uint8Array(data));
  } else if (isBlobLike(data)) {
    const buffer = await data.arrayBuffer();
    const parsed = parseWsBinaryEnvelope(buffer);
    if (parsed) return parsed;
    raw = textDecoder.decode(new Uint8Array(buffer));
  } else {
    raw = String(data ?? "");
  }

  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    const message = String((parsed as { error?: unknown }).error ?? "ws_error");
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== "object" || !("frame" in (parsed as Record<string, unknown>))) {
    throw new Error("ws_invalid_frame");
  }
  return { frame: (parsed as { frame: TunnelGatewayFrame }).frame };
};

const createWsConnection = async (input: {
  wsEndpoint: string;
  token: string;
  sessionId: string;
  WebSocketImpl?: WsCtor;
}): Promise<{
  sendFrame: (frame: TunnelClientFrame) => Promise<TunnelGatewayFrame>;
  sendMessage: (message: Blob) => Promise<TunnelGatewayFrame>;
  sendOnly: (frame: TunnelClientFrame) => void;
  readFrame: () => Promise<TunnelGatewayFrame>;
  close: () => void;
}> => {
  const WebSocketImpl: WsCtor = input.WebSocketImpl ?? WebSocket;
  const wsUrl = new URL(input.wsEndpoint);
  wsUrl.searchParams.set("token", input.token);
  wsUrl.searchParams.set("sessionId", input.sessionId);

  const ws = new WebSocketImpl(wsUrl.toString());
  let open = false;
  let closed = false;
  let terminalError: Error | null = null;
  const pendingReads: PendingFrameRead[] = [];
  const inbox: TunnelGatewayFrame[] = [];

  const failPendingReads = (error: Error) => {
    while (pendingReads.length > 0) {
      pendingReads.shift()?.reject(error);
    }
  };

  const pushFrame = (frame: TunnelGatewayFrame) => {
    const next = pendingReads.shift();
    if (next) {
      next.resolve(frame);
      return;
    }
    inbox.push(frame);
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      open = true;
      resolve();
    };
    ws.onerror = () => reject(new Error("ws_connect_failed"));
    ws.onclose = () => {
      closed = true;
      if (!open) reject(new Error("ws_connect_closed"));
    };
  });

  ws.onmessage = (event) => {
    void (async () => {
      try {
        const parsed = await parseWsMessagePayload(event.data);
        if (!parsed) {
          terminalError = new Error("ws_invalid_frame");
          failPendingReads(terminalError);
          return;
        }
        pushFrame(parsed.frame);
      } catch (error) {
        const code = error instanceof Error ? error.message : "ws_invalid_json";
        terminalError = new Error(code || "ws_invalid_json");
        failPendingReads(terminalError);
      }
    })();
  };

  ws.onclose = () => {
    open = false;
    closed = true;
    terminalError = terminalError ?? new Error("ws_closed");
    failPendingReads(terminalError);
  };
  ws.onerror = () => {
    terminalError = terminalError ?? new Error("ws_error");
    failPendingReads(terminalError);
  };

  const readFrame = () => {
    if (terminalError) return Promise.reject(terminalError);
    if (inbox.length > 0) {
      return Promise.resolve(inbox.shift() as TunnelGatewayFrame);
    }
    if (!open || closed) return Promise.reject(new Error("ws_not_open"));
    return new Promise<TunnelGatewayFrame>((resolve, reject) => {
      pendingReads.push({ resolve, reject });
    });
  };

  return {
    sendFrame(frame: TunnelClientFrame) {
      if (!open || closed) return Promise.reject(new Error("ws_not_open"));
      const binary = encodeWsBinaryEnvelope(frame);
      if (binary) ws.send(binary);
      else ws.send(JSON.stringify({ frame }));
      return readFrame();
    },
    /**
     * Sends a message the caller already encoded (a native blob) and waits for the reply frame. React
     * Native's WebSocket.send accepts a Blob and streams it natively, but the DOM/Bun typings do not.
     */
    sendMessage(message: Blob) {
      if (!open || closed) return Promise.reject(new Error("ws_not_open"));
      ws.send(message as unknown as ArrayBuffer);
      return readFrame();
    },
    sendOnly(frame: TunnelClientFrame) {
      if (!open || closed) throw new Error("ws_not_open");
      const binary = encodeWsBinaryEnvelope(frame);
      if (binary) ws.send(binary);
      else ws.send(JSON.stringify({ frame }));
    },
    readFrame() {
      return readFrame();
    },
    close() {
      ws.close();
    },
  };
};

export const createUserStorageTunnelClient = (input: {
  getApiBaseUrl: () => string;
  getAppId?: () => string | null | undefined;
  fetchImpl?: FetchLike;
  WebSocketImpl?: WsCtor;
  preferWebSocket?: boolean;
  preferWsDownloadStream?: boolean;
  tunnelMode?: "direct" | "waterfall";
  waterfallTimeoutMs?: number;
  placementCacheTtlMs?: number;
  /**
   * Waits between retries of a session open that reached a gateway copy which just went away (502/503/network
   * error, STOR-GATEWAY-01); each retry asks the API for a fresh placement first. Default: 3 retries over ~4 s.
   */
  sessionOpenRetryDelaysMs?: readonly number[];
  /**
   * Waits between retries of an upload refused with 409 `placement_moving`
   * (one retry per entry). Default: 5 retries over ~2 minutes.
   */
  placementMovingRetryDelaysMs?: readonly number[];
  onUploadPerf?: (event: string, payload: Record<string, unknown>) => void;
  onDownloadPerf?: (event: string, payload: Record<string, unknown>) => void;
  log?: (event: string, payload: Record<string, unknown>) => void;
  /**
   * Called when the merged traffic state ("any silo high": state and playback buffer length) changes from what the
   * listener last heard: after a session response, a `session.ack` or a `GET /storage/traffic`, and
   * when a report ages past the TTL and the state is next read. Per-silo reports (saturation, quality cap, stop)
   * are not part of it: they go to `StorageDownloadHints.onTraffic` and `refreshTraffic`.
   */
  onTrafficChange?: (snapshot: StorageTrafficSnapshot) => void;
  /** Minimum gap between `GET /storage/traffic` polls per silo. Default 60 s. */
  trafficRefreshMinIntervalMs?: number;
  /**
   * The profile this client plays for (STOR-BW-11): the main profile's real id on a single-profile account, never null once a
   * profile is picked. Sent with every playback session and traffic poll; a playback session without one (none here and none
   * passed per call) is refused before any request with `profile_required`.
   */
  getProfileId?: () => string | null | undefined;
}) => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tunnelLog = input.log ?? (() => {});
  const placementMovingRetryDelaysMs = input.placementMovingRetryDelaysMs ?? PLACEMENT_MOVING_RETRY_DELAYS_MS;
  const isWaterfall = input.tunnelMode === "waterfall";
  // Waterfall mode can use WS for each gateway attempt — RN supports binary WS natively.
  const wsEnabled = input.preferWebSocket !== false;
  const waterfallTimeoutMs = input.waterfallTimeoutMs ?? 3000;
  const waterfallWinnerCache = new Map<string, { url: string; expiresAt: number }>();
  const placementCacheByToken = new Map<string, { expiresAt: number; policy: StoragePlacementPolicy }>();
  // Media placements (#145): placementId → silo, keyed per token. Shared by the
  // upload (POST /storage/placement/media) and read (…/media/resolve) paths.
  const mediaPlacementCache = new Map<string, { expiresAt: number; placement: MediaPlacement }>();
  // In-flight placement requests, so concurrent uploads/reads of one media share
  // a request. Resolve: `undefined` = the endpoint did not return that id.
  const mediaPlacementAcquireInflight = new Map<string, Promise<MediaPlacement>>();
  const mediaPlacementResolveInflight = new Map<string, Promise<MediaPlacement | null | undefined>>();
  const sessionGatewayById = new Map<string, string>();
  // `hints.onTraffic` of the download that owns the session.
  const sessionTrafficListenerById = new Map<string, (traffic: StorageTraffic) => void>();
  // Latest load reported by each silo (session responses, session.ack, refusals, GET /storage/traffic). Keyed by the
  // gateway's base URL, so silos never overwrite each other.
  const trafficByGateway = new Map<string, { traffic: StorageTraffic; observedAt: number }>();
  const trafficRefreshes = new Map<string, { at: number }>();
  const trafficRefreshMinIntervalMs = input.trafficRefreshMinIntervalMs ?? STORAGE_TRAFFIC_REFRESH_MIN_INTERVAL_MS;

  // The merged view is "any silo high" (a user can have media on several silos and the buffer cap is the shortest of
  // them); a report older than the TTL no longer counts. Saturation, quality cap and stop are per silo and not part of it.
  const computeTraffic = (): StorageTrafficSnapshot => {
    const now = Date.now();
    let high = false;
    let playbackBufferSeconds: number | null = null;
    let observedAt: number | null = null;
    for (const [gateway, entry] of trafficByGateway) {
      if (now - entry.observedAt > STORAGE_TRAFFIC_STATE_TTL_MS) {
        trafficByGateway.delete(gateway);
        continue;
      }
      observedAt = Math.max(observedAt ?? 0, entry.observedAt);
      if (entry.traffic.state !== "high") continue;
      high = true;
      const seconds = entry.traffic.playbackBufferSeconds;
      if (seconds !== null) playbackBufferSeconds = playbackBufferSeconds === null ? seconds : Math.min(playbackBufferSeconds, seconds);
    }
    return { state: high ? "high" : "normal", playbackBufferSeconds: high ? playbackBufferSeconds : null, observedAt };
  };

  // What `onTrafficChange` last heard. A TTL expiry changes the effective state without any report, so
  // changes are detected against this, not against the view just before a report.
  let lastEmitted: Omit<StorageTrafficSnapshot, "observedAt"> = { state: "normal", playbackBufferSeconds: null };

  const readTraffic = (): StorageTrafficSnapshot => {
    const snapshot = computeTraffic();
    if (lastEmitted.state === snapshot.state && lastEmitted.playbackBufferSeconds === snapshot.playbackBufferSeconds) {
      return snapshot;
    }
    lastEmitted = { state: snapshot.state, playbackBufferSeconds: snapshot.playbackBufferSeconds };
    tunnelLog("tunnel.traffic.changed", { state: snapshot.state, playbackBufferSeconds: snapshot.playbackBufferSeconds });
    try {
      input.onTrafficChange?.(snapshot);
    } catch (error) {
      tunnelLog("tunnel.traffic.listener_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return snapshot;
  };

  // One silo's report, `null` when unknown or older than the TTL (a stale saturation or stop fails open).
  const readSiloTraffic = (trafficKey: string | null): StorageTraffic | null => {
    const entry = trafficKey ? trafficByGateway.get(trafficKey) : undefined;
    return entry && Date.now() - entry.observedAt <= STORAGE_TRAFFIC_STATE_TTL_MS ? entry.traffic : null;
  };

  const observeTraffic = (trafficKey: string | undefined, raw: unknown) => {
    const traffic = parseStorageTraffic(raw);
    if (!traffic || !trafficKey) return;
    trafficByGateway.set(trafficKey, { traffic, observedAt: Date.now() });
    readTraffic();
  };

  const notifyTraffic = (listener: ((traffic: StorageTraffic) => void) | undefined, traffic: StorageTraffic) => {
    try {
      listener?.(traffic);
    } catch (error) {
      tunnelLog("tunnel.traffic.listener_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  // A report that came with a session (ack, stop): kept for its silo and handed to the download that owns the session.
  const observeSessionTraffic = (sessionId: string, raw: unknown) => {
    const traffic = parseStorageTraffic(raw);
    if (!traffic) return;
    observeTraffic(sessionGatewayById.get(sessionId), traffic);
    notifyTraffic(sessionTrafficListenerById.get(sessionId), traffic);
  };

  // The error of a `download.error` frame; a stopped viewer's carries the silo's report, which is kept and handed on first.
  const downloadFrameError = (sessionId: string, frame: TunnelGatewayFrame) => {
    const error = errorFromDownloadFrame(frame);
    if (error instanceof StorageTunnelError) observeSessionTraffic(sessionId, error.payload.traffic);
    return error;
  };

  // A session response. A refusal (STOR-BW-07) carries the report of the silo that refused.
  const readSessionResponse = async (res: Response, gatewayKey: string) => {
    try {
      return await readJsonResponse<StorageTunnelSession>(res);
    } catch (error) {
      if (error instanceof StorageTunnelError) observeTraffic(gatewayKey, error.payload.traffic);
      throw error;
    }
  };
  const wsConnections = new Map<
    string,
    Promise<{
      sendFrame: (frame: TunnelClientFrame) => Promise<TunnelGatewayFrame>;
      sendMessage: (message: Blob) => Promise<TunnelGatewayFrame>;
      sendOnly: (frame: TunnelClientFrame) => void;
      readFrame: () => Promise<TunnelGatewayFrame>;
      close: () => void;
    }>
  >();
  const sessionHttpFrameChain = new Map<string, Promise<unknown>>();
  const getAppId = (): SpaceAppId => normalizeSpaceAppId(input.getAppId?.()) ?? DEFAULT_SPACE_APP_ID;

  const getPolicy = async (token: string) => {
    const ttlMs = input.placementCacheTtlMs ?? 60_000;
    const now = Date.now();
    const key = token.trim();
    const cached = placementCacheByToken.get(key);
    if (cached && cached.expiresAt > now) return cached.policy;
    const apiBase = normalizeBaseUrl(input.getApiBaseUrl());
    const appId = getAppId();
    const res = await fetchImpl(`${apiBase}/storage/placement`, {
      method: "GET",
      headers: getBearerHeaders(token, appId),
    });
    const payload = await readJsonResponse<{ policy: StoragePlacementPolicy }>(res);
    placementCacheByToken.set(key, {
      policy: payload.policy,
      expiresAt: now + ttlMs,
    });
    return payload.policy;
  };

  const mediaPlacementCacheKey = (token: string, placementId: string) => `${token.trim()}::${placementId}`;

  const getCachedMediaPlacement = (token: string, placementId: string) => {
    const cached = mediaPlacementCache.get(mediaPlacementCacheKey(token, placementId));
    return cached && cached.expiresAt > Date.now() ? cached.placement : null;
  };

  const cacheMediaPlacement = (token: string, placement: MediaPlacement) => {
    mediaPlacementCache.set(mediaPlacementCacheKey(token, placement.placementId), {
      placement,
      expiresAt: Date.now() + (input.placementCacheTtlMs ?? 60_000),
    });
  };

  const toMediaPlacementError = (err: unknown, placementId: string): unknown => {
    if (!(err instanceof StorageTunnelError)) return err;
    if (err.status === 409 && err.code === PLACEMENT_MOVING_CODE) {
      return new StorageMediaPlacementError(409, PLACEMENT_MOVING_CODE, placementId, err.payload);
    }
    if (err.status !== 503) return err;
    if (err.code !== "placement_silo_unavailable" && err.code !== "no_storage_capacity") return err;
    return new StorageMediaPlacementError(503, err.code, placementId, err.payload);
  };

  // Upload path: returns this user's placement for `placementId`, creating it
  // on first use (the API picks the silo). Concurrent uploads of one media
  // share a single request.
  const acquireMediaPlacement = async (token: string, placementId: string): Promise<MediaPlacement> => {
    const cached = getCachedMediaPlacement(token, placementId);
    if (cached) return cached;
    const inflightKey = mediaPlacementCacheKey(token, placementId);
    let pending = mediaPlacementAcquireInflight.get(inflightKey);
    if (!pending) {
      pending = (async () => {
        const apiBase = normalizeBaseUrl(input.getApiBaseUrl());
        try {
          const res = await fetchImpl(`${apiBase}/storage/placement/media`, {
            method: "POST",
            headers: getBearerHeaders(token, getAppId()),
            body: JSON.stringify({ placementId }),
          });
          const payload = await readJsonResponse<{ placement: MediaPlacement }>(res);
          cacheMediaPlacement(token, payload.placement);
          tunnelLog("tunnel.media_placement.acquired", {
            placementId,
            poolId: payload.placement.poolId,
            shardId: payload.placement.shard.id,
          });
          return payload.placement;
        } catch (err) {
          throw toMediaPlacementError(err, placementId);
        }
      })().finally(() => mediaPlacementAcquireInflight.delete(inflightKey));
      mediaPlacementAcquireInflight.set(inflightKey, pending);
    }
    return pending;
  };

  // Read path: batch-resolves existing placements. Ids the caller does not own
  // (or that do not exist) are absent from the result; ids whose silo is not
  // live map to null.
  const resolveMediaPlacements = async (
    token: string,
    placementIds: string[]
  ): Promise<Record<string, MediaPlacement | null>> => {
    const result: Record<string, MediaPlacement | null> = {};
    const waits: Array<Promise<void>> = [];
    const missing: string[] = [];
    for (const placementId of new Set(placementIds)) {
      const cached = getCachedMediaPlacement(token, placementId);
      if (cached) {
        result[placementId] = cached;
        continue;
      }
      const pending = mediaPlacementResolveInflight.get(mediaPlacementCacheKey(token, placementId));
      if (pending) {
        waits.push(
          pending.then((placement) => {
            if (placement !== undefined) result[placementId] = placement;
          })
        );
        continue;
      }
      missing.push(placementId);
    }
    for (let i = 0; i < missing.length; i += STORAGE_HEAD_BATCH_KEYS) {
      const batch = missing.slice(i, i + STORAGE_HEAD_BATCH_KEYS);
      const request = (async () => {
        const apiBase = normalizeBaseUrl(input.getApiBaseUrl());
        const res = await fetchImpl(`${apiBase}/storage/placement/media/resolve`, {
          method: "POST",
          headers: getBearerHeaders(token, getAppId()),
          body: JSON.stringify({ placementIds: batch }),
        });
        const payload = await readJsonResponse<{
          placements?: Array<MediaPlacement | { placementId: string; poolId: string; shard: null }>;
        }>(res);
        const byId = new Map<string, MediaPlacement | null>();
        for (const entry of payload.placements ?? []) {
          if (entry.shard) {
            cacheMediaPlacement(token, entry as MediaPlacement);
            byId.set(entry.placementId, entry as MediaPlacement);
          } else {
            byId.set(entry.placementId, null);
          }
        }
        tunnelLog("tunnel.media_placement.resolved", { requested: batch.length, returned: byId.size });
        return byId;
      })();
      for (const placementId of batch) {
        const inflightKey = mediaPlacementCacheKey(token, placementId);
        const perId = request
          .then((byId) => byId.get(placementId))
          .finally(() => mediaPlacementResolveInflight.delete(inflightKey));
        mediaPlacementResolveInflight.set(inflightKey, perId);
        waits.push(
          perId.then((placement) => {
            if (placement !== undefined) result[placementId] = placement;
          })
        );
      }
    }
    await Promise.all(waits);
    return result;
  };

  const resolveMediaPlacement = async (token: string, placementId: string): Promise<MediaPlacement> => {
    const resolved = await resolveMediaPlacements(token, [placementId]);
    const placement = resolved[placementId];
    if (placement === undefined) throw new StorageMediaPlacementError(404, "placement_not_found", placementId);
    if (placement === null) throw new StorageMediaPlacementError(503, "placement_silo_unavailable", placementId);
    return placement;
  };

  type ResolvedGateway = {
    gatewayBaseUrl: string;
    addresses: string[];
    shardId: string;
    placementEpoch?: number;
    objectKeyPrefix: string;
    resolvedObjectKey: string | null;
  };

  const resolveMediaGateway = (placement: MediaPlacement, resolvedObjectKey: string | null): ResolvedGateway => {
    if (!placement.shard?.gatewayUrl) {
      throw new StorageMediaPlacementError(503, "placement_silo_unavailable", placement.placementId, {
        poolId: placement.poolId,
      });
    }
    tunnelLog("tunnel.resolve_gateway.media", {
      placementId: placement.placementId,
      gatewayUrl: placement.shard.gatewayUrl,
      shardId: placement.shard.id,
      addressCount: placement.shard.addresses?.length ?? 0,
    });
    return {
      gatewayBaseUrl: placement.shard.gatewayUrl,
      addresses: placement.shard.addresses ?? [],
      shardId: placement.shard.id,
      objectKeyPrefix: `${MEDIA_PLACEMENT_PREFIX}/${placement.placementId}`,
      resolvedObjectKey,
    };
  };

  // Media uploads (placementId set) and media-key reads route to the
  // placement's silo; everything else keeps rendezvous + shards/<id>/.
  const resolveGateway = async (
    token: string,
    objectKey?: string,
    placementId?: string
  ): Promise<ResolvedGateway> => {
    if (placementId) {
      const placement = await acquireMediaPlacement(token, placementId);
      return resolveMediaGateway(placement, objectKey ? buildMediaObjectKey(placementId, objectKey) : null);
    }
    const keyPlacementId = objectKey ? parseMediaPlacementIdFromObjectKey(objectKey) : null;
    if (keyPlacementId && objectKey) {
      return resolveMediaGateway(await resolveMediaPlacement(token, keyPlacementId), objectKey.trim());
    }
    const shard = await resolveRendezvousGateway(token, objectKey);
    return {
      ...shard,
      objectKeyPrefix: `${STORAGE_SHARD_PREFIX}/${shard.shardId}`,
      resolvedObjectKey: objectKey ? buildShardedObjectKey(shard.shardId, objectKey) : null,
    };
  };

  const resolveRendezvousGateway = async (token: string, objectKey?: string) => {
    const policy = await getPolicy(token);
    if (!policy?.shards?.length) {
      tunnelLog("tunnel.resolve_gateway.no_shards", {});
      throw new StorageTunnelError(503, { error: "no_storage_gateways_available" });
    }
    if (objectKey) {
      const selected = pickPlacementShard(policy, objectKey);
      if (selected?.gatewayUrl) {
        tunnelLog("tunnel.resolve_gateway", {
          gatewayUrl: selected.gatewayUrl,
          shardId: selected.id,
          addressCount: selected.addresses?.length ?? 0,
        });
        return {
          gatewayBaseUrl: selected.gatewayUrl,
          addresses: selected.addresses ?? [],
          shardId: selected.id,
          placementEpoch: policy.epoch,
        };
      }
    }
    // Only a silo that takes new data: never a `provisioning` one awaiting activation (STOR-GATEWAY-13).
    const fallback = policy.shards.find((entry) => (entry.status ?? "active") === "active");
    if (!fallback?.gatewayUrl) {
      tunnelLog("tunnel.resolve_gateway.no_active_shards", {});
      throw new StorageTunnelError(503, { error: "no_storage_gateways_available" });
    }
    tunnelLog("tunnel.resolve_gateway.fallback", {
      gatewayUrl: fallback.gatewayUrl,
      shardId: fallback.id,
      addressCount: fallback.addresses?.length ?? 0,
    });
    return {
      gatewayBaseUrl: fallback.gatewayUrl,
      addresses: fallback.addresses ?? [],
      shardId: fallback.id,
      placementEpoch: policy.epoch,
    };
  };

  const getWsConnection = (token: string, sessionId: string, gatewayBaseUrl: string) => {
    const key = `${gatewayBaseUrl}::${sessionId}`;
    const existing = wsConnections.get(key);
    if (existing) return existing;
    const promise = createWsConnection({
      wsEndpoint: getWsEndpoint(gatewayBaseUrl),
      token,
      sessionId,
      WebSocketImpl: input.WebSocketImpl,
    }).catch((error) => {
      wsConnections.delete(key);
      throw error;
    });
    wsConnections.set(key, promise);
    return promise;
  };

  const sendFrameHttp = async (token: string, sessionId: string, frame: TunnelClientFrame) => {
    const gatewayBaseUrl = sessionGatewayById.get(sessionId);
    if (!gatewayBaseUrl) {
      throw new StorageTunnelError(400, { error: "storage_tunnel_session_gateway_missing" });
    }
    const normalizedFrame = normalizeOutgoingFrame(frame);
    const appId = getAppId();
    const res = await fetchImpl(`${gatewayBaseUrl}/storage/tunnel/frame`, {
      method: "POST",
      headers: getBearerHeaders(token, appId),
      body: JSON.stringify({ sessionId, frame: normalizedFrame }),
    });
    const payload = await readJsonResponse<{ frame: TunnelGatewayFrame }>(res);
    return payload.frame;
  };

  const sendFrameHttpOrdered = async (token: string, sessionId: string, frame: TunnelClientFrame) => {
    const previous = sessionHttpFrameChain.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => sendFrameHttp(token, sessionId, frame));
    sessionHttpFrameChain.set(sessionId, current);
    return current;
  };

  const startSession = async (
    token: string,
    sessionId: string,
    clientType = "client",
    clientVersion = "storage-tunnel-client"
  ) => {
    const ack = await client.sendFrame(token, sessionId, {
      kind: "session.start",
      sessionId,
      token,
      clientType,
      clientVersion,
    });
    if (String(ack.kind ?? "") !== "session.ack") {
      throw new Error("TUNNEL_SESSION_START_FAILED");
    }
  };

  const endSession = async (token: string, sessionId: string) => {
    await withTimeout(
      client.sendFrame(token, sessionId, {
        kind: "session.end",
        sessionId,
      }),
      CONTROL_FRAME_TIMEOUT_MS,
      "tunnel_session_end_timeout"
    )
      .catch(() => undefined);
  };

  const uploadObjectOnce = async (
    token: string,
    objectKey: string,
    payload: Uint8Array | TunnelUploadSource,
    options?: {
      objectNamespace?: string;
      logicalRef?: string;
      contentType?: string;
      chunkSize?: number;
      uploadWindow?: number;
      clientType?: string;
      clientVersion?: string;
      uploadId?: string;
      checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string>;
      /** Per-media silo (#145): store under media/<placementId>/ on the placement's silo. */
      placementId?: string;
      /** How the object counts toward the allowance (STOR-USE-02); sent on `upload.open`. Absent: it counts its stored bytes. */
      counting?: StorageObjectCounting;
      /**
       * A re-sealed copy of `of` for media reseal run `runId` (STOR-RESEAL-03): uploaded over a `reseal` session, which
       * accepts copies only (also for an unpaid or over-quota account), with `resealRunId` + `resealOf` on `upload.open`.
       */
      reseal?: StorageResealCopy;
    },
    resume?: UploadResumeState,
    /** An open session of `createUploadSession`: no session of its own is made, started or ended. */
    reused?: { sessionId: string; resolvedObjectKey: string }
  ) => {
    // An upload session is purpose `upload` (refused with 402 `subscription_unpaid` once the account is unpaid); a
    // re-sealed copy goes over a `reseal` session instead (STOR-RESEAL-03).
    const session = reused
      ? { sessionId: reused.sessionId, resolvedObjectKey: reused.resolvedObjectKey }
      : await client.createSession(token, objectKey, {
          purpose: options?.reseal ? "reseal" : "upload",
          ...(options?.placementId ? { placementId: options.placementId } : {}),
        });
    const sessionId = session.sessionId;
    const resolvedObjectKey = session.resolvedObjectKey ?? objectKey;
    const uploadId = options?.uploadId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const chunkSize = Math.max(1, Number(options?.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE));
    const checksumFn = options?.checksumFn ?? ((chunk: Uint8Array) => buildChecksum(chunk));
    const uploadPerf = {
      chunks: 0,
      bytes: 0,
      encodeMs: 0,
      sendRoundTripMs: 0,
      peakInFlight: 0,
    };
    let wsSendFrame: ((frame: TunnelClientFrame) => Promise<TunnelGatewayFrame>) | null = null;
    let wsSendMessage: ((message: Blob) => Promise<TunnelGatewayFrame>) | null = null;
    let wsNextSeqToSend = 0;
    const wsSeqTurnWaiters = new Map<number, Array<() => void>>();
    const waitForWsSeqTurn = (seq: number) =>
      new Promise<void>((resolve) => {
        if (seq === wsNextSeqToSend) {
          resolve();
          return;
        }
        const waiters = wsSeqTurnWaiters.get(seq) ?? [];
        waiters.push(resolve);
        wsSeqTurnWaiters.set(seq, waiters);
      });
    const advanceWsSeqTurn = () => {
      wsNextSeqToSend += 1;
      const waiters = wsSeqTurnWaiters.get(wsNextSeqToSend);
      if (!waiters?.length) return;
      wsSeqTurnWaiters.delete(wsNextSeqToSend);
      for (const notify of waiters) notify();
    };

    let keepForResume = false;
    try {
      if (!reused) await startSession(token, sessionId, options?.clientType, options?.clientVersion);
      const gatewayBaseUrl = sessionGatewayById.get(sessionId);
      if (wsEnabled && gatewayBaseUrl) {
        try {
          const conn = await getWsConnection(token, sessionId, gatewayBaseUrl);
          wsSendFrame = conn.sendFrame;
          wsSendMessage = conn.sendMessage;
        } catch {
          wsSendFrame = null;
          wsSendMessage = null;
        }
      }
      const sendUploadFrame = (frame: TunnelClientFrame) =>
        wsSendFrame ? wsSendFrame(frame) : client.sendFrame(token, sessionId, frame);
      const uploadWindow = resolveUploadWindow(options?.uploadWindow, wsSendFrame ? DEFAULT_WS_UPLOAD_WINDOW : 1);

      const resumeIdSent = resume?.resumeId ?? null;
      const open = await sendUploadFrame({
        kind: "upload.open",
        uploadId,
        objectKey: resolvedObjectKey,
        objectNamespace: options?.objectNamespace ?? "library",
        logicalRef: options?.logicalRef ?? resolvedObjectKey,
        contentType: options?.contentType ?? "application/octet-stream",
        expectedBytes: payload.byteLength,
        ...(options?.counting ? { role: options.counting.role } : {}),
        ...(options?.counting?.declaredBytes !== undefined ? { declaredBytes: Math.max(0, Math.floor(options.counting.declaredBytes)) } : {}),
        ...(resumeIdSent ? { resumeId: resumeIdSent } : {}),
        ...(options?.reseal ? { resealRunId: options.reseal.runId, resealOf: options.reseal.of } : {}),
      });
      if (String(open.kind ?? "") !== "upload.progress") {
        const errorDetail = String((open as Record<string, unknown>).error ?? "unknown");
        throw new Error(`TUNNEL_UPLOAD_OPEN_FAILED:${errorDetail}`);
      }

      // A resumed upload continues at the byte the gateway kept; `bytesPersisted` is 0 for a fresh one.
      if (resume) resume.resumeId = typeof open.resumeId === "string" ? open.resumeId : null;
      const resumeFromByte = resumeIdSent
        ? Math.min(payload.byteLength, Math.max(0, Math.floor(Number(open.bytesPersisted) || 0)))
        : 0;
      if (resumeIdSent) {
        tunnelLog("tunnel.upload.resumed", { sessionId, uploadId, resumeId: resumeIdSent, resumeFromByte, totalBytes: payload.byteLength });
      }

      await streamUploadFrames({
        byteLength: payload.byteLength,
        startOffset: resumeFromByte,
        chunkSize,
        uploadWindow,
        sendChunk: async (range, seq) => {
          const sendStartedAt = performance.now();
          let ack: TunnelGatewayFrame;
          if (!(payload instanceof Uint8Array) && wsSendMessage) {
            const built = await payload.buildWsMessage({ uploadId, seq, ...range });
            try {
              await waitForWsSeqTurn(seq);
              const ackPromise = wsSendMessage(built.message);
              advanceWsSeqTurn();
              ack = await ackPromise;
            } finally {
              built.release();
            }
          } else {
            const chunk =
              payload instanceof Uint8Array
                ? payload.slice(range.offset, range.offset + range.length)
                : await payload.read(range.offset, range.length);
            const checksum = normalizeOutgoingChecksum(await checksumFn(chunk, seq));
            if (wsSendFrame) {
              await waitForWsSeqTurn(seq);
              const ackPromise = sendUploadFrame({
                kind: "upload.data",
                uploadId,
                seq,
                checksum,
                ciphertext: chunk,
              });
              advanceWsSeqTurn();
              ack = await ackPromise;
            } else {
              const encodeStartedAt = performance.now();
              const ciphertextBase64 = bytesToBase64(chunk);
              uploadPerf.encodeMs += Math.max(0, performance.now() - encodeStartedAt);
              ack = await sendUploadFrame({
                kind: "upload.data",
                uploadId,
                seq,
                checksum,
                ciphertextBase64,
              });
            }
          }
          uploadPerf.sendRoundTripMs += Math.max(0, performance.now() - sendStartedAt);
          uploadPerf.chunks += 1;
          uploadPerf.bytes += range.length;
          return ack;
        },
        onInFlightChange: (size) => {
          uploadPerf.peakInFlight = Math.max(uploadPerf.peakInFlight, size);
        },
      });

      const close = await sendUploadFrame({
        kind: "upload.close",
        uploadId,
      });
      if (String(close.kind ?? "") !== "upload.complete") {
        // The gateway's commit was refused because a move is copying this media.
        if (options?.placementId && frameMessage(close) === PLACEMENT_MOVING_CODE) {
          throw new StorageMediaPlacementError(409, PLACEMENT_MOVING_CODE, options.placementId);
        }
        throw new Error("TUNNEL_UPLOAD_CLOSE_FAILED");
      }
      const objectKeys = (close as { objectKeys?: unknown }).objectKeys;
      input.onUploadPerf?.("upload.complete", {
        sessionId,
        uploadId,
        objectKey: resolvedObjectKey,
        ws: Boolean(wsSendFrame),
        chunks: uploadPerf.chunks,
        bytes: uploadPerf.bytes,
        encodeMs: uploadPerf.encodeMs,
        sendRoundTripMs: uploadPerf.sendRoundTripMs,
        peakInFlight: uploadPerf.peakInFlight,
      });
      if (Array.isArray(objectKeys) && typeof objectKeys[0] === "string" && objectKeys[0].trim()) {
        return String(objectKeys[0]).trim();
      }
      return resolvedObjectKey;
    } catch (error) {
      // A transient failure of an upload the gateway named leaves the session alone: `session.end` would abort the
      // assembly the next attempt resumes. The session expires by itself and the gateway keeps its multipart files.
      keepForResume =
        Boolean(resume?.resumeId) && (resume?.resumesLeft ?? 0) > 0 && isTransientStorageTransportError(error);
      throw error;
    } finally {
      if (!keepForResume && !reused) await endSession(token, sessionId);
    }
  };

  /**
   * Uploads one object, resuming where it stopped. Uploads to a media whose placement a move is copying are refused with
   * 409 `placement_moving` (claim, gateway session or the gateway's commit): drop the cached placement — the flip
   * changes its silo — and retry with bounded backoff; once spent, the typed 409 reaches the caller. A transient
   * failure (gateway restart or drain, dropped connection, a session the API lost) after the gateway named the upload
   * (`resumeId`) opens a new session and continues from the bytes the gateway kept instead of starting over (STOR-GATEWAY-04).
   */
  const uploadObject = async (
    token: string,
    objectKey: string,
    payload: Uint8Array | TunnelUploadSource,
    options?: Parameters<typeof uploadObjectOnce>[3]
  ) => {
    const placementId = options?.placementId;
    const resume: UploadResumeState = { resumeId: null, resumesLeft: UPLOAD_RESUME_RETRY_DELAYS_MS.length };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await uploadObjectOnce(token, objectKey, payload, options, resume);
      } catch (rawErr) {
        if (resume.resumeId && resume.resumesLeft > 0 && isTransientStorageTransportError(rawErr)) {
          const delayMs = UPLOAD_RESUME_RETRY_DELAYS_MS[UPLOAD_RESUME_RETRY_DELAYS_MS.length - resume.resumesLeft];
          resume.resumesLeft -= 1;
          tunnelLog("tunnel.upload.resume", {
            objectKey,
            resumeId: resume.resumeId,
            resumesLeft: resume.resumesLeft,
            delayMs,
            error: rawErr instanceof Error ? rawErr.message : String(rawErr),
          });
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          attempt -= 1;
          continue;
        }
        const err = placementId ? toMediaPlacementError(rawErr, placementId) : rawErr;
        const moving = err instanceof StorageMediaPlacementError && err.code === PLACEMENT_MOVING_CODE;
        if (!placementId || !moving || attempt >= placementMovingRetryDelaysMs.length) throw err;
        mediaPlacementCache.delete(mediaPlacementCacheKey(token, placementId));
        const delayMs = placementMovingRetryDelaysMs[attempt];
        tunnelLog("tunnel.media_placement.moving_retry", {
          placementId,
          attempt: attempt + 1,
          maxAttempts: placementMovingRetryDelaysMs.length,
          delayMs,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };

  /**
   * One upload session for many small objects of one media (STOR-REUSE-01): the session, its start and its
   * websocket are paid once instead of per object; each object still has its own `upload.open` / `upload.close`
   * (the gateway's quota lease and commit). Uploads on one handle run one after another (the websocket answers in
   * order); open several handles to run them side by side. A failed upload drops the session and is retried through
   * `uploadObject` (fresh session, resume and placement-move retries); the next one opens a new session. A session is
   * renewed before the gateway's session TTL could end it.
   */
  const createUploadSession = (
    token: string,
    session: { placementId: string; clientType?: string; clientVersion?: string }
  ): StorageUploadSession => {
    const { placementId } = session;
    let current: Promise<{ sessionId: string; openedAt: number }> | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    const drop = async (opened: Promise<{ sessionId: string }> | null) => {
      if (current === opened) current = null;
      const sessionId = await opened?.then((value) => value.sessionId).catch(() => null);
      if (sessionId) await endSession(token, sessionId);
    };
    const acquire = () => {
      if (current) return current;
      const opened = (async () => {
        const created = await client.createSession(token, undefined, { purpose: "upload", placementId });
        await startSession(token, created.sessionId, session.clientType, session.clientVersion);
        return { sessionId: created.sessionId, openedAt: Date.now() };
      })();
      current = opened;
      opened.catch(() => {
        if (current === opened) current = null;
      });
      return opened;
    };
    const uploadOne = async (
      objectKey: string,
      payload: Uint8Array | TunnelUploadSource,
      options?: StorageUploadSessionObjectOptions
    ): Promise<string> => {
      if (closed) throw new Error("TUNNEL_UPLOAD_SESSION_CLOSED");
      const objectOptions = { ...options, placementId, clientType: session.clientType, clientVersion: session.clientVersion };
      let opened = current;
      if (opened && Date.now() - (await opened.then((value) => value.openedAt).catch(() => 0)) >= REUSED_SESSION_RENEW_MS) {
        await drop(opened);
      }
      opened = acquire();
      try {
        const { sessionId } = await opened;
        return await uploadObjectOnce(token, objectKey, payload, objectOptions, undefined, {
          sessionId,
          resolvedObjectKey: buildMediaObjectKey(placementId, objectKey),
        });
      } catch (error) {
        tunnelLog("tunnel.upload_session.fallback", {
          placementId,
          objectKey,
          error: error instanceof Error ? error.message : String(error),
        });
        await drop(opened);
        return uploadObject(token, objectKey, payload, objectOptions);
      }
    };
    return {
      upload(objectKey: string, payload: Uint8Array | TunnelUploadSource, options?: StorageUploadSessionObjectOptions) {
        const run = queue.then(() => uploadOne(objectKey, payload, options));
        queue = run.catch(() => undefined);
        return run;
      },
      async close() {
        await queue;
        closed = true;
        await drop(current);
      },
    };
  };

  const downloadObjectOnce = async (
    token: string,
    objectKey: string,
    options?: {
      clientType?: string;
      clientVersion?: string;
      downloadId?: string;
      receiveWindow?: number;
      /** Session purpose; `export` for offline downloads / exports (allowed when unpaid). Default `playback`. */
      purpose?: StorageTunnelPurpose;
      /** The profile this playback is for, over the client's `getProfileId` (STOR-BW-11). */
      profileId?: string | null;
      /** Optional playback hints for the gateway scheduler (STOR-BW-01..04); omitted fields are not sent. */
      hints?: StorageDownloadHints;
      onChunk?: (chunk: Uint8Array) => void | Promise<void>;
      skipAssemble?: boolean;
    },
    /** An open session of `createDownloadSession`: no session of its own is made, started or ended. */
    reused?: { sessionId: string }
  ) => {
    const onTraffic = options?.hints?.onTraffic;
    let session: Pick<StorageTunnelSession, "sessionId" | "resolvedObjectKey" | "traffic">;
    if (reused) {
      // The session's own prefix (media/<placementId>) is the gateway's: a key of that media is read as sent.
      session = { sessionId: reused.sessionId, resolvedObjectKey: objectKey.trim() };
    } else {
      try {
        session = await client.createSession(token, objectKey, {
          purpose: options?.purpose ?? "playback",
          profileId: options?.profileId,
        });
      } catch (error) {
        // A refused session (STOR-BW-07) carries the report of the silo that refused it.
        const refusal = storageTrafficFromError(error);
        if (refusal) notifyTraffic(onTraffic, refusal);
        throw error;
      }
    }
    if (onTraffic) {
      sessionTrafficListenerById.set(session.sessionId, onTraffic);
      const opened = parseStorageTraffic(session.traffic);
      if (opened) notifyTraffic(onTraffic, opened);
    }
    const sessionId = session.sessionId;
    const downloadId = options?.downloadId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const receiveWindow = resolveDownloadWindow(options?.receiveWindow);
    const hintFields = (withBurst: boolean) => buildDownloadHintFields(options?.hints, withBurst);

    try {
      if (!reused) await startSession(token, sessionId, options?.clientType, options?.clientVersion);
      const shouldAssemble = options?.skipAssemble !== true;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const downloadPerf = {
        mode: input.preferWsDownloadStream === true ? "ws-stream" : "request-response",
        streamAttempted: false,
        wsFrames: 0,
        dataFrames: 0,
        progressFrames: 0,
        creditsSent: 0,
        wsReadTimeouts: 0,
        fallbackCount: 0,
        fallbackResumeBytes: 0,
        fallbackReason: null as string | null,
        verifyMs: 0,
        assembleMs: 0,
      };
      const consumeChunk = async (chunk: Uint8Array) => {
        await options?.onChunk?.(chunk);
        if (shouldAssemble) {
          chunks.push(chunk);
        }
        downloadPerf.dataFrames += 1;
        totalBytes += chunk.byteLength;
      };
      const runRequestResponseDownload = async (
        effectiveDownloadId: string,
        rangeStart: number,
        sendFrameFn: (frame: TunnelClientFrame) => Promise<TunnelGatewayFrame>
      ) => {
        let frame = await sendFrameFn({
          kind: "download.open",
          downloadId: effectiveDownloadId,
          objectKey: session.resolvedObjectKey ?? objectKey,
          rangeStart,
          rangeEnd: null,
          receiveWindow,
          ...hintFields(true),
        });
        let lastReceivedSeq = -1;
        let nextExpectedSeq = 0;
        while (true) {
          const kind = String(frame.kind ?? "");
          if (kind === "download.complete") break;
          if (kind === "download.error") {
            throw downloadFrameError(sessionId, frame);
          }
          if (kind === "download.progress") {
            downloadPerf.progressFrames += 1;
            if (lastReceivedSeq < 0) {
              throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
            }
            frame = await sendFrameFn({
              kind: "download.ack",
              downloadId: effectiveDownloadId,
              receivedSeq: lastReceivedSeq,
              receiveWindow,
              ...hintFields(false),
            });
            continue;
          }
          if (kind !== "download.data") {
            throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
          }
          const seq = Number((frame as { seq?: unknown }).seq ?? -1);
          if (!Number.isInteger(seq) || seq < 0 || seq !== nextExpectedSeq) {
            throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
          }
          nextExpectedSeq += 1;
          lastReceivedSeq = Math.max(lastReceivedSeq, seq);
          const dataFrame = frame;
          frame = await sendFrameFn({
            kind: "download.ack",
            downloadId: effectiveDownloadId,
            receivedSeq: seq,
            receiveWindow,
            ...hintFields(false),
          });
          const rawCiphertext = (dataFrame as { ciphertext?: unknown }).ciphertext;
          const rawChecksum = (dataFrame as { checksum?: unknown }).checksum;
          const chunk = parseCiphertextBytes(rawCiphertext);
          const verifyStartedAt = performance.now();
          const checksumOk = await verifyChecksum(chunk, rawChecksum);
          downloadPerf.verifyMs += Math.max(0, performance.now() - verifyStartedAt);
          if (!checksumOk) {
            const actualHash = await sha256Hex(chunk).catch(() => "hash_error");
            console.warn("tunnel.download.checksum_mismatch", JSON.stringify({
              seq,
              chunkBytes: chunk.byteLength,
              expectedChecksum: String(rawChecksum ?? ""),
              actualHash: `sha256:${actualHash}`,
              ciphertextType: rawCiphertext === null ? "null" : typeof rawCiphertext === "string" ? `string(${(rawCiphertext as string).length})` : Array.isArray(rawCiphertext) ? `array(${(rawCiphertext as unknown[]).length})` : typeof rawCiphertext,
            }));
            throw new Error("TUNNEL_DOWNLOAD_CHECKSUM_MISMATCH");
          }
          await consumeChunk(chunk);
        }
      };
      const runWsRequestResponseDownload = async (effectiveDownloadId: string, rangeStart: number) => {
        if (!wsConn) throw new Error("ws_not_open");
        let lastReceivedSeq = -1;
        let lastAckSent = -1;
        let nextExpectedSeq = 0;
        let stagnantProgressFrames = 0;
        wsConn.sendOnly({
          kind: "download.open",
          downloadId: effectiveDownloadId,
          objectKey: session.resolvedObjectKey ?? objectKey,
          rangeStart,
          rangeEnd: null,
          receiveWindow,
          ...hintFields(true),
        });
        while (true) {
          const frame = await Promise.race([
            wsConn.readFrame(),
            new Promise<TunnelGatewayFrame>((_, reject) =>
              setTimeout(() => reject(new Error("ws_read_timeout")), DOWNLOAD_WS_READ_TIMEOUT_MS)
            ),
          ]);
          downloadPerf.wsFrames += 1;
          // A reused session's socket may still hold a late answer of the download before it (its close is answered
          // `download.complete`): a frame of another download is not this one's.
          if (typeof frame.downloadId === "string" && frame.downloadId !== effectiveDownloadId) continue;
          const kind = String(frame.kind ?? "");
          if (kind === "download.complete") break;
          if (kind === "download.error") {
            throw downloadFrameError(sessionId, frame);
          }
          if (kind === "download.progress") {
            downloadPerf.progressFrames += 1;
            const bytesRemaining = Math.max(
              0,
              Number((frame as { bytesRemaining?: unknown }).bytesRemaining ?? Number.NaN)
            );
            if (lastReceivedSeq > lastAckSent) {
              wsConn.sendOnly({
                kind: "download.ack",
                downloadId: effectiveDownloadId,
                receivedSeq: lastReceivedSeq,
                receiveWindow,
                ...hintFields(false),
              });
              lastAckSent = lastReceivedSeq;
              stagnantProgressFrames = 0;
            } else {
              stagnantProgressFrames += 1;
              if (
                lastReceivedSeq >= 0 &&
                bytesRemaining > 0 &&
                stagnantProgressFrames % 4 === 0
              ) {
                wsConn.sendOnly({
                  kind: "download.ack",
                  downloadId: effectiveDownloadId,
                  receivedSeq: lastReceivedSeq,
                  receiveWindow,
                  ...hintFields(false),
                });
              }
              if (stagnantProgressFrames >= Math.max(32, receiveWindow * 8)) {
                throw new Error("ws_download_stalled");
              }
            }
            continue;
          }
          if (kind !== "download.data") {
            throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
          }
          const seq = Number((frame as { seq?: unknown }).seq ?? -1);
          if (!Number.isInteger(seq) || seq < 0 || seq !== nextExpectedSeq) {
            throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
          }
          nextExpectedSeq += 1;
          lastReceivedSeq = Math.max(lastReceivedSeq, seq);
          wsConn.sendOnly({
            kind: "download.ack",
            downloadId: effectiveDownloadId,
            receivedSeq: seq,
            receiveWindow,
            ...hintFields(false),
          });
          lastAckSent = seq;
          const chunk = parseCiphertextBytes((frame as { ciphertext?: unknown }).ciphertext);
          const verifyStartedAt = performance.now();
          const checksumOk = await verifyChecksum(chunk, (frame as { checksum?: unknown }).checksum);
          downloadPerf.verifyMs += Math.max(0, performance.now() - verifyStartedAt);
          if (!checksumOk) {
            throw new Error("TUNNEL_DOWNLOAD_CHECKSUM_MISMATCH");
          }
          await consumeChunk(chunk);
          stagnantProgressFrames = 0;
        }
      };
      const runHttpDownload = async (effectiveDownloadId: string, rangeStart: number) => {
        await runRequestResponseDownload(effectiveDownloadId, rangeStart, (frame) =>
          sendFrameHttpOrdered(token, sessionId, frame)
        );
      };
      const gatewayBaseUrl = sessionGatewayById.get(sessionId);
      const runGatewayStreamDownload = async () => {
        if (!gatewayBaseUrl || isWaterfall) return false;
        const res = await Promise.resolve(
          fetchImpl(`${gatewayBaseUrl}/storage/tunnel/download`, {
            method: "POST",
            headers: getBearerHeaders(token, getAppId()),
            body: JSON.stringify({
              sessionId,
              objectKey: session.resolvedObjectKey ?? objectKey,
              rangeStart: 0,
              rangeEnd: null,
            }),
          })
        ).catch(() => null);
        if (res?.status === 503) {
          // STOR-BW-08: the fast path of a stopped viewer answers 503 `playback_stopped` with the silo's report.
          const body = (await res.json().catch(() => null)) as { error?: string; traffic?: unknown } | null;
          if (body?.error === STORAGE_PLAYBACK_STOPPED_CODE) {
            throw downloadFrameError(sessionId, { code: STORAGE_PLAYBACK_STOPPED_CODE, traffic: body.traffic });
          }
        }
        if (!res || !res.ok) return false;
        if (String(res.headers.get("x-storage-tunnel-download") ?? "").trim() !== "1") return false;
        const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
        if (!contentType.includes("application/octet-stream")) return false;
        const payload = new Uint8Array(await res.arrayBuffer());
        const digest = String(res.headers.get("x-storage-tunnel-sha256") ?? "").trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(digest)) return false;
        const actualDigest = await sha256Hex(payload);
        if (actualDigest !== digest) throw new Error("TUNNEL_DOWNLOAD_CHECKSUM_MISMATCH");
        await consumeChunk(payload);
        downloadPerf.mode = "http-stream";
        return true;
      };
      const wsConn =
        wsEnabled && gatewayBaseUrl
          ? await getWsConnection(token, sessionId, gatewayBaseUrl).catch(() => null)
          : null;

      if (wsConn && input.preferWsDownloadStream === true && !reused) {
        downloadPerf.streamAttempted = true;
        try {
          let lastReceivedSeq = -1;
          let lastCreditSeqSent = -1;
          let nextExpectedSeq = 0;
          wsConn.sendOnly({
            kind: "download.stream.start",
            downloadId,
            objectKey: session.resolvedObjectKey ?? objectKey,
            rangeStart: 0,
            rangeEnd: null,
            receiveWindow,
            ...hintFields(true),
          });
          while (true) {
            const frame = await Promise.race([
              wsConn.readFrame(),
              new Promise<TunnelGatewayFrame>((_, reject) =>
                setTimeout(() => reject(new Error("ws_read_timeout")), DOWNLOAD_WS_READ_TIMEOUT_MS)
              ),
            ]);
            downloadPerf.wsFrames += 1;
            const kind = String(frame.kind ?? "");
            if (kind === "download.complete") break;
            if (kind === "download.error") {
              throw downloadFrameError(sessionId, frame);
            }
            if (kind === "download.progress") {
              downloadPerf.progressFrames += 1;
              if (lastReceivedSeq > lastCreditSeqSent) {
                wsConn.sendOnly({
                  kind: "download.stream.credit",
                  downloadId,
                  receivedSeq: lastReceivedSeq,
                  receiveWindow,
                  ...hintFields(false),
                });
                downloadPerf.creditsSent += 1;
                lastCreditSeqSent = lastReceivedSeq;
              }
              continue;
            }
            if (kind !== "download.data") {
              throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
            }
            const seq = Number((frame as { seq?: unknown }).seq ?? -1);
            if (!Number.isInteger(seq) || seq < 0 || seq !== nextExpectedSeq) {
              throw new Error("TUNNEL_DOWNLOAD_INVALID_FRAME");
            }
            nextExpectedSeq += 1;
            lastReceivedSeq = Math.max(lastReceivedSeq, seq);
            wsConn.sendOnly({
              kind: "download.stream.credit",
              downloadId,
              receivedSeq: seq,
              receiveWindow,
              ...hintFields(false),
            });
            downloadPerf.creditsSent += 1;
            lastCreditSeqSent = seq;
            const chunk = parseCiphertextBytes((frame as { ciphertext?: unknown }).ciphertext);
            const verifyStartedAt = performance.now();
            const checksumOk = await verifyChecksum(chunk, (frame as { checksum?: unknown }).checksum);
            downloadPerf.verifyMs += Math.max(0, performance.now() - verifyStartedAt);
            if (!checksumOk) {
              throw new Error("TUNNEL_DOWNLOAD_CHECKSUM_MISMATCH");
            }
            await consumeChunk(chunk);
          }
        } catch (error) {
          // A stopped viewer (STOR-BW-08) stays stopped: no other route to the same bytes.
          if (isPlaybackStoppedError(error)) throw error;
          const reason = error instanceof Error ? error.message : "unknown";
          if (error instanceof Error && error.message === "ws_read_timeout") {
            downloadPerf.wsReadTimeouts += 1;
          }
          downloadPerf.fallbackCount += 1;
          downloadPerf.fallbackResumeBytes = totalBytes;
          downloadPerf.fallbackReason = reason;
          try {
            await runRequestResponseDownload(
              `${downloadId}-fallback`,
              totalBytes,
              (frame) => client.sendFrame(token, sessionId, frame)
            );
            downloadPerf.mode = "request-response";
          } catch (httpError) {
            if (isPlaybackStoppedError(httpError) || !(await runGatewayStreamDownload()) || totalBytes > 0) {
              throw httpError;
            }
          }
        }
      } else {
        try {
          if (wsConn) {
            await runWsRequestResponseDownload(downloadId, 0);
          } else {
            await runRequestResponseDownload(downloadId, 0, (frame) => client.sendFrame(token, sessionId, frame));
          }
        } catch (error) {
          // A stopped viewer (STOR-BW-08) stays stopped: no other route to the same bytes. A reused session is dropped
          // instead of falling back on it: `createDownloadSession` tries the object once more on a fresh session.
          if (isPlaybackStoppedError(error) || reused) throw error;
          const reason = error instanceof Error ? error.message : "unknown";
          if (wsConn) {
            if (error instanceof Error && error.message === "ws_read_timeout") {
              downloadPerf.wsReadTimeouts += 1;
            }
            downloadPerf.fallbackCount += 1;
            downloadPerf.fallbackResumeBytes = totalBytes;
            downloadPerf.fallbackReason = reason;
            try {
              await runHttpDownload(`${downloadId}-http`, totalBytes);
            } catch (httpError) {
              if (isPlaybackStoppedError(httpError) || !(await runGatewayStreamDownload()) || totalBytes > 0) {
                throw httpError;
              }
            }
          } else {
            if (!(await runGatewayStreamDownload()) || totalBytes > 0) {
              throw error;
            }
            downloadPerf.fallbackCount += 1;
            downloadPerf.fallbackResumeBytes = 0;
            downloadPerf.fallbackReason = reason;
          }
        }
      }

      await withTimeout(
        client.sendFrame(token, sessionId, {
          kind: "download.close",
          downloadId,
        }),
        CONTROL_FRAME_TIMEOUT_MS,
        "tunnel_download_close_timeout"
      )
        .catch(() => undefined);

      let merged = new Uint8Array(0);
      if (shouldAssemble) {
        merged = new Uint8Array(totalBytes);
        const assembleStartedAt = performance.now();
        let offset = 0;
        for (const chunk of chunks) offset = appendChunk(merged, offset, chunk);
        downloadPerf.assembleMs = Math.max(0, performance.now() - assembleStartedAt);
      }
      input.onDownloadPerf?.("download.complete", {
        sessionId,
        downloadId,
        objectKey: session.resolvedObjectKey ?? objectKey,
        bytes: totalBytes,
        ...downloadPerf,
      });
      return merged;
    } finally {
      if (!reused) {
        await endSession(token, sessionId);
        sessionTrafficListenerById.delete(sessionId);
      }
    }
  };

  const downloadObject = (token: string, objectKey: string, options?: Parameters<typeof downloadObjectOnce>[2]) =>
    downloadObjectOnce(token, objectKey, options);

  /**
   * One playback session for many objects of one media (STOR-REUSE-02): the session's create, start and websocket are
   * paid once instead of per object (a song's 1 MiB chunks paid ~0.9 s each on prod, 2026-11-21); each object still
   * has its own `download.open` / `download.close`. `objectKey` names the media (any of its keys); a key of another
   * media, or outside any media, routes to another silo and is downloaded on a session of its own. Downloads on one
   * handle run one after another (the websocket answers in order); open several handles to run them side by side. A
   * failed download drops the session and is tried once more through `downloadObject` (fresh session); the next one
   * opens a new session. A stopped viewer (STOR-BW-08) or a refused session stays refused. A session is renewed before
   * the gateway's session TTL could end it.
   */
  const createDownloadSession = (
    token: string,
    session: {
      objectKey: string;
      purpose?: StorageTunnelPurpose;
      profileId?: string | null;
      clientType?: string;
      clientVersion?: string;
    }
  ): StorageDownloadSession => {
    const placementId = parseMediaPlacementIdFromObjectKey(session.objectKey);
    const sessionOptions = {
      purpose: session.purpose,
      profileId: session.profileId,
      clientType: session.clientType,
      clientVersion: session.clientVersion,
    };
    let current: Promise<{ sessionId: string; openedAt: number }> | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    const drop = async (opened: Promise<{ sessionId: string }> | null) => {
      if (current === opened) current = null;
      const sessionId = await opened?.then((value) => value.sessionId).catch(() => null);
      if (sessionId) await endSession(token, sessionId);
    };
    const acquire = () => {
      if (current) return current;
      const opened = (async () => {
        const created = await client.createSession(token, session.objectKey, {
          purpose: session.purpose ?? "playback",
          profileId: session.profileId,
        });
        try {
          await startSession(token, created.sessionId, session.clientType, session.clientVersion);
        } catch (error) {
          await endSession(token, created.sessionId);
          throw error;
        }
        tunnelLog("tunnel.download_session.open", { placementId, sessionId: created.sessionId });
        return { sessionId: created.sessionId, openedAt: Date.now() };
      })();
      current = opened;
      opened.catch(() => {
        if (current === opened) current = null;
      });
      return opened;
    };
    const downloadOne = async (objectKey: string, options?: StorageDownloadSessionObjectOptions): Promise<Uint8Array> => {
      if (closed) throw new Error("TUNNEL_DOWNLOAD_SESSION_CLOSED");
      const objectOptions = { ...options, ...sessionOptions };
      if (!placementId || parseMediaPlacementIdFromObjectKey(objectKey) !== placementId) {
        return downloadObject(token, objectKey, objectOptions);
      }
      let opened = current;
      if (opened && Date.now() - (await opened.then((value) => value.openedAt).catch(() => 0)) >= REUSED_SESSION_RENEW_MS) {
        await drop(opened);
      }
      opened = acquire();
      try {
        const { sessionId } = await opened;
        return await downloadObjectOnce(token, objectKey, objectOptions, { sessionId });
      } catch (error) {
        await drop(opened);
        if (isPlaybackStoppedError(error) || isFinalSessionRefusal(error)) throw error;
        tunnelLog("tunnel.download_session.fallback", {
          placementId,
          objectKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return downloadObject(token, objectKey, objectOptions);
      }
    };
    return {
      download(objectKey: string, options?: StorageDownloadSessionObjectOptions) {
        const run = queue.then(() => downloadOne(objectKey, options));
        queue = run.catch(() => undefined);
        return run;
      },
      async close() {
        await queue;
        closed = true;
        await drop(current);
      },
    };
  };

  const downloadObjectToSink = async (
    token: string,
    objectKey: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    options?: {
      clientType?: string;
      clientVersion?: string;
      downloadId?: string;
      receiveWindow?: number;
      /** Session purpose; `export` for offline downloads / exports (allowed when unpaid). Default `playback`. */
      purpose?: StorageTunnelPurpose;
      /** The profile this playback is for, over the client's `getProfileId` (STOR-BW-11). */
      profileId?: string | null;
      hints?: StorageDownloadHints;
    }
  ) => {
    let bytes = 0;
    await downloadObject(token, objectKey, {
      ...options,
      onChunk: async (chunk) => {
        bytes += chunk.byteLength;
        await sink(chunk);
      },
      skipAssemble: true,
    });
    return { bytes };
  };

  const tryDirectSession = async (
    baseUrl: string,
    token: string,
    resolved: ResolvedGateway,
    purpose: StorageTunnelPurpose,
    profileId: string | null
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waterfallTimeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/storage/tunnel/session`, {
        method: "POST",
        headers: getBearerHeaders(token, getAppId()),
        body: JSON.stringify({
          shardId: resolved.shardId,
          placementEpoch: resolved.placementEpoch,
          objectKeyPrefix: resolved.objectKeyPrefix,
          purpose,
          ...(profileId ? { profileId } : {}),
        }),
        signal: controller.signal as any,
      });
      const session = await readSessionResponse(res, baseUrl);
      observeTraffic(baseUrl, session.traffic);
      return session;
    } finally {
      clearTimeout(timer);
    }
  };

  // Existence check through the API's POST /storage/head, which fans out to
  // each key's gateway; works in every tunnel mode. Batches of
  // STORAGE_HEAD_BATCH_KEYS (the per-request cap). A key the API could not
  // place on a gateway is absent from the result; callers treat absent as
  // unknown. Any failed batch throws.
  const headObjects = async (
    token: string,
    objectKeys: string[],
    options?: { signal?: AbortSignal }
  ): Promise<Record<string, boolean>> => {
    const apiBase = normalizeBaseUrl(input.getApiBaseUrl());
    const appId = getAppId();
    const exists: Record<string, boolean> = {};
    for (let i = 0; i < objectKeys.length; i += STORAGE_HEAD_BATCH_KEYS) {
      const res = await fetchImpl(`${apiBase}/storage/head`, {
        method: "POST",
        headers: getBearerHeaders(token, appId),
        body: JSON.stringify({ keys: objectKeys.slice(i, i + STORAGE_HEAD_BATCH_KEYS) }),
        signal: options?.signal,
      });
      const payload = await readJsonResponse<{ exists?: Record<string, boolean> }>(res);
      Object.assign(exists, payload.exists ?? {});
    }
    return exists;
  };

  // GET /storage/traffic on the gateway of the silo that holds `objectKey` (the default gateway when omitted): that silo's
  // report, `null` when unknown. For callers that wait on a silo's state while no session is open (an offline download held
  // at saturation, a stopped viewer waiting for the silo to lift); session acks already keep it fresh otherwise. At most once
  // per interval per silo (`options.minIntervalMs` overrides the client's); a failed poll keeps the last known report.
  const refreshTraffic = async (
    token: string,
    objectKey?: string,
    options?: { minIntervalMs?: number; profileId?: string | null }
  ): Promise<StorageTraffic | null> => {
    const minIntervalMs = options?.minIntervalMs ?? trafficRefreshMinIntervalMs;
    // The report of the profile that plays (its stop, STOR-BW-11); without one, the silo's state as this device.
    const profileId = readProfileId(options?.profileId) ?? readProfileId(input.getProfileId?.());
    const profileQuery = profileId ? `${PLAYBACK_PROFILE_FIELD}=${encodeURIComponent(profileId)}` : "";
    let gatewayKey: string;
    try {
      gatewayKey = (await resolveGateway(token, objectKey)).gatewayBaseUrl;
    } catch {
      return null;
    }
    const refreshKey = `${gatewayKey}#${profileId ?? ""}`;
    const url = `${gatewayKey}/storage/traffic${profileQuery ? `?${profileQuery}` : ""}`;
    const previous = trafficRefreshes.get(refreshKey);
    const now = Date.now();
    if (previous && now - previous.at < minIntervalMs) return readSiloTraffic(gatewayKey);
    trafficRefreshes.set(refreshKey, { at: now });
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: getBearerHeaders(token, getAppId()),
      });
      const payload = await readJsonResponse<{ traffic?: unknown }>(res);
      observeTraffic(gatewayKey, payload.traffic);
    } catch (error) {
      tunnelLog("tunnel.traffic.refresh_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return readSiloTraffic(gatewayKey);
  };

  const client = {
    async createSession(
      token: string,
      objectKey?: string,
      options?: { placementId?: string; purpose?: StorageTunnelPurpose; profileId?: string | null }
    ): Promise<StorageTunnelSession> {
      const placementId = options?.placementId;
      // Placement claims are uploads; everything else is playback unless the caller says export/upload.
      const purpose: StorageTunnelPurpose = options?.purpose ?? (placementId ? "upload" : "playback");
      // STOR-BW-11: a playback names its profile; none is a client bug, refused here before any request, never guessed.
      const needsProfile = sessionNeedsProfile(purpose);
      const profileId = needsProfile ? (readProfileId(options?.profileId) ?? readProfileId(input.getProfileId?.())) : null;
      if (needsProfile && !profileId) {
        tunnelLog("tunnel.session.profile_required", { purpose, appId: getAppId(), objectKey: objectKey ?? null });
        throw new StorageTunnelError(400, { error: PLAYBACK_PROFILE_REQUIRED_CODE });
      }
      const resolved = await resolveGateway(token, objectKey, placementId);
      const { objectKeyPrefix, resolvedObjectKey } = resolved;

      if (isWaterfall) {
        // Check winner cache
        const cached = waterfallWinnerCache.get(resolved.shardId);
        if (cached && cached.expiresAt > Date.now()) {
          try {
            const session = await tryDirectSession(cached.url, token, resolved, purpose, profileId);
            sessionGatewayById.set(session.sessionId, cached.url);
            return { ...session, shardId: session.shardId ?? resolved.shardId, placementEpoch: resolved.placementEpoch, objectKeyPrefix: session.objectKeyPrefix ?? objectKeyPrefix, resolvedObjectKey };
          } catch (err) {
            if (isFinalSessionRefusal(err)) throw err;
            waterfallWinnerCache.delete(resolved.shardId);
          }
        }

        // Build candidate list from addresses, deduped
        const seen = new Set<string>();
        const candidates: string[] = [];
        for (const url of resolved.addresses) {
          const n = normalizeBaseUrl(url);
          if (!seen.has(n)) { seen.add(n); candidates.push(n); }
        }
        if (!seen.has(normalizeBaseUrl(resolved.gatewayBaseUrl))) {
          candidates.push(normalizeBaseUrl(resolved.gatewayBaseUrl));
        }

        tunnelLog("tunnel.waterfall.start", {
          candidateCount: candidates.length,
          candidates,
          timeoutMs: waterfallTimeoutMs,
        });

        // Try each candidate; when every one fails, the last error is thrown (a transport error the caller retries).
        let lastError: unknown = new StorageTunnelError(503, { error: "storage_tunnel_no_gateway_candidate" });
        for (let i = 0; i < candidates.length; i++) {
          const baseUrl = candidates[i];
          try {
            const session = await tryDirectSession(baseUrl, token, resolved, purpose, profileId);
            sessionGatewayById.set(session.sessionId, baseUrl);
            waterfallWinnerCache.set(resolved.shardId, { url: baseUrl, expiresAt: Date.now() + 60_000 });
            tunnelLog("tunnel.waterfall.winner", { baseUrl, attempt: i + 1 });
            return { ...session, shardId: session.shardId ?? resolved.shardId, placementEpoch: resolved.placementEpoch, objectKeyPrefix: session.objectKeyPrefix ?? objectKeyPrefix, resolvedObjectKey };
          } catch (err) {
            // A refused subscription (402) or a refused free playback session (503) is final: another address would answer the same.
            if (isFinalSessionRefusal(err)) throw err;
            lastError = err;
            tunnelLog("tunnel.waterfall.attempt_failed", {
              baseUrl,
              attempt: i + 1,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        tunnelLog("tunnel.waterfall.all_failed", {
          candidateCount: candidates.length,
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
        throw lastError;
      }

      // Direct mode (default)
      const res = await fetchImpl(`${resolved.gatewayBaseUrl}/storage/tunnel/session`, {
        method: "POST",
        headers: getBearerHeaders(token, getAppId()),
        body: JSON.stringify({
          shardId: resolved.shardId,
          placementEpoch: resolved.placementEpoch,
          objectKeyPrefix,
          purpose,
          ...(profileId ? { profileId } : {}),
        }),
      });
      const session = await readSessionResponse(res, resolved.gatewayBaseUrl);
      sessionGatewayById.set(session.sessionId, resolved.gatewayBaseUrl);
      observeTraffic(resolved.gatewayBaseUrl, session.traffic);
      return {
        ...session,
        shardId: session.shardId ?? resolved.shardId,
        placementEpoch: resolved.placementEpoch,
        objectKeyPrefix: session.objectKeyPrefix ?? objectKeyPrefix,
        resolvedObjectKey,
      };
    },
    async sendFrame(token: string, sessionId: string, frame: TunnelClientFrame): Promise<TunnelGatewayFrame> {
      const gatewayBaseUrl = sessionGatewayById.get(sessionId);
      if (!gatewayBaseUrl) {
        throw new StorageTunnelError(400, { error: "storage_tunnel_session_gateway_missing" });
      }
      const connectionKey = `${gatewayBaseUrl}::${sessionId}`;
      const normalizedFrame = normalizeOutgoingFrame(frame);
      const kind = String(normalizedFrame.kind ?? "");
      const finalizeSession = () => {
        const connPromise = wsConnections.get(connectionKey);
        wsConnections.delete(connectionKey);
        sessionGatewayById.delete(sessionId);
        sessionHttpFrameChain.delete(sessionId);
        if (connPromise) {
          void connPromise.then((conn) => conn.close()).catch(() => undefined);
        }
      };

      let result: TunnelGatewayFrame;
      if (!wsEnabled) {
        result = await sendFrameHttpOrdered(token, sessionId, normalizedFrame);
      } else {
        try {
          const conn = await getWsConnection(token, sessionId, gatewayBaseUrl);
          result = await conn.sendFrame(normalizedFrame);
        } catch {
          wsConnections.delete(connectionKey);
          result = await sendFrameHttpOrdered(token, sessionId, normalizedFrame);
        }
      }
      if (String(result.kind ?? "") === "session.ack") observeSessionTraffic(sessionId, result.traffic);
      if (kind === "session.end") finalizeSession();
      return result;
    },
    startSession,
    getTraffic: readTraffic,
    refreshTraffic,
    endSession,
    uploadObject,
    createUploadSession,
    createDownloadSession,
    downloadObject,
    downloadObjectToSink,
    headObjects,
    resolveMediaPlacements,
    resolveMediaPlacement,
  };

  // A session open that reaches a copy that has just gone away (restart of the copy the cached placement names)
  // is retried on a fresh placement: the API no longer lists a draining or absent copy (STOR-GATEWAY-01).
  const openSessionOnce = client.createSession.bind(client);
  const sessionOpenRetryDelaysMs = input.sessionOpenRetryDelaysMs ?? [400, 1000, 2500];
  client.createSession = async (token, objectKey, options) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await openSessionOnce(token, objectKey, options);
      } catch (err) {
        const delayMs = sessionOpenRetryDelaysMs[attempt];
        if (delayMs === undefined || isFinalSessionRefusal(err) || !isTransientStorageTransportError(err)) {
          throw err;
        }
        tunnelLog("tunnel.session_open.retry", {
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        placementCacheByToken.delete(token.trim());
        for (const key of [...mediaPlacementCache.keys()]) {
          if (key.startsWith(`${token.trim()}::`)) mediaPlacementCache.delete(key);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };

  return client;
};

/** The per-user storage tunnel client: sessions, frames, object upload/download over one app scope. */
export type UserStorageTunnelClient = ReturnType<typeof createUserStorageTunnelClient>;
