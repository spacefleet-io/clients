/**
 * @test-id PARROT-MOBILE-LIBRARY-KEY-WORDS-001
 * @level unit
 * @why The library key is typed as 12 words (decision 2026-11-12). When the account has a key (any app's probe), its
 *   key screen and its setup key step read the 12 words (any case, the first 4 letters, a numbered copy) or the old 44-character
 *   base64 form, flag a word that is not one of the key words at once, allow Continue only on a whole key, then check
 *   the derived key against the account's key probe and save that key, exactly as the typed base64 was before.
 *   Chris 2026-11-12 (chat): "the setup step to enter/save the key should be the same shared one between the 2 apps":
 *   both are the shared `MobileLibraryKeyStep` (MOBILE-SHELL-LIBRARY-KEY-STEP-001 mounts it), with Parrot's check,
 *   other-device panel and the account-wide erase (Chris 2026-11-12 (chat): "they share the key and everything
 *   related to it"). Main 2026-11-12, relaying Chris ("Badger and Parrot share the key and everything related to
 *   it"): with no probe on the account (a new account, or after the erase) Parrot makes the key itself and shows its
 *   12 words to write down, as Badger does; it never sends the user to Badger, and never makes a key when a probe
 *   exists.
 *
 * The shared step is replaced by a stand-in that keeps the props Parrot hands it; the boxes' change is fed what the
 * real boxes read (`readLibraryKeyInput`), so this covers Parrot's wiring: what is kept, when Continue is on, what is
 * saved, what the erase calls.
 * @req UX-KEY-01[parrot]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords, readLibraryKeyInput } from "@space/shared/libraryKeyWords";
import type { MobileLibraryKeyStepProps } from "@space/mobile-shell/library-key-step";

const phone = vi.hoisted(() => ({
  keyProbe: null as string | null,
  exists: false,
  saved: [] as string[],
  claims: [] as [string, string][],
  claimError: null as Error | null,
  probeAfterFailedClaim: null as string | null,
  order: [] as string[],
  reset: [] as unknown[][],
  resetError: null as Error | null,
  signedOut: 0,
}));
const seen = vi.hoisted(() => ({ step: null as null | Record<string, unknown> }));

vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: Record<string, unknown>) => {
    seen.step = props;
    return null;
  },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
// The step stand-in renders nothing, so the warning is read from the `overlay` element Parrot hands it.
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/mascot-loader", () => ({ MobileMascotLoader: () => null }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/shared/api", () => ({
  getLibraryMeta: async () => ({ keyProbe: phone.keyProbe, exists: phone.exists }),
  resetLibrary: async (...args: unknown[]) => {
    phone.reset.push(args);
    if (phone.resetError) throw phone.resetError;
    return { ok: true };
  },
}));
// The probe "decrypts" only with the key it was made for, as AES-GCM does.
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({
  decryptBase64ToBytes: async (key: string, probe: string) => {
    if (key !== probe) throw new Error("bad tag");
    return new Uint8Array();
  },
}));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    session: { token: "phone-token" },
    saveLibraryKey: async (key: string) => {
      phone.order.push("save");
      phone.saved.push(key);
    },
  }),
}));
// Claiming the account publishes an empty library with the key, which writes the account's probe (made with it).
vi.mock("../src/lib/library", () => ({
  claimAccountKey: async (token: string, key: string) => {
    phone.order.push("claim");
    phone.claims.push([token, key]);
    if (phone.claimError) {
      phone.keyProbe = phone.probeAfterFailedClaim;
      throw phone.claimError;
    }
    phone.keyProbe = key;
    return { version: 1 };
  },
}));
vi.mock("../src/state/useSignOut", () => ({
  useSignOut: () => async () => {
    phone.signedOut += 1;
  },
}));
vi.mock("../src/screens/PairingPanel", () => ({ KeyPairingPanel: () => null }));

import { LibraryKeyScreen } from "../src/screens/LibraryKeyScreen";

const SUITE = "[PARROT-MOBILE-LIBRARY-KEY-WORDS-001]";

let renderer: ReactTestRenderer | null = null;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => void (await Promise.resolve()));
};
const step = () => seen.step as unknown as MobileLibraryKeyStepProps;
const warning = () => (step().overlay as React.ReactElement<{ visible: boolean; onConfirm: () => void }>).props;

const mount = async () => {
  await act(async () => {
    renderer = create(<LibraryKeyScreen />);
  });
  // The step first reads the account's meta: a probe asks for the key, none makes one.
  await flush();
  console.info(`${SUITE} mounted`, JSON.stringify({ probe: Boolean(phone.keyProbe), mode: step()?.mode ?? null }));
};

/** Types `text` into the boxes as the real boxes would hand it over. */
const type = async (text: string) => {
  const result = readLibraryKeyInput(text);
  await act(async () => step().onKeyChange!(text, result));
  const state = {
    status: result.status,
    canContinue: step().canContinue,
    error: step().error ?? null,
    words: "words" in result && result.words ? result.words : null,
  };
  console.info(`${SUITE} typed ${JSON.stringify(text)}`, JSON.stringify(state));
  return state;
};

