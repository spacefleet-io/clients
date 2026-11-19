/**
 * @test-id MOBILE-SHELL-PHONE-SETUP-001
 * @level unit
 * @req UX-SETUP-08
 * @req UX-SETUP-03
 * @req UX-SETUP-06
 * @req UX-SETUP-07
 *
 * The phone setup walkthrough's order and moves, the same on both phone apps: the language (step 0), the sign-in (not
 * counted), then the numbered steps: the key only after a regular sign-in, notifications, error reports; "step N of
 * M"; Back and Next; a setup left partway reopens at the step left, sent back to the sign-in when signed out, to the
 * key when it is gone, and past them when they are done.
 */
import { afterEach, describe, expect, it } from "vitest";
import { errorReportsOffered, setErrorReportsOffered } from "../src/errorReportsOffered";
import {
  INITIAL_PHONE_SETUP,
  askProfileSetupInSetup,
  askTitleLanguageInSetup,
  createPhoneSetupStore,
  nextPhoneSetupStep,
  parsePhoneSetupProgress,
  phoneSetupMoves,
  phoneSetupNumberedSteps,
  phoneSetupPosition,
  phoneSetupSignedOut,
  phoneSetupSteps,
  previousPhoneSetupStep,
  resolvePhoneSetupStep,
  type PhoneSetupProgress,
} from "../src/setup/phoneSetup";
import { createLivePhoneSetup } from "../src/setup/phoneSetupLive";

const at = (step: PhoneSetupProgress["step"], extra: Partial<PhoneSetupProgress> = {}): PhoneSetupProgress => ({ ...INITIAL_PHONE_SETUP, step, ...extra });

