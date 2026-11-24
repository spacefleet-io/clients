/**
 * @test-id BADGER-DESKTOP-ROTATION-OTHER-LIBRARIES-001
 * @level unit
 * @req PRIV-KEY-12[badger-desktop]
 * @why Chris (2026-11-23, chat: re-encrypt Parrot's library on rotation): a key rotation from Badger desktop sends every
 *   other app's library re-encrypted under the new key and never deletes it. A library that changed since it was read
 *   is refused (the user tries again, which reads it again), never written back from the old read; the request is sent
 *   once, since its 2FA code is single-use; every refusal (media not re-sealed yet, no copy, changed, unreadable, not
 *   snapshotted) has its own words and changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { keyChangeFailureOf } from "@space/shared/keyChangeFailure";
import { rotateWithOtherLibraries } from "../src/renderer/src/lib/rotationRefusal";

const mocks = vi.hoisted(() => ({ rotate: vi.fn() }));

// vi.mock factories are hoisted above the static imports, so the real ApiError is loaded inside the factory.
vi.mock("../src/renderer/src/api", async () => ({
  ApiError: (await import("@space/shared/api")).ApiError,
  rotateLibraryKey: mocks.rotate,
}));

const SUITE = "[BADGER-DESKTOP-ROTATION-OTHER-LIBRARIES-001]";
const copyAt = (baseVersion: number) => ({
  appId: "parrot" as const,
  baseVersion,
  manifestBase64: "bWFuaWZlc3Q=",
  snapshotId: `parrot-${baseVersion}`,
  chunkSize: 4194304,
  chunkRefs: ["chunk-1"],
  chunkRefsSource: { client: "library-db-runtime", refsVersion: 1 },
  storageFormatVersion: 1,
  opStreamVersion: 3,
});
const OWN = {
  manifestBase64: "b3du",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "desktop-runtime", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};
const input = (reencrypt: () => Promise<ReturnType<typeof copyAt>[]>) => ({
  token: "t",
  library: OWN,
  keyProbe: "probe",
  password: "pw",
  reencrypt,
});

beforeEach(() => {
  mocks.rotate.mockReset().mockResolvedValue({ version: 5 });
});

describe(`${SUITE} rotateWithOtherLibraries`, () => {
  it("sends the other libraries' re-encrypted copies with the rotation", async () => {
    await rotateWithOtherLibraries(input(async () => [copyAt(2)]));
    expect(mocks.rotate).toHaveBeenCalledWith("t", OWN, "probe", "pw", undefined, [copyAt(2)], undefined);
  });

  it("names the media re-seal run the rotation switches to (STOR-RESEAL-04)", async () => {
    await rotateWithOtherLibraries({ ...input(async () => [copyAt(2)]), mediaReseal: { runId: "run-1", switchNow: true } });
    expect(mocks.rotate).toHaveBeenCalledWith("t", OWN, "probe", "pw", undefined, [copyAt(2)], {
      runId: "run-1",
      switchNow: true,
    });
  });

  it("a version conflict is shown as 'changed', sent once (the 2FA code is single-use), and the next try reads again", async () => {
    mocks.rotate.mockRejectedValueOnce(new ApiError(409, { error: "version_conflict" }));
    let reads = 0;
    const reencrypt = async () => [copyAt(2 + reads++)];
    const err = await rotateWithOtherLibraries(input(reencrypt)).catch((e: unknown) => e);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    expect(keyChangeFailureOf(err)).toEqual({ status: "failed", reason: "changed" });
    await rotateWithOtherLibraries(input(reencrypt));
    expect(mocks.rotate.mock.calls.map((call) => (call[5] as ReturnType<typeof copyAt>[])[0]!.baseVersion)).toEqual([2, 3]);
  });

  it("sends nothing when a library cannot be re-encrypted on the device", async () => {
    const err = await rotateWithOtherLibraries(
      input(async () => {
        throw new Error("ROTATION_REENCRYPT_UNREADABLE");
      })
    ).catch((e: unknown) => e);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(keyChangeFailureOf(err)).toEqual({ status: "failed", reason: "unreadable" });
  });

  it("@req ACCT-KEYCHG-04[badger-desktop] gives the media refusal no words of its own, sent once", async () => {
    mocks.rotate.mockRejectedValue(new ApiError(409, { error: "rotation_needs_media_reseal" }));
    const err = await rotateWithOtherLibraries(input(async () => [copyAt(2)])).catch((e: unknown) => e);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    expect(keyChangeFailureOf(err)).toEqual({ status: "failed", reason: "other" });
  });
});
