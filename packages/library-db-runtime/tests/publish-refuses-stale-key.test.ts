/**
 * @test-id RUNTIME-KEY-MISMATCH-001
 * @bugfix @regression-proof
 * @why Every publish writes a fresh key probe and the account's probe is the newest one of any app. After an erase
 *   from Parrot and a new key saved there, a restarted Badger still holding the erased key bootstrapped a library under
 *   it, so its probe replaced the new key's and the erased words opened the account again (erase e2e line b,
 *   2026-11-12). Publishes now refuse (KEY_MISMATCH) when the account's probe does not open with their key
 *   (PRIV-KEY-01).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { encryptBytesToBase64 } from "../src/crypto";
import { assertAccountLibraryKey, KEY_MISMATCH } from "../src/snapshotTransport";

const SUITE = "[RUNTIME-KEY-MISMATCH-001]";
const newKey = () => randomBytes(32).toString("base64");

describe(`${SUITE} assertAccountLibraryKey`, () => {
  it("refuses a key the account's probe does not open", async () => {
    const accountKey = newKey();
    const probe = await encryptBytesToBase64(accountKey, new Uint8Array(randomBytes(32)));
    const error = await assertAccountLibraryKey("token", newKey(), "badger", { keyProbe: probe }).catch((e: Error) => e);
    console.info(`${SUITE} stale key → ${String(error)}`);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(KEY_MISMATCH);
  });

  it("lets the account's key publish", async () => {
    const accountKey = newKey();
    const probe = await encryptBytesToBase64(accountKey, new Uint8Array(randomBytes(32)));
    await expect(assertAccountLibraryKey("token", accountKey, "badger", { keyProbe: probe })).resolves.toBeUndefined();
  });

  it("lets a first library publish on an account with no probe", async () => {
    await expect(assertAccountLibraryKey("token", newKey(), "badger", { keyProbe: null })).resolves.toBeUndefined();
  });
});