describe("phone setup walkthrough (both phone apps)", () => {
  // A build with a reporting address, as every other case assumes; the no-address case sets its own.
  afterEach(() => setErrorReportsOffered("https://key@errors.example.test/1"));

  it("opens on the language, then the sign-in, then three numbered steps after a regular sign-in and two after pairing", () => {
    console.info("steps", phoneSetupSteps({ pairedKey: false }), phoneSetupSteps({ pairedKey: true }));
    expect(phoneSetupSteps({ pairedKey: false })).toEqual(["language", "signIn", "libraryKey", "notifications", "errorReports"]);
    expect(phoneSetupSteps({ pairedKey: true })).toEqual(["language", "signIn", "notifications", "errorReports"]);
    expect(phoneSetupNumberedSteps({ pairedKey: false })).toEqual(["libraryKey", "notifications", "errorReports"]);
  });

  it("counts from the first step after the sign-in; the language and the sign-in are step 0", () => {
    expect(phoneSetupPosition(at("language"))).toEqual({ step: 0, total: 3 });
    expect(phoneSetupPosition(at("signIn"))).toEqual({ step: 0, total: 3 });
    expect(phoneSetupPosition(at("libraryKey"))).toEqual({ step: 1, total: 3 });
    expect(phoneSetupPosition(at("notifications"))).toEqual({ step: 2, total: 3 });
    expect(phoneSetupPosition(at("notifications", { pairedKey: true }))).toEqual({ step: 1, total: 2 });
    expect(phoneSetupPosition(at("errorReports", { pairedKey: true }))).toEqual({ step: 2, total: 2 });
  });

  it("moves with Back and Next; Back past the done sign-in and key goes to the language", () => {
    expect(previousPhoneSetupStep(at("language"))).toBeNull();
    expect(nextPhoneSetupStep(at("language"))).toBe("signIn");
    expect(nextPhoneSetupStep(at("signIn"))).toBe("libraryKey");
    expect(nextPhoneSetupStep(at("signIn", { pairedKey: true }))).toBe("notifications");
    expect(previousPhoneSetupStep(at("signIn"))).toBe("language");
    expect(previousPhoneSetupStep(at("libraryKey"))).toBe("signIn");
    expect(previousPhoneSetupStep(at("notifications"))).toBe("language");
    expect(previousPhoneSetupStep(at("notifications", { pairedKey: true }))).toBe("language");
    expect(previousPhoneSetupStep(at("errorReports"))).toBe("notifications");
    expect(nextPhoneSetupStep(at("errorReports"))).toBeNull();
  });

  // @req REL-LOG-06
  it("a build with no reporting address skips the error reports step: two steps, notifications ends it", async () => {
    setErrorReportsOffered("");
    console.info("[phone-setup] no DSN: offered", errorReportsOffered(), "steps", phoneSetupSteps({ pairedKey: false }));
    expect(phoneSetupSteps({ pairedKey: false })).toEqual(["language", "signIn", "libraryKey", "notifications"]);
    expect(phoneSetupPosition(at("libraryKey"))).toEqual({ step: 1, total: 2 });
    expect(phoneSetupPosition(at("notifications"))).toEqual({ step: 2, total: 2 });
    expect(phoneSetupPosition(at("notifications", { pairedKey: true }))).toEqual({ step: 1, total: 1 });
    expect(nextPhoneSetupStep(at("notifications"))).toBeNull();
    const saved: PhoneSetupProgress[] = [];
    expect(await phoneSetupMoves(at("notifications"), async (next) => void saved.push(next)).advance({ notifications: false })).toBeNull();
    expect(saved).toEqual([{ ...at("notifications"), notifications: false, done: true }]);
    setErrorReportsOffered("https://key@errors.example.test/1");
    expect(phoneSetupNumberedSteps({ pairedKey: false })).toEqual(["libraryKey", "notifications", "errorReports"]);
  });

  it("sends a signed-out phone back to the sign-in, a phone without its key to the key, and moves past done screens", () => {
    const cases: Array<[PhoneSetupProgress, { hasKey: boolean; signedIn: boolean }, string]> = [
      [at("language"), { hasKey: false, signedIn: false }, "language"],
      [at("language"), { hasKey: true, signedIn: true }, "language"],
      [at("signIn"), { hasKey: false, signedIn: false }, "signIn"],
      [at("notifications"), { hasKey: false, signedIn: false }, "signIn"],
      [at("signIn"), { hasKey: false, signedIn: true }, "libraryKey"],
      [at("signIn"), { hasKey: true, signedIn: true }, "notifications"],
      [at("signIn", { pairedKey: true }), { hasKey: true, signedIn: true }, "notifications"],
      [at("notifications"), { hasKey: false, signedIn: true }, "libraryKey"],
      [at("errorReports", { pairedKey: true }), { hasKey: false, signedIn: true }, "errorReports"],
      [at("errorReports"), { hasKey: true, signedIn: true }, "errorReports"],
    ];
    for (const [progress, account, expected] of cases) {
      const got = resolvePhoneSetupStep(progress, account);
      console.info("resolve", { step: progress.step, pairedKey: progress.pairedKey, ...account, got });
      expect(got).toBe(expected);
    }
  });

  it("keeps a saved sign-in step and whether the language was settled", () => {
    const saved = parsePhoneSetupProgress(JSON.stringify({ step: "signIn", done: false, languageReconciled: true }));
    expect(saved.step).toBe("signIn");
    expect(saved.languageReconciled).toBe(true);
    expect(parsePhoneSetupProgress(JSON.stringify({ step: "notifications" })).languageReconciled).toBe(false);
  });

  it("settles the language again after a sign-out during the setup (Back from the key)", () => {
    const key = at("libraryKey", { languageReconciled: true });
    expect(phoneSetupSignedOut(key)).toEqual({ ...key, languageReconciled: false });
    const unsettled = at("libraryKey");
    expect(phoneSetupSignedOut(unsettled)).toBe(unsettled);
    const done = at("errorReports", { done: true, languageReconciled: true });
    expect(phoneSetupSignedOut(done)).toBe(done);
  });
});

