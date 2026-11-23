/**
 * @test-id BADGER-MOBILE-ROTATION-COPIES-001
 * @level unit
 * @req PRIV-KEY-12[badger-mobile,badger-tv]
 * @req PRIV-KEY-13[badger-mobile,badger-tv]
 * @why Chris (2026-11-23, chat: re-encrypt Parrot's library on rotation): a key rotation from the phone re-encrypts
 *   Parrot's library under the new key and never deletes it. What the phone cannot re-encrypt whole (old key does not
 *   open it, changes after its snapshot) is refused before anything is sent; a library that changed since it was read
 *   is refused (the user tries again, which reads it again), never written back from the old read; the request is
 *   sent once, since its 2FA code is single-use.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError } from "@space/shared/api";
import { rotateWithParrotLibrary, rotationRefusal } from "../src/lib/rotationCopies";

const mocks = vi.hoisted(() => ({
  meta: { exists: true, version: 2, snapshotVersion: 2, opStreamVersion: 3 },
  metaReads: 0,
  open: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/shared/api")>()),
  getLibraryMeta: vi.fn(async () => {
    mocks.metaReads += 1;
    return { ...mocks.meta };
  }),
  getLibraryDb: vi.fn(),
  downloadStorageObjectViaTunnel: vi.fn(),
  uploadStorageObjectViaTunnel: vi.fn(async () => undefined),
  rotateLibraryKey: mocks.rotate,
}));
vi.mock("@space/mobile-shell/librarySnapshot", () => ({ openRemoteLibrarySnapshot: mocks.open }));
vi.mock("@space/library-db-definition/snapshotPublish", () => ({
  reencryptLibrarySnapshotWith: vi.fn(async (_bytes: Uint8Array, baseVersion: number) => ({
    baseVersion,
    manifestBase64: "bWFuaWZlc3Q=",
    snapshotId: "new-key-snapshot",
    chunkSize: 4194304,
    chunkRefs: ["chunk-1"],
  })),
}));
vi.mock("../src/lib/crypto", () => ({ decryptBytesToBytes: vi.fn(), encryptBytesToBytes: vi.fn() }));

const SUITE = "[BADGER-MOBILE-ROTATION-COPIES-001]";
/** This phone's own library as `LibraryDb.sealForRotation` returns it (PRIV-KEY-13). */
const OWN = {
  manifestBase64: "b3du",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "badger-mobile", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};
const input = { token: "t", oldKey: "old", newKey: "new", library: OWN, keyProbe: "probe", password: "pw" };
const refusalOf = (p: Promise<unknown>) => p.then(() => "rotated", (err: unknown) => rotationRefusal(err));
const sentCopies = (call: number) => mocks.rotate.mock.calls[call]![5] as { appId: string; baseVersion: number; opStreamVersion: number }[];

beforeEach(() => {
  mocks.meta = { exists: true, version: 2, snapshotVersion: 2, opStreamVersion: 3 };
  mocks.metaReads = 0;
  mocks.open.mockReset().mockResolvedValue({ dbBytes: new Uint8Array([1]), snapshotVersion: 2 });
  mocks.rotate.mockReset().mockResolvedValue({ version: 5 });
});

describe(`${SUITE} rotateWithParrotLibrary`, () => {
  it("sends Parrot's library re-encrypted, at the version it was read at, with its stored op-stream version", async () => {
    await rotateWithParrotLibrary(input);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    // PRIV-KEY-13: the own library goes as its snapshot with its formats, never a whole blob.
    expect(mocks.rotate.mock.calls[0]!.slice(0, 4)).toEqual(["t", OWN, "probe", "pw"]);
    expect(sentCopies(0)).toEqual([expect.objectContaining({ appId: "parrot", baseVersion: 2, opStreamVersion: 3, snapshotId: "new-key-snapshot" })]);
  });

  it("refuses before sending anything when Parrot has changes after its latest snapshot", async () => {
    mocks.meta = { exists: true, version: 3, snapshotVersion: 2, opStreamVersion: 3 };
    expect(await refusalOf(rotateWithParrotLibrary(input))).toBe("notSnapshotted");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it("refuses before sending anything when the old key does not open Parrot's library", async () => {
    mocks.open.mockRejectedValue(new Error("DECRYPT_FAILED"));
    expect(await refusalOf(rotateWithParrotLibrary(input))).toBe("unreadable");
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it("a version conflict is refused as 'changed', sent once (the 2FA code is single-use), and the next try reads again", async () => {
    mocks.rotate.mockRejectedValueOnce(new ApiError(409, { error: "version_conflict" }));
    mocks.open.mockResolvedValueOnce({ dbBytes: new Uint8Array([1]), snapshotVersion: 2 });
    mocks.open.mockResolvedValueOnce({ dbBytes: new Uint8Array([2]), snapshotVersion: 3 });
    expect(await refusalOf(rotateWithParrotLibrary(input))).toBe("changed");
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    await rotateWithParrotLibrary(input);
    expect(mocks.metaReads).toBe(2);
    expect([sentCopies(0)[0]!.baseVersion, sentCopies(1)[0]!.baseVersion]).toEqual([2, 3]);
  });

  it("without the old key sends no copy: the server refuses when Parrot has a library, nothing is deleted", async () => {
    mocks.rotate.mockRejectedValue(new ApiError(409, { error: "library_not_reencrypted", appId: "parrot" }));
    expect(await refusalOf(rotateWithParrotLibrary({ ...input, oldKey: null }))).toBe("notReencrypted");
    expect(sentCopies(0)).toEqual([]);
  });

  it("@req ACCT-KEYCHG-04[badger-mobile] gives the media refusal no words of its own, sent once", async () => {
    mocks.rotate.mockRejectedValue(new ApiError(409, { error: "rotation_needs_media_reseal" }));
    expect(await refusalOf(rotateWithParrotLibrary(input))).toBeNull();
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
  });
});
