import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createCipheriv, createHmac, randomBytes } from "node:crypto";
import { Buffer } from "buffer";

/**
 * @test-id MOBILE-PLAYBACK-001
 * @level integration
 * @why Video playback on mobile uses a local TCP proxy that downloads encrypted media chunks
 *   via the storage tunnel, decrypts them, and serves them to the native player.
 *   The download path uses the same tunnel client as library sync — verifying that
 *   the download + decrypt pipeline works end-to-end without native modules.
 */

const SUITE_ID = "mobile-playback-proxy-integration";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  console.info(
    `[${SUITE_ID}:teardown] resetting fetchMock (calls=${fetchMock.mock.calls.length})`,
  );
  fetchMock.mockReset();
});

// Re-implement the media crypto logic for testing (without react-native-quick-crypto)
const MAGIC = Buffer.from("SFV1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = Buffer.from("sf-media-v1");
const MEDIA_MASTER_SALT = Buffer.from("sf-media-master-salt");
const MEDIA_MASTER_INFO = Buffer.from("sf-media-master");

const hkdfSha256 = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  let prev = Buffer.alloc(0);
  let output = Buffer.alloc(0);
  let counter = 1;
  while (output.length < length) {
    const hmac = createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(info);
    hmac.update(Buffer.from([counter]));
    prev = hmac.digest();
    output = Buffer.concat([output, prev]);
    counter += 1;
  }
  return output.subarray(0, length);
};

const deriveMediaMasterKey = (libraryKey: Buffer) =>
  hkdfSha256(libraryKey, MEDIA_MASTER_SALT, MEDIA_MASTER_INFO, 32);

const deriveObjectKey = (masterKey: Buffer, salt: Buffer) =>
  hkdfSha256(masterKey, salt, HKDF_INFO, 32);

const encryptMediaObject = (masterKey: Buffer, plaintext: Buffer) => {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveObjectKey(masterKey, salt);

  // Build padded plaintext: [origLen(4) | padLen(2) | data | padding]
  const origLen = plaintext.length;
  const padLen = 0;
  const header = Buffer.alloc(6);
  header.writeUInt32BE(origLen, 0);
  header.writeUInt16BE(padLen, 4);
  const paddedPlaintext = Buffer.concat([header, plaintext]);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(paddedPlaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, nonce, encrypted, tag]);
};

