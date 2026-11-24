/**
 * @test-id MOBILE-SHELL-ACCOUNT-LANGUAGE-SYNC-001
 * @level unit
 * @req UX-I18N-07
 * @req REL-FAM-03
 * @bugfix @regression-proof
 * @why Audit #3350 S51: Badger's phone kept a language pick the account could not save and pushed it on the next
 *   `/auth/me`, while Parrot's phone saved once and let the next `/auth/me` put the account's old language back.
 *   Both phones now run this one chain (`createAccountLanguageSync`): a failed save stays pending and is retried,
 *   another device's later change wins, saves land in pick order, and signing out forgets a pending pick.
 */
import { describe, expect, it, vi } from "vitest";
import { createAccountLanguageSync, type AccountLanguageSync } from "../src/accountLanguageSync";

vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));

const SUITE = "[MOBILE-SHELL-ACCOUNT-LANGUAGE-SYNC-001]";

const LANGUAGE_KEY = "test.language";
const UNSYNCED_KEY = "test.languageUnsynced";

/** One phone (its storage and shown language) and the account on the API. */
const phone = () => {
  const items = new Map<string, string>();
  const api = { language: "en" as string | null, offline: false, saves: [] as string[] };
  let shown = "en";
  const chain = createAccountLanguageSync({
    asyncStorage: {
      getItem: async (key) => items.get(key) ?? null,
      setItem: async (key, value) => void items.set(key, value),
      removeItem: async (key) => void items.delete(key),
    },
    languageKey: LANGUAGE_KEY,
    unsyncedKey: UNSYNCED_KEY,
    currentLanguage: () => shown,
    showLanguage: async (language) => {
      shown = language;
    },
  });
  /** What `/auth/me` answers on this start, and the saves it may make. */
  const session = (): AccountLanguageSync => ({
    account: api.language,
    fetchAccountLanguage: async () => {
      if (api.offline) throw new Error("offline");
      return api.language;
    },
    saveAccountLanguage: async (language) => {
      if (api.offline) throw new Error("offline");
      api.language = language;
      api.saves.push(language);
    },
  });
  /** Waits for every job already on the chain: a cancelled sync is queued behind them and does nothing. */
  const settled = () => chain.sync({ ...session(), cancelled: () => true });
  const state = (label: string) => {
    const snapshot = { shown, stored: items.get(LANGUAGE_KEY) ?? null, unsynced: items.get(UNSYNCED_KEY) ?? null, api: { ...api } };
    console.info(`${SUITE} ${label}`, JSON.stringify(snapshot));
    return snapshot;
  };
  return { chain, api, session, settled, state };
};

describe("@req UX-I18N-07 one account-language chain for every phone app", () => {
  it("keeps a pick whose save failed and pushes it on the next /auth/me instead of reverting it", async () => {
    const p = phone();
    p.api.offline = true;
    await p.chain.choose("de", { pushToAccount: true, account: "en" });
    await p.chain.sync(p.session());
    expect(p.state("save failed offline").unsynced, "the pick stays pending, with the account's language seen at the pick").toBe("en");

    p.api.offline = false;
    await p.chain.sync(p.session());
    const after = p.state("next /auth/me online");
    expect(after.shown, "the pick is not reverted").toBe("de");
    expect(p.api.saves).toEqual(["de"]);
    expect(after.unsynced).toBeNull();
  });

  it("lets another device's later change win over a pick still pending here", async () => {
    const p = phone();
    p.api.offline = true;
    await p.chain.choose("de", { pushToAccount: true, account: "en" });
    await p.chain.sync(p.session());

    // Another device moved the account to French while this phone was offline.
    p.api.offline = false;
    p.api.language = "fr";
    await p.chain.sync(p.session());
    await p.settled();
    const after = p.state("another device changed the account");
    expect(after.shown).toBe("fr");
    expect(p.api.saves, "the stale pick is never pushed over the newer change").toEqual([]);
    expect(after.unsynced).toBeNull();
  });

  it("never lets an earlier pick's save land after a later pick", async () => {
    const p = phone();
    await p.chain.choose("de", { pushToAccount: true, account: "en" });
    const first = p.chain.sync(p.session());
    await p.chain.choose("nl", { pushToAccount: true });
    const second = p.chain.sync(p.session());
    await Promise.all([first, second]);
    await p.settled();
    p.state("two quick picks");
    expect(p.api.saves.at(-1), "the last save is the last pick").toBe("nl");
    expect(p.api.language).toBe("nl");
  });

  it("forgets a pending pick on sign-out, so the next account's language is applied", async () => {
    const p = phone();
    p.api.offline = true;
    await p.chain.choose("de", { pushToAccount: true, account: "en" });
    await p.chain.sync(p.session());
    await p.chain.forget();
    expect(p.state("signed out").unsynced).toBeNull();

    p.api.offline = false;
    p.api.language = "fr";
    await p.chain.sync(p.session());
    await p.settled();
    expect(p.state("another account signed in").shown).toBe("fr");
    expect(p.api.saves).toEqual([]);
  });

  it("a pick made signed out never marks the account", async () => {
    const p = phone();
    await p.chain.choose("nl", { pushToAccount: false });
    const after = p.state("picked before sign-in");
    expect(after.stored).toBe("nl");
    expect(after.unsynced).toBeNull();
  });
});
