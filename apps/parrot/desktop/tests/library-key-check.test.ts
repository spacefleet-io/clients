/**
 * @test-id PARROT-DESKTOP-KEY-CHECK-001
 * @level unit
 * @bugfix @regression-proof
 * @why Parrot desktop took any well-formed key when neither Parrot nor Badger had a published library, even when the
 *   account already had a key (made in Badger, its probe on the server). A wrong key would then encrypt Parrot's
 *   library and split the apps for good (PRIV-KEY-01: one key per account). With no library the key must open the
 *   account's key probe; only an account with no probe takes any key, and taking it writes the probe (claimAccount),
 *   so Badger and every other device check later keys against it. The key step's first question (makeAccountKey)
 *   shows a new key only to an account with no probe and no library (UX-KEY-01, the shared step).
 */
import { describe, expect, it, vi } from "vitest";
import { checkKeyAgainstAccount, makeAccountKey, type LibraryKeyCheckDeps } from "../src/main/libraryKeyCheck";

const SUITE = "[PARROT-DESKTOP-KEY-CHECK-001]";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 2).toString("base64");
const PROBE = "probe-made-with-KEY";

const deps = (over: Partial<LibraryKeyCheckDeps<{ id: string }>> = {}): LibraryKeyCheckDeps<{ id: string }> => ({
  fetchSnapshot: async () => null,
  fetchKeyProbe: async () => PROBE,
  decryptProbe: async (key, probe) => {
    if (key !== KEY || probe !== PROBE) throw new Error("DECRYPT_FAILED");
    return new Uint8Array(32);
  },
  claimAccount: async (key) => console.info(`${SUITE} claimed with ${key.slice(0, 6)}…`),
  log: (m) => console.info(`${SUITE} ${m}`),
  fail: (m) => console.warn(`${SUITE} ${m}`),
  ...over,
});

describe("checkKeyAgainstAccount", () => {
  it("refuses a wrong key when the account has a key probe but no library yet", async () => {
    expect(await checkKeyAgainstAccount(OTHER_KEY, deps())).toEqual({ ok: false, error: "wrongKey" });
  });

  it("takes the account's key when it has a probe but no library yet", async () => {
    expect(await checkKeyAgainstAccount(KEY, deps())).toEqual({ ok: true });
  });

  it("takes the account's key when it has a probe but no library yet, without claiming the account again", async () => {
    const claimAccount = vi.fn(async (_key: string) => undefined);
    const result = await checkKeyAgainstAccount(KEY, deps({ claimAccount }));
    console.info(`${SUITE} probe+right words: ${JSON.stringify(result)} claims=${claimAccount.mock.calls.length}`);
    expect(result).toEqual({ ok: true });
    expect(claimAccount).not.toHaveBeenCalled();
  });

  it("takes any well-formed key only when the account has no probe at all, and claims the account with it", async () => {
    const claimAccount = vi.fn(async (_key: string) => undefined);
    const result = await checkKeyAgainstAccount(OTHER_KEY, deps({ fetchKeyProbe: async () => null, claimAccount }));
    console.info(`${SUITE} no probe: ${JSON.stringify(result)} claims=${JSON.stringify(claimAccount.mock.calls)}`);
    expect(result).toEqual({ ok: true });
    expect(claimAccount).toHaveBeenCalledWith(OTHER_KEY);
  });

  it("says the network failed (and keeps nothing) when the claim cannot be published", async () => {
    const result = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ fetchKeyProbe: async () => null, claimAccount: async () => { throw new Error("publish refused"); } }),
    );
    console.info(`${SUITE} claim failed: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: false, error: "network" });
  });

  it("checks a published library first and hands Parrot's over", async () => {
    const opened: string[] = [];
    const result = await checkKeyAgainstAccount(
      KEY,
      deps({ fetchSnapshot: async (appId) => (appId === "parrot" ? { id: "parrot-lib" } : null), fetchKeyProbe: async () => { throw new Error("not read"); } }),
      (snapshot) => opened.push(snapshot.id),
    );
    expect(result).toEqual({ ok: true });
    expect(opened).toEqual(["parrot-lib"]);
  });

  it("refuses a key Badger's library does not open", async () => {
    const result = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ fetchSnapshot: async (appId) => { if (appId === "badger") throw new Error("DECRYPT_FAILED"); return null; } }),
    );
    expect(result).toEqual({ ok: false, error: "wrongKey" });
  });

  it("says the network failed when the probe cannot be read", async () => {
    const result = await checkKeyAgainstAccount(KEY, deps({ fetchKeyProbe: async () => { throw new Error("offline"); } }));
    expect(result).toEqual({ ok: false, error: "network", message: "offline" });
  });

  it("refuses a key that is not 32 bytes of base64", async () => {
    expect(await checkKeyAgainstAccount("nope", deps())).toEqual({ ok: false, error: "format" });
  });
});

describe("makeAccountKey", () => {
  const newKey = { keyBase64: OTHER_KEY, words: Array.from({ length: 12 }, (_, i) => `word${i}`) };
  const keyDeps = (over: Partial<LibraryKeyCheckDeps<{ id: string }>> = {}) => {
    const { fetchSnapshot, fetchKeyProbe, log, fail } = deps(over);
    return { fetchSnapshot, fetchKeyProbe, log, fail };
  };

  it("shows a new key only when the account has no probe and no library", async () => {
    const result = await makeAccountKey(newKey, keyDeps({ fetchKeyProbe: async () => null }));
    console.info(`${SUITE} makeAccountKey empty account: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: true, ...newKey });
  });

  it("asks for the account's key when its probe is on the server", async () => {
    const result = await makeAccountKey(newKey, keyDeps());
    console.info(`${SUITE} makeAccountKey probe: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "hasLibrary" });
  });

  it("asks for the account's key when a library exists that the new key cannot open", async () => {
    const result = await makeAccountKey(
      newKey,
      keyDeps({ fetchKeyProbe: async () => null, fetchSnapshot: async (appId) => { if (appId === "badger") throw new Error("DECRYPT_FAILED"); return null; } }),
    );
    console.info(`${SUITE} makeAccountKey badger library: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "hasLibrary" });
  });

  it("says the network failed when the probe cannot be read", async () => {
    const result = await makeAccountKey(newKey, keyDeps({ fetchKeyProbe: async () => { throw new Error("offline"); } }));
    console.info(`${SUITE} makeAccountKey offline: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "network", message: "offline" });
  });
});