/** @req ACCT-PROF-03[badger-mobile] */
describe("phone setup title language step (Badger phone only)", () => {
  afterEach(() => askTitleLanguageInSetup(() => false));

  it("is never part of a setup that does not ask it (Parrot phone)", () => {
    expect(phoneSetupSteps({ pairedKey: false })).not.toContain("titleLanguage");
    expect(phoneSetupNumberedSteps({ pairedKey: true })).toEqual(["notifications", "errorReports"]);
  });

  it("comes right after the key, before notifications, numbered, while the profile picked never answered", () => {
    askTitleLanguageInSetup(() => true);
    console.info("[phone-setup] title asked", phoneSetupSteps({ pairedKey: false }));
    expect(phoneSetupSteps({ pairedKey: false })).toEqual(["language", "signIn", "libraryKey", "titleLanguage", "notifications", "errorReports"]);
    expect(phoneSetupPosition(at("titleLanguage"))).toEqual({ step: 2, total: 4 });
    expect(phoneSetupPosition(at("titleLanguage", { pairedKey: true }))).toEqual({ step: 1, total: 3 });
    expect(nextPhoneSetupStep(at("libraryKey"))).toBe("titleLanguage");
    expect(nextPhoneSetupStep(at("titleLanguage"))).toBe("notifications");
    expect(previousPhoneSetupStep(at("notifications"))).toBe("titleLanguage");
    expect(previousPhoneSetupStep(at("titleLanguage"))).toBe("language");
    expect(resolvePhoneSetupStep(at("libraryKey"), { hasKey: true, signedIn: true })).toBe("titleLanguage");
    expect(parsePhoneSetupProgress(JSON.stringify({ step: "titleLanguage" })).step).toBe("titleLanguage");
  });

  it("is skipped once the profile has an answer, even when saved at that step", () => {
    askTitleLanguageInSetup(() => false);
    expect(phoneSetupNumberedSteps({ pairedKey: false })).toEqual(["libraryKey", "notifications", "errorReports"]);
    expect(resolvePhoneSetupStep(at("titleLanguage"), { hasKey: true, signedIn: true })).toBe("notifications");
    expect(resolvePhoneSetupStep(at("titleLanguage"), { hasKey: false, signedIn: true })).toBe("libraryKey");
  });

  it("keeps its place in the count once answered in this setup, so the next steps keep their numbers", async () => {
    askTitleLanguageInSetup(() => true);
    const saved: PhoneSetupProgress[] = [];
    expect(await phoneSetupMoves(at("titleLanguage"), async (next) => void saved.push(next)).advance({ titleLanguageAnswered: true })).toBe("notifications");
    // The profile now has its answer: asked no more, but this setup answered it.
    askTitleLanguageInSetup(() => false);
    const after = saved[0]!;
    expect(after.step).toBe("notifications");
    expect(phoneSetupPosition(after)).toEqual({ step: 3, total: 4 });
    expect(previousPhoneSetupStep(after)).toBe("titleLanguage");
    expect(parsePhoneSetupProgress(JSON.stringify(after)).titleLanguageAnswered).toBe(true);
  });
});

/**
 * "Your profile" (UX-SETUP-10): a numbered step after the key (and "Who's watching?"), before the title question,
 * while the profile picked has not set up its name and avatar; both phone apps.
 * @req UX-SETUP-10[badger-mobile] @req UX-SETUP-10[parrot] @req UX-SETUP-03[badger-mobile] @req UX-SETUP-06[parrot]
 */
describe("phone setup profile step (both phone apps)", () => {
  afterEach(() => {
    askProfileSetupInSetup(() => false);
    askTitleLanguageInSetup(() => false);
  });
  const TAG = "[MOBILE-SHELL-PHONE-SETUP-001 profile]";

  it("comes right after the key, before the title question, numbered, while the profile picked has it pending", () => {
    askProfileSetupInSetup(() => true);
    askTitleLanguageInSetup(() => true);
    console.info(TAG, "steps", phoneSetupSteps({ pairedKey: false }));
    expect(phoneSetupSteps({ pairedKey: false })).toEqual(["language", "signIn", "libraryKey", "profileSetup", "titleLanguage", "notifications", "errorReports"]);
    expect(phoneSetupPosition(at("profileSetup"))).toEqual({ step: 2, total: 5 });
    expect(phoneSetupPosition(at("profileSetup", { pairedKey: true }))).toEqual({ step: 1, total: 4 });
    expect(nextPhoneSetupStep(at("libraryKey"))).toBe("profileSetup");
    expect(nextPhoneSetupStep(at("profileSetup"))).toBe("titleLanguage");
    expect(previousPhoneSetupStep(at("titleLanguage"))).toBe("profileSetup");
    expect(resolvePhoneSetupStep(at("libraryKey"), { hasKey: true, signedIn: true })).toBe("profileSetup");
    expect(parsePhoneSetupProgress(JSON.stringify({ step: "profileSetup" })).step).toBe("profileSetup");
  });

  it("is Parrot's step 2 of 4 after the key (no title question there)", () => {
    askProfileSetupInSetup(() => true);
    expect(phoneSetupNumberedSteps({ pairedKey: false })).toEqual(["libraryKey", "profileSetup", "notifications", "errorReports"]);
    expect(nextPhoneSetupStep(at("profileSetup"))).toBe("notifications");
  });

  it("is skipped for a profile already set up, even when saved at that step", () => {
    askTitleLanguageInSetup(() => true);
    expect(phoneSetupSteps({ pairedKey: false })).not.toContain("profileSetup");
    console.info(TAG, "resolve skipped", resolvePhoneSetupStep(at("profileSetup"), { hasKey: true, signedIn: true }));
    expect(resolvePhoneSetupStep(at("profileSetup"), { hasKey: true, signedIn: true })).toBe("titleLanguage");
    askTitleLanguageInSetup(() => false);
    expect(resolvePhoneSetupStep(at("profileSetup"), { hasKey: true, signedIn: true })).toBe("notifications");
    expect(resolvePhoneSetupStep(at("profileSetup"), { hasKey: false, signedIn: true })).toBe("libraryKey");
  });

  it("keeps its place in the count once answered in this setup", async () => {
    askProfileSetupInSetup(() => true);
    const saved: PhoneSetupProgress[] = [];
    expect(await phoneSetupMoves(at("profileSetup"), async (next) => void saved.push(next)).advance({ profileSetupAnswered: true })).toBe("notifications");
    askProfileSetupInSetup(() => false);
    const after = saved[0]!;
    console.info(TAG, "after answer", JSON.stringify(after), phoneSetupPosition(after));
    expect(after.step).toBe("notifications");
    expect(phoneSetupPosition(after)).toEqual({ step: 3, total: 4 });
    expect(previousPhoneSetupStep(after)).toBe("profileSetup");
    expect(parsePhoneSetupProgress(JSON.stringify(after)).profileSetupAnswered).toBe(true);
  });
});

