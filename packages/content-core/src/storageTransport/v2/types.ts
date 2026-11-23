export type StorageTunnelClientType = "desktop" | "mobile" | "tv" | "unknown";

export type StorageTunnelSessionStartFrame = {
  kind: "session.start";
  sessionId: string;
  token: string;
  clientType: StorageTunnelClientType;
  clientVersion: string;
  capabilities?: string[];
};

export type StorageTunnelSessionEndFrame = {
  kind: "session.end";
  sessionId: string;
};

export type StorageTunnelUploadOpenFrame = {
  kind: "upload.open";
  uploadId: string;
  objectKey: string;
  objectNamespace: string;
  logicalRef: string;
  expectedBytes?: number;
  /** Continue an interrupted multipart upload: the `resumeId` an earlier `upload.progress` named. The answer's `bytesPersisted` says where to continue. */
  resumeId?: string;
  /**
   * The upload replaces a stored file (a Replace, STOR-QUOTA-03): how many bytes deleting that file frees, never which file. The
   * user's dataset refquota gets that much extra room, as far as the API grants it, while this upload lasts (STOR-GATEWAY-06).
   */
  replacesBytes?: number;
  /** How the object counts toward the allowance (STOR-USE-02, `StorageObjectRole`); absent or unknown: `other`. */
  role?: string;
  /** `source` only: the piece's share of the original file's size; the API counts at least 90% of the stored bytes. */
  declaredBytes?: number;
  /**
   * With `resealOf`: the upload is a copy re-sealed under the account's next media library key for this open re-seal run
   * (STOR-RESEAL-03). It reserves nothing against the allowance and can store no more than `resealOf`'s bytes.
   */
  resealRunId?: string;
  /** With `resealRunId`: the key of the live media object the upload copies. */
  resealOf?: string;
};

export type StorageTunnelUploadDataFrame = {
  kind: "upload.data";
  uploadId: string;
  seq: number;
  checksum: string;
  ciphertext: Uint8Array;
};

export type StorageTunnelUploadFlushFrame = {
  kind: "upload.flush";
  uploadId: string;
};

export type StorageTunnelUploadCloseFrame = {
  kind: "upload.close";
  uploadId: string;
};

/**
 * Optional playback hints for the gateway's per-viewer bandwidth scheduler (STOR-BW-04). The gateway clamps and bounds
 * every value; a client that sends none is served with the server defaults.
 */
export type StorageTunnelDownloadHints = {
  /** Playback the client already holds, in ms. */
  bufferedMs?: number;
  /** Declared playback bitrate of the stream, bits per second. */
  playbackBps?: number;
};

export type StorageTunnelDownloadOpenFrame = StorageTunnelDownloadHints & {
  kind: "download.open";
  downloadId: string;
  objectKey: string;
  rangeStart: number;
  rangeEnd: number | null;
  receiveWindow?: number;
  /** Start of a playback or a seek: the first bytes are served ahead of the other downloads of the class. */
  burst?: "start" | "seek";
};

export type StorageTunnelDownloadStreamStartFrame = StorageTunnelDownloadHints & {
  kind: "download.stream.start";
  downloadId: string;
  objectKey: string;
  rangeStart: number;
  rangeEnd: number | null;
  receiveWindow?: number;
  burst?: "start" | "seek";
};

export type StorageTunnelDownloadAckFrame = StorageTunnelDownloadHints & {
  kind: "download.ack";
  downloadId: string;
  receivedSeq: number;
  receiveWindow: number;
};

export type StorageTunnelDownloadStreamCreditFrame = StorageTunnelDownloadHints & {
  kind: "download.stream.credit";
  downloadId: string;
  receivedSeq: number;
  receiveWindow: number;
};

export type StorageTunnelDownloadCloseFrame = {
  kind: "download.close";
  downloadId: string;
};

export type StorageTunnelDownloadStreamCloseFrame = {
  kind: "download.stream.close";
  downloadId: string;
};

