import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_OWNER_SECRET_FILE } from "@space/runtime-contracts/lifecycle";
import { ownerSecretFileProvider, readOwnerSecretFile } from "../src/ownerSecretFile";

const SUITE = "runtime-client-owner-secret-file";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-owner-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("owner secret file reader (RT-SEC-05)", () => {
  it("reads the published secret, fresh on every call, so a restarted runtime is picked up @req RT-SEC-05[badger-desktop]", async () => {
    const provider = ownerSecretFileProvider(dir);
    writeFileSync(join(dir, RUNTIME_OWNER_SECRET_FILE), "a".repeat(64));
    expect(await provider()).toBe("a".repeat(64));
    writeFileSync(join(dir, RUNTIME_OWNER_SECRET_FILE), `${"b".repeat(64)}\n`);
    expect(await provider()).toBe("b".repeat(64));
    console.info(`[${SUITE}:fresh] re-read after rewrite`);
  });

  it("returns null when the file is absent or does not hold a secret @req RT-SEC-05[badger-desktop]", () => {
    expect(readOwnerSecretFile(dir)).toBeNull();
    writeFileSync(join(dir, RUNTIME_OWNER_SECRET_FILE), "not a secret");
    expect(readOwnerSecretFile(dir)).toBeNull();
  });

  it("accepts a lazy data dir @req RT-SEC-05[badger-desktop]", () => {
    writeFileSync(join(dir, RUNTIME_OWNER_SECRET_FILE), "c".repeat(64));
    expect(ownerSecretFileProvider(() => dir)()).toBe("c".repeat(64));
  });
});