describe("phone setup store", () => {

  it("keeps the answers on this phone and reads garbage as never started", async () => {
    const saved = new Map<string, string>();
    const store = createPhoneSetupStore({
      asyncStorage: { getItem: async (k) => saved.get(k) ?? null, setItem: async (k, v) => void saved.set(k, v) },
      key: "app.setup",
    });
    expect(await store.read()).toEqual(INITIAL_PHONE_SETUP);
    expect(await store.readSaved()).toBeNull();
    const progress = at("notifications", { language: "fr", notifications: true });
    await store.write(progress);
    expect(await store.read()).toEqual(progress);
    expect(parsePhoneSetupProgress("{oops")).toEqual(INITIAL_PHONE_SETUP);
    expect(parsePhoneSetupProgress(JSON.stringify({ step: "nope", done: "yes" }))).toEqual(INITIAL_PHONE_SETUP);
  });
});

const memoryStore = () => {
  const saved = new Map<string, string>();
  return {
    saved,
    store: createPhoneSetupStore({
      asyncStorage: { getItem: async (k) => saved.get(k) ?? null, setItem: async (k, v) => void saved.set(k, v) },
      key: "app.setup",
    }),
  };
};

// @req UX-SETUP-02
describe("phone setup moves (both phone apps)", () => {
  it("Next saves the answers and moves on, finishing on the last screen; Back saves the step before", async () => {
    const writes: PhoneSetupProgress[] = [];
    const save = async (next: PhoneSetupProgress) => void writes.push(next);
    expect(await phoneSetupMoves(at("language"), save).advance({ language: "de" })).toBe("signIn");
    expect(writes.at(-1)).toEqual(at("signIn", { language: "de" }));
    expect(await phoneSetupMoves(at("errorReports"), save).advance()).toBeNull();
    expect(writes.at(-1)).toEqual(at("errorReports", { done: true }));
    await phoneSetupMoves(at("notifications"), save).back!();
    expect(writes.at(-1)?.step).toBe("language");
    expect(phoneSetupMoves(at("language"), save).back).toBeUndefined();
    console.info("moves.writes", writes.map((w) => ({ step: w.step, done: w.done })));
  });
});

// @req UX-SETUP-07
describe("live phone setup progress", () => {
  it("shows every save at once, keeps it, and resumes from it", async () => {
    const { saved, store } = memoryStore();
    const live = createLivePhoneSetup({ store });
    expect(live.get()).toBeNull();
    let notified = 0;
    live.subscribe(() => void notified++);
    expect(await live.load()).toEqual(INITIAL_PHONE_SETUP);
    await live.save(at("signIn", { language: "nl" }));
    expect(live.get()).toEqual(at("signIn", { language: "nl" }));
    await live.markPaired();
    console.info("live.saved", saved.get("app.setup"), { notified });
    expect(notified).toBe(3);
    const again = createLivePhoneSetup({ store });
    expect(await again.load()).toEqual(at("signIn", { language: "nl", pairedKey: true }));
  });

  it("asks the app for a phone that never saved any (set up before the walkthrough existed)", async () => {
    const { store } = memoryStore();
    const live = createLivePhoneSetup({ store, unsaved: async () => ({ ...INITIAL_PHONE_SETUP, done: true }) });
    expect((await live.load()).done).toBe(true);
    await live.markPaired();
    expect(live.get()?.pairedKey).toBe(false);
  });
});