export type StorageTunnelClientFrame =
  | StorageTunnelSessionStartFrame
  | StorageTunnelSessionEndFrame
  | StorageTunnelUploadOpenFrame
  | StorageTunnelUploadDataFrame
  | StorageTunnelUploadFlushFrame
  | StorageTunnelUploadCloseFrame
  | StorageTunnelDownloadOpenFrame
  | StorageTunnelDownloadStreamStartFrame
  | StorageTunnelDownloadAckFrame
  | StorageTunnelDownloadStreamCreditFrame
  | StorageTunnelDownloadCloseFrame
  | StorageTunnelDownloadStreamCloseFrame;

export type StorageTunnelSessionAckFrame = {
  kind: "session.ack";
  sessionId: string;
  protocolVersion: 1;
  /**
   * Gateway load of this silo (STOR-BW-01, 07..09, PLAY-QUAL-07): `state: "high"` while the silo link is busy or saturated; `saturated`
   * while it is at about 90% of its link; `qualityCap` the highest quality the account's plan may play while saturated; `playbackStopped`
   * when this viewer's playback was stopped (it stays refused until the silo leaves saturation).
   */
  traffic?: {
    state: "normal" | "high";
    playbackBufferSeconds: number | null;
    saturated?: boolean;
    qualityCap?: "480p" | "1080p" | null;
    playbackStopped?: boolean;
  };
};

export type StorageTunnelSessionErrorCode = "auth_failed" | "invalid_frame" | "unsupported_version" | "session_closed";

export type StorageTunnelSessionErrorFrame = {
  kind: "session.error";
  sessionId: string;
  code: StorageTunnelSessionErrorCode;
  message: string;
};

export type StorageTunnelUploadAckFrame = {
  kind: "upload.ack";
  uploadId: string;
  seq: number;
  persistedBytes: number;
};

export type StorageTunnelUploadProgressFrame = {
  kind: "upload.progress";
  uploadId: string;
  bytesAccepted: number;
  bytesPersisted: number;
  /**
   * Answer to a multipart `upload.open`: the id of the upload on the gateway's disk. A client whose connection breaks
   * reopens with it as `resumeId` and continues from `bytesPersisted` of the answer.
   */
  resumeId?: string;
};

export type StorageTunnelUploadErrorCode =
  | "retryable"
  | "terminal"
  | "cancelled"
  | "auth"
  | "stale_session";

export type StorageTunnelUploadErrorFrame = {
  kind: "upload.error";
  uploadId: string;
  code: StorageTunnelUploadErrorCode;
  message: string;
};

export type StorageTunnelUploadCompleteFrame = {
  kind: "upload.complete";
  uploadId: string;
  objectKeys: string[];
};

export type StorageTunnelDownloadDataFrame = {
  kind: "download.data";
  downloadId: string;
  seq: number;
  checksum: string;
  ciphertext: Uint8Array;
};

export type StorageTunnelDownloadProgressFrame = {
  kind: "download.progress";
  downloadId: string;
  bytesSent: number;
  bytesRemaining: number;
};

export type StorageTunnelDownloadErrorCode =
  | "retryable"
  | "terminal"
  | "cancelled"
  | "auth"
  | "stale_session"
  | "download_source_missing"
  | "playback_stopped";

export type StorageTunnelDownloadErrorFrame = {
  kind: "download.error";
  downloadId: string;
  code: StorageTunnelDownloadErrorCode;
  message: string;
  /** On `playback_stopped`: the silo's report, so the client does not need another request. */
  traffic?: StorageTunnelSessionAckFrame["traffic"];
};

export type StorageTunnelDownloadCompleteFrame = {
  kind: "download.complete";
  downloadId: string;
};

export type StorageTunnelGatewayFrame =
  | StorageTunnelSessionAckFrame
  | StorageTunnelSessionErrorFrame
  | StorageTunnelUploadAckFrame
  | StorageTunnelUploadProgressFrame
  | StorageTunnelUploadErrorFrame
  | StorageTunnelUploadCompleteFrame
  | StorageTunnelDownloadDataFrame
  | StorageTunnelDownloadProgressFrame
  | StorageTunnelDownloadErrorFrame
  | StorageTunnelDownloadCompleteFrame;

export type StorageTunnelFrame = StorageTunnelClientFrame | StorageTunnelGatewayFrame;
