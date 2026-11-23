import type {
  StorageTunnelClientFrame,
  StorageTunnelDownloadAckFrame,
  StorageTunnelDownloadDataFrame,
  StorageTunnelDownloadOpenFrame,
  StorageTunnelFrame,
  StorageTunnelGatewayFrame,
  StorageTunnelUploadDataFrame,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isUint8ArrayLike = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

export const validateClientFrame = (frame: unknown): frame is StorageTunnelClientFrame => {
  if (!isRecord(frame) || !isString(frame.kind)) return false;
  switch (frame.kind) {
    case "session.start":
      return (
        isString(frame.sessionId) &&
        isString(frame.token) &&
        isString(frame.clientType) &&
        isString(frame.clientVersion) &&
        (frame.capabilities === undefined ||
          (Array.isArray(frame.capabilities) && frame.capabilities.every((entry) => typeof entry === "string")))
      );
    case "session.end":
      return isString(frame.sessionId);
    case "upload.open":
      return (
        isString(frame.uploadId) &&
        isString(frame.objectKey) &&
        isString(frame.objectNamespace) &&
        isString(frame.logicalRef) &&
        (frame.expectedBytes === undefined || isNonNegativeInteger(frame.expectedBytes)) &&
        (frame.resumeId === undefined || isString(frame.resumeId)) &&
        (frame.replacesBytes === undefined || isNonNegativeInteger(frame.replacesBytes)) &&
        (frame.role === undefined || isString(frame.role)) &&
        (frame.declaredBytes === undefined || isNonNegativeInteger(frame.declaredBytes))
      );
    case "upload.data":
      return (
        isString(frame.uploadId) &&
        isNonNegativeInteger(frame.seq) &&
        isString(frame.checksum) &&
        isUint8ArrayLike(frame.ciphertext)
      );
    case "upload.flush":
    case "upload.close":
      return isString(frame.uploadId);
    case "download.open":
    case "download.stream.start":
      return (
        isString(frame.downloadId) &&
        isString(frame.objectKey) &&
        isNonNegativeInteger(frame.rangeStart) &&
        (frame.rangeEnd === null || isNonNegativeInteger(frame.rangeEnd)) &&
        (frame.rangeEnd === null || frame.rangeEnd >= frame.rangeStart) &&
        (frame.receiveWindow === undefined || isNonNegativeInteger(frame.receiveWindow))
      );
    case "download.ack":
    case "download.stream.credit":
      return (
        isString(frame.downloadId) &&
        isNonNegativeInteger(frame.receivedSeq) &&
        isNonNegativeInteger(frame.receiveWindow)
      );
    case "download.close":
    case "download.stream.close":
      return isString(frame.downloadId);
    default:
      return false;
  }
};

export const validateGatewayFrame = (frame: unknown): frame is StorageTunnelGatewayFrame => {
  if (!isRecord(frame) || !isString(frame.kind)) return false;
  switch (frame.kind) {
    case "session.ack":
      return isString(frame.sessionId) && frame.protocolVersion === 1;
    case "session.error":
      return isString(frame.sessionId) && isString(frame.code) && isString(frame.message);
    case "upload.ack":
      return isString(frame.uploadId) && isNonNegativeInteger(frame.seq) && isNonNegativeInteger(frame.persistedBytes);
    case "upload.progress":
      return (
        isString(frame.uploadId) &&
        isNonNegativeInteger(frame.bytesAccepted) &&
        isNonNegativeInteger(frame.bytesPersisted) &&
        (frame.resumeId === undefined || isString(frame.resumeId))
      );
    case "upload.error":
      return isString(frame.uploadId) && isString(frame.code) && isString(frame.message);
    case "upload.complete":
      return isString(frame.uploadId) && Array.isArray(frame.objectKeys) && frame.objectKeys.every(isString);
    case "download.data":
      return (
        isString(frame.downloadId) &&
        isNonNegativeInteger(frame.seq) &&
        isString(frame.checksum) &&
        isUint8ArrayLike(frame.ciphertext)
      );
    case "download.progress":
      return isString(frame.downloadId) && isNonNegativeInteger(frame.bytesSent) && isNonNegativeInteger(frame.bytesRemaining);
    case "download.error":
      return isString(frame.downloadId) && isString(frame.code) && isString(frame.message);
    case "download.complete":
      return isString(frame.downloadId);
    default:
      return false;
  }
};

export const validateFrame = (frame: unknown): frame is StorageTunnelFrame =>
  validateClientFrame(frame) || validateGatewayFrame(frame);

export const isUploadDataFrame = (frame: StorageTunnelFrame): frame is StorageTunnelUploadDataFrame =>
  frame.kind === "upload.data";

export const isDownloadDataFrame = (frame: StorageTunnelFrame): frame is StorageTunnelDownloadDataFrame =>
  frame.kind === "download.data";

export const isDownloadOpenFrame = (frame: StorageTunnelFrame): frame is StorageTunnelDownloadOpenFrame =>
  frame.kind === "download.open";

export const isDownloadAckFrame = (frame: StorageTunnelFrame): frame is StorageTunnelDownloadAckFrame =>
  frame.kind === "download.ack";
