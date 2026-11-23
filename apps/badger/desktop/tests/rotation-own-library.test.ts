/**
 * @test-id BADGER-DESKTOP-ROTATION-OWN-LIBRARY-001
 * @level unit (real renderer rotate helper + real shared API client, fetch stubbed at the wire)
 * @req PRIV-KEY-13[badger-desktop]
 * @why Main (2026-11-23, IRC: make Badger desktop key rotation succeed end to end): "Replace key" sent this computer's
 *   library as `blobBase64`, one whole AES-GCM blob no reader decodes, with no formats, so the server took it for
 *   storage 1 / op stream 1 and answered 409 `library_format_downgrade` on a format-2 account. The request now carries
 *   the library as the snapshot it publishes (manifest + chunk refs, chunks uploaded) and declares its own formats.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "@space/shared/api";
import { rotateWithOtherLibraries } from "../src/renderer/src/lib/rotationRefusal";

const SUITE = "[BADGER-DESKTOP-ROTATION-OWN-LIBRARY-001]";

/** What `LibraryDb.sealForRotation` returns for a library written in storage 2 / op stream 3. */
const OWN = {
  manifestBase64: "bWFuaWZlc3QtdW5kZXItbmV3LWtleQ==",
  snapshotId: "own-snapshot-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01", "c0ffee02"],
  chunkRefsSource: { client: "desktop-runtime", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};
const PARROT = {
  appId: "parrot" as const,
  baseVersion: 4,
  manifestBase64: "cGFycm90",
  snapshotId: "parrot-4",
  chunkSize: 4194304,
  chunkRefs: ["beef0001"],
  chunkRefsSource: { client: "library-db-runtime", refsVersion: 1 },
  storageFormatVersion: 1,
  opStreamVersion: 3,
};

let sent: Array<{ url: string; method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  sent = [];
  setApiBaseUrl("http://api.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sent.push({ url: request.url, method: request.method, body: JSON.parse(await request.text()) as Record<string, unknown> });
      return new Response(JSON.stringify({ version: 7, revoked: true }), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(`${SUITE} the rotation request carries this library as a snapshot with its formats`, () => {
  it("sends the manifest, chunk refs and declared formats, never a whole blob", async () => {
    await rotateWithOtherLibraries({
      token: "t",
      library: OWN,
      keyProbe: "probe",
      password: "pw",
      twoFactorCode: "123456",
      reencrypt: async () => [PARROT],
    });
    console.info(`${SUITE} sent ${JSON.stringify(sent.map(({ url, method, body }) => ({ url, method, keys: Object.keys(body).sort() })))}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(new URL(sent[0]!.url).pathname).toBe("/library/recovery/rotate");
    expect(sent[0]!.body).toEqual({
      ...OWN,
      keyProbe: "probe",
      password: "pw",
      twoFactorCode: "123456",
      otherLibraries: [PARROT],
    });
    expect(sent[0]!.body).not.toHaveProperty("blobBase64");
    // The own library's version is the server's to check against the stored one (VaultKeys/Rotate), never sent.
    expect(sent[0]!.body).not.toHaveProperty("baseVersion");
  });
});
