import { describe, expect, it } from "vitest";
import {
  FlowWindow,
  SequenceTracker,
  validateClientFrame,
  validateFrame,
  validateGatewayFrame,
} from "../src/storageTransport/v2";

// On a validation/sequence/flow-window assertion failure, dump the frame (or
// tracker/window state) and the validator verdicts so CI logs show exactly which
// predicate disagreed without a local repro.
const dumpStorageTunnelSnapshot = (label: string, ctx: Record<string, unknown>): void => {
  try {
    console.error(`=== [storage-tunnel-v2:${label}] snapshot ===`);
    console.error(
      `context:\n${JSON.stringify(
        ctx,
        (_k, v) =>
          v instanceof Uint8Array ? `Uint8Array(len=${v.length})[${Array.from(v).join(",")}]` : v,
        2,
      )}`,
    );
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("storage transport v2 frame validation", () => {
  it("accepts valid upload and download client frames", () => {
    console.info(
      "[storage-tunnel-v2:accept-client] validating upload.open / upload.data / download.open (expect all true)",
    );
    const uploadOpen = {
      kind: "upload.open",
      uploadId: "up-1",
      objectKey: "library/chunks/abc",
      objectNamespace: "library",
      logicalRef: "media:abc",
      expectedBytes: 1024,
    };
    const uploadData = {
      kind: "upload.data",
      uploadId: "up-1",
      seq: 0,
      checksum: "abc123",
      ciphertext: new Uint8Array([1, 2, 3]),
    };
    const downloadOpen = {
      kind: "download.open",
      downloadId: "dl-1",
      objectKey: "library/chunks/xyz",
      rangeStart: 0,
      rangeEnd: 1024,
      receiveWindow: 16,
    };

    const verdicts = {
      uploadOpen_client: validateClientFrame(uploadOpen),
      uploadOpen_frame: validateFrame(uploadOpen),
      uploadData_client: validateClientFrame(uploadData),
      downloadOpen_client: validateClientFrame(downloadOpen),
      uploadData_frame: validateFrame(uploadData),
      downloadOpen_frame: validateFrame(downloadOpen),
    };
    if (Object.values(verdicts).some((v) => v !== true)) {
      dumpStorageTunnelSnapshot("accept-client", { uploadOpen, uploadData, downloadOpen, verdicts });
    }
    expect(verdicts.uploadOpen_client).toBe(true);
    expect(verdicts.uploadOpen_frame).toBe(true);
    expect(verdicts.uploadData_client).toBe(true);
    expect(verdicts.downloadOpen_client).toBe(true);
    expect(verdicts.uploadData_frame).toBe(true);
    expect(verdicts.downloadOpen_frame).toBe(true);
  });

  it("@req STOR-GATEWAY-04 accepts a resumeId on upload.open and upload.progress, and only a string", () => {
    const open = { kind: "upload.open", uploadId: "up-1", objectKey: "k", objectNamespace: "library", logicalRef: "r", expectedBytes: 1 };
    const progress = { kind: "upload.progress", uploadId: "up-1", bytesAccepted: 8, bytesPersisted: 8 };
    const verdicts = {
      openWithResumeId: validateClientFrame({ ...open, resumeId: "mp-1" }),
      openWithBadResumeId: validateClientFrame({ ...open, resumeId: 7 }),
      progressWithResumeId: validateGatewayFrame({ ...progress, resumeId: "mp-1" }),
      progressWithBadResumeId: validateGatewayFrame({ ...progress, resumeId: 7 }),
      progressWithout: validateGatewayFrame(progress),
    };
    console.info(`[storage-tunnel-v2:resume-id] verdicts=${JSON.stringify(verdicts)}`);
    expect(verdicts).toEqual({
      openWithResumeId: true,
      openWithBadResumeId: false,
      progressWithResumeId: true,
      progressWithBadResumeId: false,
      progressWithout: true,
    });
  });

  it("rejects invalid client frame ranges and payloads", () => {
    console.info(
      "[storage-tunnel-v2:reject-client] validating inverted range / non-bytes ciphertext / negative window (expect all false)",
    );
    const invalidDownloadOpen = {
      kind: "download.open",
      downloadId: "dl-1",
      objectKey: "library/chunks/xyz",
      rangeStart: 500,
      rangeEnd: 100,
    };
    const invalidUploadData = {
      kind: "upload.data",
      uploadId: "up-1",
      seq: 0,
      checksum: "abc123",
      ciphertext: "not-bytes",
    };
    const invalidDownloadWindow = {
      kind: "download.open",
      downloadId: "dl-1",
      objectKey: "library/chunks/xyz",
      rangeStart: 0,
      rangeEnd: 100,
      receiveWindow: -1,
    };

    const verdicts = {
      invalidDownloadOpen_client: validateClientFrame(invalidDownloadOpen),
      invalidUploadData_client: validateClientFrame(invalidUploadData),
      invalidDownloadOpen_frame: validateFrame(invalidDownloadOpen),
      invalidUploadData_frame: validateFrame(invalidUploadData),
      invalidDownloadWindow_frame: validateFrame(invalidDownloadWindow),
    };
    if (Object.values(verdicts).some((v) => v !== false)) {
      dumpStorageTunnelSnapshot("reject-client", {
        invalidDownloadOpen,
        invalidUploadData,
        invalidDownloadWindow,
        verdicts,
      });
    }
    expect(verdicts.invalidDownloadOpen_client).toBe(false);
    expect(verdicts.invalidUploadData_client).toBe(false);
    expect(verdicts.invalidDownloadOpen_frame).toBe(false);
    expect(verdicts.invalidUploadData_frame).toBe(false);
    expect(verdicts.invalidDownloadWindow_frame).toBe(false);
  });

  it("accepts valid gateway frames", () => {
    console.info(
      "[storage-tunnel-v2:accept-gateway] validating upload.ack / download.data (expect all true)",
    );
    const uploadAck = {
      kind: "upload.ack",
      uploadId: "up-1",
      seq: 2,
      persistedBytes: 1024,
    };
    const downloadData = {
      kind: "download.data",
      downloadId: "dl-1",
      seq: 7,
      checksum: "sha256:e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db",
      ciphertext: new Uint8Array([5]),
    };

    const verdicts = {
      uploadAck_gateway: validateGatewayFrame(uploadAck),
      downloadData_gateway: validateGatewayFrame(downloadData),
      uploadAck_frame: validateFrame(uploadAck),
      downloadData_frame: validateFrame(downloadData),
    };
    if (Object.values(verdicts).some((v) => v !== true)) {
      dumpStorageTunnelSnapshot("accept-gateway", { uploadAck, downloadData, verdicts });
    }
    expect(verdicts.uploadAck_gateway).toBe(true);
    expect(verdicts.downloadData_gateway).toBe(true);
    expect(verdicts.uploadAck_frame).toBe(true);
    expect(verdicts.downloadData_frame).toBe(true);
  });
});

describe("storage transport v2 sequencing", () => {
  it("enforces strict in-order delivery and reports expected seq", () => {
    console.info(
      "[storage-tunnel-v2:sequencing] applying seq order 0,2,0,1 (expect accepted/out_of_order/duplicate/accepted)",
    );
    const tracker = new SequenceTracker();

    const results = {
      apply0: tracker.apply(0),
      apply2: tracker.apply(2),
      apply0again: tracker.apply(0),
      apply1: tracker.apply(1),
      expectedSeq: tracker.getExpectedSeq(),
    };
    try {
      expect(results.apply0).toEqual({ ok: true, status: "accepted", expectedSeq: 1 });
      expect(results.apply2).toEqual({ ok: false, status: "out_of_order", expectedSeq: 1 });
      expect(results.apply0again).toEqual({ ok: true, status: "duplicate", expectedSeq: 1 });
      expect(results.apply1).toEqual({ ok: true, status: "accepted", expectedSeq: 2 });
      expect(results.expectedSeq).toBe(2);
    } catch (err) {
      dumpStorageTunnelSnapshot("sequencing", { results });
      throw err;
    }
  });
});

describe("storage transport v2 flow window", () => {
  it("caps inflight frames and releases on ack", () => {
    console.info(
      "[storage-tunnel-v2:flow-window] capacity=3; sending 1+2 to saturate, then ack 2 to release",
    );
    const window = new FlowWindow(3);

    const trace = {
      send1: window.onSend(),
      send2: window.onSend(2),
      sendOverCap: window.onSend(),
      statsAtCap: window.getStats(),
    };
    window.onAck(2);
    const afterAck = { stats: window.getStats(), sendAfterAck: window.onSend(2) };
    try {
      expect(trace.send1).toBe(true);
      expect(trace.send2).toBe(true);
      expect(trace.sendOverCap).toBe(false);
      expect(trace.statsAtCap).toEqual({ inflight: 3, available: 0, maxInFlight: 3 });
      expect(afterAck.stats).toEqual({ inflight: 1, available: 2, maxInFlight: 3 });
      expect(afterAck.sendAfterAck).toBe(true);
    } catch (err) {
      dumpStorageTunnelSnapshot("flow-window", { trace, afterAck });
      throw err;
    }
  });

  it("rejects invalid window size", () => {
    console.info("[storage-tunnel-v2:flow-window-invalid] constructing FlowWindow(0) (expect throw)");
    expect(() => new FlowWindow(0)).toThrow("invalid_flow_window_size");
  });
});
