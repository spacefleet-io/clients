import { describe, expect, it } from "vitest";

import { deriveNoStoredKeyDecision } from "../src/renderer/src/lib/onboardingKeyDecision";

const SUITE = "onboarding-no-stored-key-decision";

// Pre-#304 the no-stored-key path treated every `exists:false` as "no library
// yet" and generated a new key, even when the server only reported its saved
// copy missing. That key would replace the one the user's library is under.
// PRIV-KEY-01: the same holds when the account has a key (its probe) but no
// Badger library yet, as after making the key in Parrot.
describe(`[${SUITE}] key onboarding with no key on this device`, () => {
  const cases = [
    {
      label: "saved copy missing (exists:false, bootstrapRequired:false) asks for the existing key",
      meta: { exists: false, bootstrapRequired: false, keyProbe: null },
      expected: { mode: "enter", promptReason: "missing" },
    },
    {
      label: "library present asks for the existing key",
      meta: { exists: true, bootstrapRequired: false, keyProbe: "probe" },
      expected: { mode: "enter", promptReason: "remote" },
    },
    {
      label: "no library ever created and no account key generates a key",
      meta: { exists: false, bootstrapRequired: true, keyProbe: null },
      expected: { mode: "generate", promptReason: "missing" },
    },
    {
      label: "no Badger library but an account key (made in Parrot) asks for that key",
      meta: { exists: false, bootstrapRequired: true, keyProbe: "probe" },
      expected: { mode: "enter", promptReason: "remote" },
    },
  ];

  for (const entry of cases) {
    it(`@bugfix @regression-proof @req LIB-SYNC-03 @req PRIV-KEY-01 ${entry.label}`, () => {
      const actual = deriveNoStoredKeyDecision(entry.meta);
      console.info(`[${SUITE}] meta=${JSON.stringify(entry.meta)} actual=${JSON.stringify(actual)} expected=${JSON.stringify(entry.expected)}`);
      expect(actual).toEqual(entry.expected);
    });
  }
});
