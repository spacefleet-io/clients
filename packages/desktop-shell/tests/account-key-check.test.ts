/**
 * @test-id DESKTOP-SHELL-ACCOUNT-KEY-CHECK-001
 * @level unit
 * @bugfix @regression-proof
 * @why PRIV-KEY-01 (one key per account, shared by Badger and Parrot) was checked by two copies: Parrot desktop's
 *   `libraryKeyCheck.ts` and Badger desktop's `verifyPairedKey`. Badger's copy took any paired key when Badger had no
 *   library yet (`if (!meta.exists) return "verified"`), even when the account's key probe said otherwise (a key made
 *   in Parrot), which would encrypt Badger's library under a second key and split the apps. Both desktops now run this
 *   one check (REL-FAM-05): the account's key probe decides; libraries are tried only for an account with no probe (the
 *   asking app's own first); only an account with no probe and no library takes any key, and only an app that passes
 *   `claimAccount` writes the probe there and then.
 */
import { describe, expect, it, vi } from "vitest";
import { checkKeyAgainstAccount, type AccountKeyCheckDeps } from "../src/accountKeyCheck";

const SUITE = "[DESKTOP-SHELL-ACCOUNT-KEY-CHECK-001]";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 2).toString("base64");
const PROBE = "probe-made-with-KEY";

type App = "parrot" | "badger";

const deps = (over: Partial<AccountKeyCheckDeps<App>> = {}): AccountKeyCheckDeps<App> => ({
  appIds: ["parrot", "badger"],
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
    const result = await checkKeyAgainstAccount(OTHER_KEY, deps());
    console.info(`${SUITE} probe+wrong key: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "wrongKey" });
  });

  it("takes the account's key when it has a probe but no library yet, without claiming the account again", async () => {
    const claimAccount = vi.fn(async (_key: string) => undefined);
    const result = await checkKeyAgainstAccount(KEY, deps({ claimAccount }));
    console.info(`${SUITE} probe+right key: ${JSON.stringify(result)} claims=${claimAccount.mock.calls.length}`);
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

  it("takes any well-formed key with no probe and no library when the app does not claim (Badger: its first library writes the probe)", async () => {
    const result = await checkKeyAgainstAccount(OTHER_KEY, deps({ fetchKeyProbe: async () => null, claimAccount: undefined }));
    console.info(`${SUITE} no probe, no claim: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: true });
  });

  it("says the network failed (and keeps nothing) when the claim cannot be published", async () => {
    const result = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ fetchKeyProbe: async () => null, claimAccount: async () => { throw new Error("publish refused"); } }),
    );
    console.info(`${SUITE} claim failed: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: false, error: "network" });
  });

  it("lets the probe decide without opening any library (Badger with no library of its own, account key made in Parrot)", async () => {
    const fetchSnapshot = vi.fn(async (_appId: App) => ({ id: "lib" }));
    const wrong = await checkKeyAgainstAccount(OTHER_KEY, deps({ appIds: ["badger"], claimAccount: undefined, fetchSnapshot }));
    const right = await checkKeyAgainstAccount(KEY, deps({ appIds: ["badger"], claimAccount: undefined, fetchSnapshot }));
    console.info(`${SUITE} probe decides: wrong=${JSON.stringify(wrong)} right=${JSON.stringify(right)} libraryReads=${fetchSnapshot.mock.calls.length}`);
    expect(wrong).toEqual({ ok: false, error: "wrongKey" });
    expect(right).toEqual({ ok: true });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("with no probe, tries the libraries in the order the app gives (Badger: badger, then parrot) and takes a key one opens", async () => {
    const tried: string[] = [];
    const claimAccount = vi.fn(async (_key: string) => undefined);
    const result = await checkKeyAgainstAccount(
      KEY,
      deps({
        appIds: ["badger", "parrot"],
        fetchKeyProbe: async () => null,
        claimAccount,
        fetchSnapshot: async (appId) => {
          tried.push(appId);
          return appId === "parrot" ? { id: "parrot-lib" } : null;
        },
      }),
    );
    console.info(`${SUITE} no probe, library order: tried=${JSON.stringify(tried)} ${JSON.stringify(result)} claims=${claimAccount.mock.calls.length}`);
    expect(tried).toEqual(["badger", "parrot"]);
    expect(result).toEqual({ ok: true });
    expect(claimAccount).not.toHaveBeenCalled();
  });

  it("with no probe, refuses a key the other app's library does not open", async () => {
    const result = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ fetchKeyProbe: async () => null, fetchSnapshot: async (appId) => { if (appId === "badger") throw new Error("DECRYPT_FAILED"); return null; } }),
    );
    console.info(`${SUITE} other library wrong key: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "wrongKey" });
  });

  it("uses the app's decrypt-failure test for wrapped errors, and calls any other library error a network failure", async () => {
    const wrapped = new Error("Error invoking remote method 'libraryDb:open': Error: DECRYPT_FAILED");
    const isDecryptFailure = (error: unknown) => error instanceof Error && error.message.includes("DECRYPT_FAILED");
    const noProbe = { appIds: ["badger"] as App[], fetchKeyProbe: async () => null };
    const wrong = await checkKeyAgainstAccount(OTHER_KEY, deps({ ...noProbe, isDecryptFailure, fetchSnapshot: async () => { throw wrapped; } }));
    const busy = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ ...noProbe, isDecryptFailure, fetchSnapshot: async () => { throw new Error("disk is busy"); } }),
    );
    const defaultTest = await checkKeyAgainstAccount(OTHER_KEY, deps({ ...noProbe, fetchSnapshot: async () => { throw wrapped; } }));
    console.info(`${SUITE} wrapped=${JSON.stringify(wrong)} busy=${JSON.stringify(busy)} default=${JSON.stringify(defaultTest)}`);
    expect(wrong).toEqual({ ok: false, error: "wrongKey" });
    expect(busy).toEqual({ ok: false, error: "network", message: "disk is busy" });
    expect(defaultTest).toMatchObject({ ok: false, error: "network" });
  });

  it("says the network failed when the probe cannot be read", async () => {
    const result = await checkKeyAgainstAccount(KEY, deps({ fetchKeyProbe: async () => { throw new Error("offline"); } }));
    console.info(`${SUITE} probe offline: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "network", message: "offline" });
  });

  it("refuses a key that is not 32 bytes of base64", async () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    const results = [await checkKeyAgainstAccount("nope", deps()), await checkKeyAgainstAccount(short, deps()), await checkKeyAgainstAccount("KEY", deps())];
    console.info(`${SUITE} format: ${JSON.stringify(results)}`);
    expect(results).toEqual([
      { ok: false, error: "format" },
      { ok: false, error: "format" },
      { ok: false, error: "format" },
    ]);
  });
  // @req ACCT-UNPAID-06[badger-desktop] ACCT-UNPAID-06[parrot]
  it("says the plan ended (not the network) when the account's first library is refused as unpaid", async () => {
    const unpaid = Object.assign(new Error("subscription_unpaid"), { status: 402, payload: { error: "subscription_unpaid", wipeAt: null } });
    const result = await checkKeyAgainstAccount(
      OTHER_KEY,
      deps({ fetchKeyProbe: async () => null, claimAccount: async () => { throw unpaid; } }),
    );
    console.info(`${SUITE} claim unpaid: ${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, error: "unpaid", message: "subscription_unpaid" });
  });
});