const decryptMediaObjectNode = (masterKey: Buffer, payload: Buffer) => {
  if (!payload.subarray(0, 4).equals(MAGIC)) {
    return { plaintext: new Uint8Array(payload), wasEncrypted: false };
  }
  const headerOffset = MAGIC.length;
  const salt = payload.subarray(headerOffset, headerOffset + SALT_BYTES);
  const nonce = payload.subarray(headerOffset + SALT_BYTES, headerOffset + SALT_BYTES + NONCE_BYTES);
  const ciphertext = payload.subarray(headerOffset + SALT_BYTES + NONCE_BYTES, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const key = deriveObjectKey(masterKey, salt);

  const decipher = createCipheriv("aes-256-gcm", key, nonce) as unknown as ReturnType<typeof import("node:crypto").createDecipheriv>;
  const d = require("node:crypto").createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  const decrypted = Buffer.concat([d.update(ciphertext), d.final()]);

  const origLen = decrypted.readUInt32BE(0);
  const padLen = decrypted.readUInt16BE(4);
  const data = decrypted.subarray(6, 6 + origLen);
  return { plaintext: new Uint8Array(data), wasEncrypted: true };
};

/**
 * State dumper: encryption/decryption context (sizes, hashes, MAGIC presence) plus the
 * fetchMock call sequence so a failing playback assertion logs the actual flow we observed.
 */
const dumpPlaybackSnapshot = (
  label: string,
  ctx: {
    plaintextLen?: number;
    encryptedLen?: number;
    decryptedLen?: number;
    plaintextHash?: string | null;
    decryptedHash?: string | null;
    magicMatches?: boolean;
    wasEncrypted?: boolean;
    note?: string;
  } = {},
) => {
  try {
    const calls = fetchMock.mock.calls.map((call, idx) => {
      const [url, init] = call as [unknown, RequestInit | undefined];
      return {
        idx,
        url: String(url),
        method: init?.method ?? "GET",
      };
    });
    const results = fetchMock.mock.results.map((r, idx) => ({
      idx,
      type: r.type,
      summary:
        r.type === "return" && r.value instanceof Response
          ? `Response(status=${(r.value as Response).status})`
          : String(r.value).slice(0, 200),
    }));
    console.error(`=== [${SUITE_ID}:${label}] snapshot ===`);
    console.error(`ctx: ${JSON.stringify(ctx, null, 2)}`);
    console.error(`fetch call count=${fetchMock.mock.calls.length}`);
    console.error(`fetch calls:\n${JSON.stringify(calls, null, 2)}`);
    console.error(`fetch results:\n${JSON.stringify(results, null, 2)}`);
  } catch (err) {
    console.error(
      `(${SUITE_ID}:${label} snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const sha256Hex = (data: Buffer | Uint8Array) =>
  createHash("sha256").update(Buffer.from(data)).digest("hex");

// @req PRIV-ENC-01
describe("media crypto encrypt/decrypt roundtrip", () => {
  it("encrypts and decrypts a media chunk correctly", () => {
    console.info(`[${SUITE_ID}:crypto-roundtrip] generating library key & master key`);
    const libraryKey = randomBytes(32);
    const masterKey = deriveMediaMasterKey(libraryKey);
    const plaintext = Buffer.from("test media content for playback");
    console.info(
      `[${SUITE_ID}:crypto-roundtrip] plaintext len=${plaintext.length} hash=${sha256Hex(plaintext).slice(0, 16)}`,
    );

    const encrypted = encryptMediaObject(masterKey, plaintext);
    console.info(
      `[${SUITE_ID}:crypto-roundtrip] encrypted len=${encrypted.length} magic=${encrypted.subarray(0, 4).toString()}`,
    );
    try {
      expect(encrypted.subarray(0, 4).toString()).toBe("SFV1");
      expect(encrypted.length).toBeGreaterThan(plaintext.length);
    } catch (err) {
      dumpPlaybackSnapshot("crypto-roundtrip-encrypt", {
        plaintextLen: plaintext.length,
        encryptedLen: encrypted.length,
        magicMatches: encrypted.subarray(0, 4).toString() === "SFV1",
      });
      throw err;
    }

    const result = decryptMediaObjectNode(masterKey, encrypted);
    console.info(
      `[${SUITE_ID}:crypto-roundtrip] decrypted wasEncrypted=${result.wasEncrypted} len=${result.plaintext.byteLength}`,
    );
    try {
      expect(result.wasEncrypted).toBe(true);
      expect(Buffer.from(result.plaintext).toString()).toBe("test media content for playback");
    } catch (err) {
      dumpPlaybackSnapshot("crypto-roundtrip-decrypt", {
        plaintextLen: plaintext.length,
        encryptedLen: encrypted.length,
        decryptedLen: result.plaintext.byteLength,
        plaintextHash: sha256Hex(plaintext),
        decryptedHash: sha256Hex(result.plaintext),
        wasEncrypted: result.wasEncrypted,
      });
      throw err;
    }
  });

  it("passes through unencrypted payload", () => {
    console.info(`[${SUITE_ID}:crypto-passthrough] building unencrypted payload`);
    const masterKey = randomBytes(32);
    const plainPayload = Buffer.from("not encrypted");

    const result = decryptMediaObjectNode(masterKey, plainPayload);
    console.info(
      `[${SUITE_ID}:crypto-passthrough] result.wasEncrypted=${result.wasEncrypted} len=${result.plaintext.byteLength}`,
    );
    try {
      expect(result.wasEncrypted).toBe(false);
      expect(Buffer.from(result.plaintext).toString()).toBe("not encrypted");
    } catch (err) {
      dumpPlaybackSnapshot("crypto-passthrough", {
        plaintextLen: plainPayload.length,
        decryptedLen: result.plaintext.byteLength,
        wasEncrypted: result.wasEncrypted,
        note: "expected pass-through (no MAGIC prefix)",
      });
      throw err;
    }
  });

  it("handles large media chunks (1MB)", () => {
    console.info(`[${SUITE_ID}:crypto-1mb] generating 1MB plaintext`);
    const libraryKey = randomBytes(32);
    const masterKey = deriveMediaMasterKey(libraryKey);
    const plaintext = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i & 0xff;

    const plaintextHash = sha256Hex(plaintext);
    console.info(`[${SUITE_ID}:crypto-1mb] plaintext hash=${plaintextHash.slice(0, 16)}`);
    const encrypted = encryptMediaObject(masterKey, plaintext);
    console.info(`[${SUITE_ID}:crypto-1mb] encrypted len=${encrypted.length}`);
    const result = decryptMediaObjectNode(masterKey, encrypted);
    const decryptedHash = sha256Hex(result.plaintext);
    console.info(
      `[${SUITE_ID}:crypto-1mb] decrypted len=${result.plaintext.byteLength} hash=${decryptedHash.slice(0, 16)}`,
    );

    try {
      expect(result.wasEncrypted).toBe(true);
      expect(result.plaintext.byteLength).toBe(plaintext.length);
      expect(decryptedHash).toBe(plaintextHash);
    } catch (err) {
      dumpPlaybackSnapshot("crypto-1mb", {
        plaintextLen: plaintext.length,
        encryptedLen: encrypted.length,
        decryptedLen: result.plaintext.byteLength,
        plaintextHash,
        decryptedHash,
        wasEncrypted: result.wasEncrypted,
      });
      throw err;
    }
  });

  it("detects tampering (wrong key)", () => {
    console.info(`[${SUITE_ID}:crypto-tamper] generating two distinct master keys`);
    const masterKey1 = deriveMediaMasterKey(randomBytes(32));
    const masterKey2 = deriveMediaMasterKey(randomBytes(32));
    const plaintext = Buffer.from("secret media");

    const encrypted = encryptMediaObject(masterKey1, plaintext);
    console.info(
      `[${SUITE_ID}:crypto-tamper] encrypted with key1 len=${encrypted.length}; attempting decrypt with key2`,
    );

    try {
      expect(() => decryptMediaObjectNode(masterKey2, encrypted)).toThrow();
    } catch (err) {
      dumpPlaybackSnapshot("crypto-tamper", {
        plaintextLen: plaintext.length,
        encryptedLen: encrypted.length,
        note: "expected throw on tamper (wrong key)",
      });
      throw err;
    }
  });
});

describe("playback download pipeline", () => {
  it("tunnel client downloads and returns bytes correctly for playback", async () => {
    console.info(`[${SUITE_ID}:download] importing storageTunnel client`);
    // Use a fresh tunnel client (not the shared singleton) to avoid stale state
    const { createUserStorageTunnelClient } = await import("@space/shared/storageTunnel");

    const chunk = Buffer.from("fake encrypted chunk data");
    const checksum = `sha256:${createHash("sha256").update(chunk).digest("hex")}`;
    const ciphertextBase64 = chunk.toString("base64");
    console.info(
      `[${SUITE_ID}:download] prepared chunk len=${chunk.length} checksum=${checksum.slice(0, 24)}`,
    );

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      // A playback session names its profile (STOR-BW-11); without one the client refuses before any request.
      getProfileId: () => "profile-1",
      tunnelMode: "direct",
      placementCacheTtlMs: 0,
      preferWebSocket: false,
    });

    console.info(`[${SUITE_ID}:download] queueing fetchMock responses (placement/session/ack/data/complete/ended)`);
    fetchMock
      // placement
      .mockResolvedValueOnce(
        Response.json({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "test",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "http://gw:3010", weight: 1, status: "active" }],
          },
        })
      )
      // session
      .mockResolvedValueOnce(
        Response.json({
          sessionId: "sess-1",
          protocolVersion: 1,
          createdAt: Date.now(),
          shardId: "gw-1",
          placementEpoch: 1,
          objectKeyPrefix: "shards/gw-1",
        })
      )
      // session.start ack
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ack" } }))
      // download.open -> download.data
      .mockResolvedValueOnce(
        Response.json({
          frame: {
            kind: "download.data",
            downloadId: "dl-1",
            seq: 0,
            checksum,
            ciphertext: ciphertextBase64,
          },
        })
      )
      // download.ack -> download.complete
      .mockResolvedValueOnce(
        Response.json({ frame: { kind: "download.complete", downloadId: "dl-1" } })
      )
      // session.end
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ended" } }));

    console.info(`[${SUITE_ID}:download] invoking client.downloadObject`);
    const result = await client.downloadObject("token-1", "shards/gw-1/media/chunk-1");
    console.info(
      `[${SUITE_ID}:download] result bytes=${result.byteLength} fetchCallCount=${fetchMock.mock.calls.length}`,
    );

    try {
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.byteLength).toBe(chunk.length);
      expect(Buffer.from(result).toString()).toBe("fake encrypted chunk data");
    } catch (err) {
      dumpPlaybackSnapshot("download", {
        plaintextLen: chunk.length,
        decryptedLen: result.byteLength,
        plaintextHash: sha256Hex(chunk),
        decryptedHash: sha256Hex(result),
      });
      throw err;
    }
  });
});
