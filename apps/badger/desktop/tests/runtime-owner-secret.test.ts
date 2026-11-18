/**
 * RT-SEC-05 (badger-desktop part): the main process reads the runtime's owner
 * secret from the owner-only file in the runtime data dir, fresh on every call.
 *
 * @covers apps/badger/desktop/src/main/runtimeOwnerSecret.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRuntimeOwnerSecret, runtimeOwnerSecretProvider } from "../src/main/runtimeOwnerSecret";

const first = "a".repeat(64);
const second = "b".repeat(64);

describe("badger runtime owner secret", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-badger-owner-secret-"));
    previous = process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    process.env.SPACEFLEET_RUNTIME_DATA_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    else process.env.SPACEFLEET_RUNTIME_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads owner.secret from the runtime data dir @req RT-SEC-05[badger-desktop]", async () => {
    console.info("[badger-owner-secret:read] file in SPACEFLEET_RUNTIME_DATA_DIR");
    writeFileSync(join(dir, "owner.secret"), first);
    expect(readRuntimeOwnerSecret()).toBe(first);
    expect(await runtimeOwnerSecretProvider()).toBe(first);
  });

  it("re-reads on every call so a restarted runtime's new secret is picked up @req RT-SEC-05[badger-desktop]", async () => {
    writeFileSync(join(dir, "owner.secret"), first);
    expect(await runtimeOwnerSecretProvider()).toBe(first);
    writeFileSync(join(dir, "owner.secret"), second);
    expect(await runtimeOwnerSecretProvider()).toBe(second);
  });

  it("returns null when the runtime has not published a secret @req RT-SEC-05[badger-desktop]", async () => {
    expect(readRuntimeOwnerSecret()).toBeNull();
    expect(await runtimeOwnerSecretProvider()).toBeNull();
  });

  it("rejects a malformed file instead of sending garbage @req RT-SEC-05[badger-desktop]", () => {
    writeFileSync(join(dir, "owner.secret"), "not-a-secret");
    expect(readRuntimeOwnerSecret()).toBeNull();
  });
});