const pressContinue = async () => {
  await act(async () => step().onContinue());
  await flush();
  console.info(`${SUITE} continue`, JSON.stringify({ saved: phone.saved, error: step().error ?? null }));
};

const KEY = generateLibraryKeyWords("en");

beforeEach(() => {
  phone.keyProbe = KEY.keyBase64;
  phone.exists = false;
  phone.saved = [];
  phone.claims = [];
  phone.claimError = null;
  phone.probeAfterFailedClaim = null;
  phone.order = [];
  phone.reset = [];
  phone.resetError = null;
  phone.signedOut = 0;
  seen.step = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

// @req UX-KEY-01
describe("Parrot phone: the library key is typed as 12 words", () => {
  it("hands the shared step enter mode with Parrot's title, the other-device panel, the erase, Back signing out", async () => {
    await mount();
    const props = step();
    console.info(
      `${SUITE} step`,
      JSON.stringify({ mode: props.mode, title: props.title, header: props.header, continueLabel: props.continueLabel, canContinue: props.canContinue }),
    );
    expect(props.mode).toBe("enter");
    expect(props.title).toBe("parrot.key.title");
    expect(props.body).toBe("parrot.key.body");
    // After the setup: no "step N of M" header; the shared "Continue" (no app label).
    expect(props.header).toBeNull();
    expect(props.continueLabel).toBeUndefined();
    expect(props.canContinue).toBe(false);
    expect(typeof props.renderOtherDevice).toBe("function");
    expect(typeof props.onErase).toBe("function");
    await act(async () => props.onBack!());
    expect(phone.signedOut).toBe(1);
  });

  it("keeps Continue off while the boxes are empty or partial", async () => {
    await mount();
    const partial = await type(KEY.words.slice(0, 5).join(" "));
    expect(partial.status).toBe("incomplete");
    expect(partial.canContinue).toBe(false);
  });

  it("flags an unknown word at once and keeps Continue off", async () => {
    await mount();
    const typed = await type(`${KEY.words[0]} zzzzqx`);
    expect(typed.status).toBe("unknownWord");
    expect(typed.canContinue).toBe(false);
    await pressContinue();
    expect(phone.saved).toEqual([]);
  });

  it("accepts the 12 words in capitals and by their first 4 letters, and saves the derived key", async () => {
    await mount();
    const typed = await type(KEY.words.map((word, i) => (i % 2 ? word.slice(0, 4) : word).toUpperCase()).join("\n"));
    expect(typed.status).toBe("ok");
    expect(typed.canContinue).toBe(true);
    await pressContinue();
    expect(phone.saved).toEqual([KEY.keyBase64]);
    expect(step().error).toBeNull();
  });

  it("still accepts the old 44-character base64 key", async () => {
    await mount();
    const typed = await type(` ${KEY.keyBase64} `);
    expect(typed.status).toBe("ok");
    await pressContinue();
    expect(phone.saved).toEqual([KEY.keyBase64]);
  });

  it("says a whole key that does not open the library is the wrong key, and saves nothing", async () => {
    await mount();
    phone.keyProbe = generateLibraryKeyWords("en").keyBase64;
    await type(KEY.words.join(" "));
    await pressContinue();
    expect(phone.saved).toEqual([]);
    expect(step().error).toBe("libraryKeyStep.wrongKey");
  });

  it("erases the account's library with the password and code, then makes the new key here (never 'open Badger')", async () => {
    await mount();
    await act(async () => step().onErase!("pw", "123456"));
    await flush();
    console.info(`${SUITE} erase`, JSON.stringify({ reset: phone.reset, mode: step().mode, words: step().words?.length, error: step().error ?? null }));
    expect(phone.reset).toEqual([["phone-token", "pw", "123456"]]);
    expect(step().mode).toBe("show");
    expect(step().words).toHaveLength(12);
    expect(step().error ?? null).toBeNull();
  });

  it("lets a failed erase reject unchanged, for the dialog to say why", async () => {
    await mount();
    const failure = Object.assign(new Error("invalid_password"), { status: 401 });
    phone.resetError = failure;
    let caught: unknown = null;
    await act(async () => {
      await step().onErase!("bad").catch((err: unknown) => {
        caught = err;
      });
    });
    console.info(`${SUITE} failed erase`, String(caught), JSON.stringify({ error: step().error ?? null }));
    expect(caught).toBe(failure);
    expect(step().error ?? null).toBeNull();
  });
});

// @req UX-KEY-01
describe("Parrot phone: an account with no key gets one made here", () => {
  it("shows a new key's 12 words with 'I've written it down' when no app has a probe, and saves it only after the warning", async () => {
    phone.keyProbe = null;
    await mount();
    const props = step();
    console.info(`${SUITE} new key`, JSON.stringify({ mode: props.mode, title: props.title, words: props.words, label: props.continueLabel }));
    expect(props.mode).toBe("show");
    expect(props.title).toBe("parrot.key.showTitle");
    expect(props.words).toHaveLength(12);
    expect(props.continueLabel).toBe("I've written it down");
    expect(props.renderOtherDevice).toBeUndefined();
    expect(props.onErase).toBeUndefined();
    expect(props.canContinue).toBe(true);
    await act(async () => props.onContinue());
    expect(warning().visible).toBe(true);
    expect(phone.saved).toEqual([]);
    const words = props.words!;
    await act(async () => warning().onConfirm());
    await flush();
    console.info(`${SUITE} kept`, JSON.stringify({ saved: phone.saved, words: words.join(" ") }));
    const read = readLibraryKeyInput(words.join(" "));
    expect(read.status).toBe("ok");
    expect(phone.saved).toEqual([read.status === "ok" ? read.keyBase64 : null]);
  });

  it("never makes a key when a probe exists", async () => {
    await mount();
    console.info(`${SUITE} probe present`, JSON.stringify({ mode: step().mode, words: step().words ?? null }));
    expect(step().mode).toBe("enter");
    expect(step().words).toBeUndefined();
  });

  it("asks for the key instead when another device made one while the new key was shown", async () => {
    phone.keyProbe = null;
    await mount();
    await act(async () => step().onContinue());
    phone.keyProbe = KEY.keyBase64;
    await act(async () => warning().onConfirm());
    await flush();
    console.info(`${SUITE} made elsewhere`, JSON.stringify({ mode: step().mode, saved: phone.saved }));
    expect(phone.saved).toEqual([]);
    expect(step().mode).toBe("enter");
  });
});

// Main 2026-11-12: "On start (and on foreground if cheap), the app checks that its kept key still matches the account's
// library/probe. A mismatch or a missing probe means: forget the key [...]". A key made here must therefore be the
// account's before it is kept: an empty library is published with it (writing the probe), as the desktop apps claim it.
describe("Parrot phone: a key made here becomes the account's before it is kept (UX-KEY-01)", () => {
  const makeAndKeep = async () => {
    phone.keyProbe = null;
    await mount();
    await act(async () => step().onContinue());
    await act(async () => warning().onConfirm());
    await flush();
    const state = { mode: step().mode, saved: phone.saved.length, claims: phone.claims.length, order: phone.order, error: step().error ?? null };
    console.info(`${SUITE} make and keep`, JSON.stringify(state));
    return state;
  };

  it("publishes the empty library with the new key (writing the probe), then saves that same key", async () => {
    const state = await makeAndKeep();
    expect(phone.claims).toHaveLength(1);
    expect(phone.claims[0]![0]).toBe("phone-token");
    expect(phone.saved).toEqual([phone.claims[0]![1]]);
    expect(state.order).toEqual(["claim", "save"]);
    expect(phone.keyProbe).toBe(phone.claims[0]![1]);
  });

  it("asks for the account's key when the claim lost to another device that made one first", async () => {
    phone.claimError = new Error("HTTP 409");
    phone.probeAfterFailedClaim = KEY.keyBase64;
    const state = await makeAndKeep();
    expect(state.claims).toBe(1);
    expect(state.saved).toBe(0);
    expect(state.mode).toBe("enter");
  });

  it("keeps nothing and says the account can't be reached when the claim fails with no probe after", async () => {
    phone.claimError = new Error("Network request failed");
    const state = await makeAndKeep();
    expect(state.saved).toBe(0);
    expect(state.mode).toBe("show");
    expect(state.error).toBe("parrot.key.errors.unavailable");
  });

  it("does not claim over a library that predates key probes (its snapshot stays the key check)", async () => {
    phone.exists = true;
    const state = await makeAndKeep();
    expect(state.claims).toBe(0);
    expect(state.saved).toBe(1);
  });
});
