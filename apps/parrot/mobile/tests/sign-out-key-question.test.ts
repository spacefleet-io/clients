/**
 * @test-id PARROT-MOBILE-SIGN-OUT-KEY-001
 * @level unit
 * @req ACCT-DEV-03[parrot]
 * @why Parrot's Sign out (Settings, and the key-entry screen) forgets the library key; without it the only way back
 *   in is typing it, since QR sign-in needs another device that still holds the key. `useSignOut` hands Parrot's
 *   words and its key store to the shared `signOutAskingForSavedKey`: a phone holding the key asks first with Cancel
 *   first, Cancel signs nothing out, the confirm signs out once; the key-entry screen, holding no key, signs out at
 *   once. Screens are tried on a device; this pins the question in every language Parrot ships and the store wiring.
 */
import { describe, expect, it } from "vitest";
import {
  createLibraryKeyStore,
  signOutAskingForSavedKey,
  type LibraryKeyStore,
  type SignOutKeyAlert,
} from "@space/mobile-shell/libraryKey";
import de from "../src/i18n/de.json";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import fr from "../src/i18n/fr.json";
import nl from "../src/i18n/nl.json";

// The files `startI18n` adds (src/lib/i18n.ts); imported as data, the i18n module pulls in react-native.
const PARROT_TRANSLATIONS = { en, fr, nl, de, es };

const log = (step: string, detail: Record<string, unknown> = {}) =>
  console.info(`[PARROT-MOBILE-SIGN-OUT-KEY-001] ${step}`, JSON.stringify(detail));

const memoryKeyStore = () => {
  const items = new Map<string, string>();
  return createLibraryKeyStore({
    keychain: {
      getGenericPassword: async ({ service }) => (items.has(service) ? { password: items.get(service)! } : false),
      setGenericPassword: async (_user, password, { service }) => void items.set(service, password),
      resetGenericPassword: async ({ service }) => void items.delete(service),
    },
    asyncStorage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
  });
};

const textFor = (language: keyof typeof PARROT_TRANSLATIONS) => PARROT_TRANSLATIONS[language].parrot.settings.signOutKey;

const run = async (store: LibraryKeyStore) => {
  const alerts: Parameters<SignOutKeyAlert>[] = [];
  const signOuts: string[] = [];
  const outcome = await signOutAskingForSavedKey({
    readStoredKey: store.get,
    text: textFor("en"),
    alert: (...args) => void alerts.push(args),
    signOut: async () => {
      signOuts.push("signOut");
      await store.clear();
    },
  });
  return { outcome, alerts, signOuts };
};

describe("Parrot phone Sign out asks a key holder whether the key was saved (ACCT-DEV-03)", () => {
  it("every Parrot language has the question, in Parrot's word for the key", () => {
    const keyWord = { en: "library key", fr: "clé de bibliothèque", nl: "bibliotheeksleutel", de: "Bibliotheksschlüssel", es: "clave de biblioteca" };
    for (const language of ["en", "fr", "nl", "de", "es"] as const) {
      const text = textFor(language);
      log("text", { language, text });
      for (const value of [text.title, text.body, text.cancel, text.confirm]) expect(value.trim().length).toBeGreaterThan(0);
      expect(text.title).toContain(keyWord[language]);
      expect(text.body).toContain("QR");
    }
    expect(textFor("en").title).toBe("Have you saved your library key?");
  });

  it("holder: asks, Cancel first and changes nothing; the confirm signs out once and forgets the key", async () => {
    const store = memoryKeyStore();
    await store.set("c".repeat(43) + "=");
    const { outcome, alerts, signOuts } = await run(store);
    log("asked", { outcome, buttons: alerts[0]?.[2].map((b) => [b.text, b.style]) });
    expect(outcome).toBe("asked");
    expect(signOuts).toEqual([]);
    const [title, body, buttons] = alerts[0]!;
    expect([title, body]).toEqual([textFor("en").title, textFor("en").body]);
    expect(buttons.map((b) => b.style)).toEqual(["cancel", "destructive"]);

    buttons[0]!.onPress?.();
    expect(signOuts).toEqual([]);
    expect(await store.get()).not.toBeNull();

    buttons[1]!.onPress?.();
    await new Promise((resolve) => setImmediate(resolve));
    log("confirmed", { signOuts, key: await store.get() });
    expect(signOuts).toEqual(["signOut"]);
    expect(await store.get()).toBeNull();
  });

  it("no key held (the key-entry screen): signs out at once, no question", async () => {
    const { outcome, alerts, signOuts } = await run(memoryKeyStore());
    log("noKey", { outcome, alerts: alerts.length, signOuts });
    expect(outcome).toBe("signedOut");
    expect(alerts).toHaveLength(0);
    expect(signOuts).toEqual(["signOut"]);
  });
});
