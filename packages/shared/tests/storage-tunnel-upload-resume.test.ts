/**
 * @test-id SHARED-STORAGE-TUNNEL-UPLOAD-RESUME-001
 * @level unit (stateful fetch stand-in for the gateway, fake timers)
 * @req STOR-GATEWAY-04
 * @why A client whose upload is interrupted (gateway restart or drain, a session the API lost) must resume from the last
 *      accepted part instead of starting over: reopen on a new session with the `resumeId` the gateway named, continue
 *      from the answered `bytesPersisted`, and never end the broken session (that would abort the assembly it resumes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient, StorageTunnelError } from "../src/storageTunnel";

const SUITE = "SHARED-STORAGE-TUNNEL-UPLOAD-RESUME-001";
const fetchMock = vi.fn();

type SentFrame = { sessionId: string; frame: Record<string, unknown> };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
});

/** A gateway stand-in: sessions s1, s2, ...; `onFrame` answers each frame (return a Response to override the default). */
const installGateway = (onFrame: (sent: SentFrame, all: SentFrame[]) => Response | null) => {
  const sent: SentFrame[] = [];
  let sessions = 0;
  fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/storage/placement")) {
      return jsonResponse({
        policy: {
          policy: "rendezvous-v1",
          epoch: 1,
          seed: "s",
          replicaCount: 1,
          shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
        },
      });
    }
    if (url.endsWith("/storage/tunnel/session")) {
      sessions += 1;
      return jsonResponse({
        sessionId: `s${sessions}`,
        protocolVersion: 1,
        createdAt: 1,
        expiresAt: 2,
        features: { upload: true, download: true },
      });
    }
    const body = JSON.parse(String(init?.body)) as SentFrame;
    sent.push(body);
    console.info(`[${SUITE}] -> ${body.sessionId} ${JSON.stringify({ ...body.frame, ciphertextBase64: body.frame.ciphertextBase64 ? "<b64>" : undefined })}`);
    const custom = onFrame(body, sent);
    if (custom) return custom;
    const kind = String(body.frame.kind);
    const uploadId = String(body.frame.uploadId ?? "");
    if (kind === "session.start" || kind === "session.end") return jsonResponse({ frame: { kind: "session.ack" } });
    if (kind === "upload.data") return jsonResponse({ frame: { kind: "upload.ack", uploadId, seq: body.frame.seq } });
    if (kind === "upload.close") return jsonResponse({ frame: { kind: "upload.complete", uploadId, objectKeys: ["library/chunks/a"] } });
    throw new Error(`unexpected frame ${kind}`);
  });
  return sent;
};

const dataOf = (frames: SentFrame[], sessionId: string) =>
  frames
    .filter((entry) => entry.sessionId === sessionId && entry.frame.kind === "upload.data")
    .map((entry) => ({
      seq: entry.frame.seq,
      hex: Buffer.from(String(entry.frame.ciphertextBase64), "base64").toString("hex"),
    }));

const newClient = () =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => "https://api.dev.spacebadger.io",
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
  });

const progress = (bytes: number) => ({
  frame: { kind: "upload.progress", uploadId: "u1", bytesAccepted: bytes, bytesPersisted: bytes, resumeId: "mp-abc" },
});

