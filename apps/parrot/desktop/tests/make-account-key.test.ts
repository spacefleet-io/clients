/**
 * @test-id PARROT-DESKTOP-KEY-CHECK-001
 * @level unit
 * @bugfix @regression-proof
 * @why The key step's first question (makeAccountKey) shows a new key only to an account with no probe and no
 *   library (UX-KEY-01, the shared step); an account that already has a key (made in Badger, its probe on the server)
 *   is asked for it, so a second key never splits the apps (PRIV-KEY-01). Whether a key is the account's is the shared
 *   desktop check, proved in packages/desktop-shell/tests/account-key-check.test.ts.
 */
import { describe, expect, it } from "vitest";
import { makeAccountKey } from "../src/main/makeAccountKey";

const SUITE = "[PARROT-DESKTOP-KEY-CHECK-001]";

const OTHER_KEY = Buffer.alloc(32, 2).toString("base64");
const PROBE = "probe-made-with-KEY";

type KeyDeps = Parameters<typeof makeAccountKey>[1];

const keyDeps = (over: Partial<KeyDeps> = {}): KeyDeps => ({
  fetchSnapshot: async () => null,
  fetchKeyProbe: async () => PROBE,
  log: (m) => console.info(`${SUITE} ${m}`),
  fail: (m) => console.warn(`${SUITE} ${m}`),
  ...over,
});

describe("makeAccountKey", () => {
  const newKey = { keyBase64: OTHER_KEY, words: Array.from({ length: 12 }, (_, i) => `word${i}`) };

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
    expect(result).toEqual({ ok: false, error: "network", message: "offline", errorClass: "unknown" });
  });

  // @req UX-KEY-02
  it("says why when the probe cannot be read, so the step's Retry screen can say it (no new key is made)", async () => {
    const result = await makeAccountKey(newKey, keyDeps({ fetchKeyProbe: async () => { throw new TypeError("fetch failed"); } }));
    console.info(`${SUITE} makeAccountKey unreachable: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "network", message: "fetch failed", errorClass: "unreachable" });
  });
});