describe("@req STOR-GATEWAY-04 client resumes an interrupted upload", () => {
  it("reopens on a new session with the resumeId, continues from the kept bytes and leaves the broken session alone", async () => {
    const phase = "resume-after-lost-session";
    const sent = installGateway((frame) => {
      if (frame.frame.kind === "upload.open" && frame.sessionId === "s1") return jsonResponse(progress(0));
      // The gateway of session s1 goes away while the second chunk is sent: the API answers 404 invalid_session.
      if (frame.frame.kind === "upload.data" && frame.sessionId === "s1" && frame.frame.seq === 1) {
        return jsonResponse({ error: "invalid_session" }, 404);
      }
      // Another copy kept the first 8 bytes (two chunks' worth of whole parts).
      if (frame.frame.kind === "upload.open" && frame.sessionId === "s2") return jsonResponse(progress(8));
      return null;
    });
    const settled = newClient()
      .uploadObject("token-1", "library/chunks/a", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), {
        uploadId: "u1",
        chunkSize: 4,
        checksumFn: () => "sha256:x",
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await settled;
    const kinds = sent.map((entry) => `${entry.sessionId}:${String(entry.frame.kind)}`);
    console.info(`[${SUITE}:${phase}] result=${JSON.stringify(result)} frames=${JSON.stringify(kinds)}`);
    expect(result).toMatchObject({ ok: true });
    expect(sent.find((entry) => entry.sessionId === "s2" && entry.frame.kind === "upload.open")?.frame.resumeId).toBe("mp-abc");
    expect(sent.find((entry) => entry.sessionId === "s1" && entry.frame.kind === "upload.open")?.frame.resumeId).toBeUndefined();
    // Only the bytes after the kept ones are sent again, with sequence numbers restarting on the new upload.
    expect(dataOf(sent, "s2")).toEqual([{ seq: 0, hex: "090a0b0c" }]);
    expect(kinds).not.toContain("s1:session.end");
    expect(kinds).toContain("s2:session.end");
    expect(kinds.filter((kind) => kind === "s2:upload.close")).toHaveLength(1);
  });

  it("starts from zero when the gateway cannot resume (the answer carries no kept bytes)", async () => {
    const phase = "resume-not-possible";
    const sent = installGateway((frame) => {
      if (frame.frame.kind === "upload.open") return jsonResponse(progress(0));
      if (frame.frame.kind === "upload.data" && frame.sessionId === "s1" && frame.frame.seq === 1) {
        return jsonResponse({ error: "bad_gateway" }, 502);
      }
      return null;
    });
    const settled = newClient()
      .uploadObject("token-1", "library/chunks/a", Uint8Array.from([1, 2, 3, 4, 5, 6]), {
        uploadId: "u1",
        chunkSize: 4,
        checksumFn: () => "sha256:x",
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await settled;
    console.info(`[${SUITE}:${phase}] result=${JSON.stringify(result)} s2data=${JSON.stringify(dataOf(sent, "s2"))}`);
    expect(result).toMatchObject({ ok: true });
    expect(dataOf(sent, "s2")).toEqual([
      { seq: 0, hex: "01020304" },
      { seq: 1, hex: "0506" },
    ]);
  });

  it("a permanent error ends the session as before and is not resumed", async () => {
    const phase = "permanent-error";
    const sent = installGateway((frame) => {
      if (frame.frame.kind === "upload.open") return jsonResponse(progress(0));
      if (frame.frame.kind === "upload.data") return jsonResponse({ error: "upload_quota_exceeded" }, 413);
      return null;
    });
    const settled = newClient()
      .uploadObject("token-1", "library/chunks/a", Uint8Array.from([1, 2, 3, 4]), { uploadId: "u1", chunkSize: 4, checksumFn: () => "sha256:x" })
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof StorageTunnelError ? error.status : undefined)
      );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await settled;
    const kinds = sent.map((entry) => `${entry.sessionId}:${String(entry.frame.kind)}`);
    console.info(`[${SUITE}:${phase}] outcome=${String(outcome)} frames=${JSON.stringify(kinds)}`);
    expect(outcome).toBe(413);
    expect(kinds).toContain("s1:session.end");
    expect(kinds.filter((kind) => kind.endsWith(":upload.open"))).toHaveLength(1);
  });

  it("gives up after the resume budget and ends the last session", async () => {
    const phase = "budget-spent";
    const sent = installGateway((frame) => {
      if (frame.frame.kind === "upload.open") return jsonResponse(progress(0));
      if (frame.frame.kind === "upload.data") return jsonResponse({ error: "bad_gateway" }, 502);
      return null;
    });
    const settled = newClient()
      .uploadObject("token-1", "library/chunks/a", Uint8Array.from([1, 2, 3, 4]), { uploadId: "u1", chunkSize: 4, checksumFn: () => "sha256:x" })
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof StorageTunnelError ? error.status : undefined)
      );
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;
    const opens = sent.filter((entry) => entry.frame.kind === "upload.open");
    const ended = sent.filter((entry) => entry.frame.kind === "session.end").map((entry) => entry.sessionId);
    console.info(`[${SUITE}:${phase}] outcome=${String(outcome)} opens=${opens.length} ended=${JSON.stringify(ended)}`);
    expect(outcome).toBe(502);
    // The first open plus one per resume in the budget; only the final session is ended.
    expect(opens).toHaveLength(6);
    expect(ended).toEqual(["s6"]);
  });
});
