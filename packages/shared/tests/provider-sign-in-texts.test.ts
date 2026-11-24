/**
 * @req ACCT-SIGNIN-05 @req REL-FAM-03
 *
 * The Google, Apple and Microsoft sign-in words are written once (`providerSignInTexts`) and every app reads them: the
 * i18next apps (web, Badger desktop, the phones) as `login.provider` through `withProviderSignInTexts`, the desktop rows
 * and Parrot through `providerSignInText`. Each app keeps only its own "finish in your browser" sentence.
 */
import { describe, expect, it } from "vitest";
import { CLIENT_UI_LANGUAGES } from "../src/i18n";
import {
  PROVIDER_SIGN_IN_ERRORS,
  providerSignInErrorKey,
  providerSignInText,
  providerSignInTexts,
  withProviderSignInTexts,
} from "../src/providerSignIn";

const log = (message: string, extra?: unknown) => console.info("[provider-sign-in-texts.test]", message, extra ?? "");

describe("provider sign-in words (ACCT-SIGNIN-05)", () => {
  it("has every sentence and every return error in the five app languages", () => {
    for (const { code: language } of CLIENT_UI_LANGUAGES) {
      const texts = providerSignInTexts[language];
      log(language, texts);
      for (const key of ["signInWith", "signUpWith", "or", "errorStart"] as const) expect(texts[key].trim(), `${language} ${key}`).not.toBe("");
      for (const code of PROVIDER_SIGN_IN_ERRORS) expect(texts.errors[code]?.trim(), `${language} ${code}`).toBeTruthy();
      expect(Object.keys(texts.errors).sort()).toEqual([...PROVIDER_SIGN_IN_ERRORS].sort());
      expect(texts.signInWith).toContain("{{provider}}");
      expect(texts.signUpWith).toContain("{{provider}}");
    }
  });

  it("fills the provider's name, never translated", () => {
    expect(providerSignInText("en", "signInWith", "Google")).toBe("Sign in with Google");
    expect(providerSignInText("fr", "signUpWith", "Apple")).toBe("S'inscrire avec Apple");
    expect(providerSignInText("de", "signInWith", "Microsoft")).toBe("Mit Microsoft anmelden");
    expect(providerSignInText("nl", "or")).toBe("of");
  });

  it("goes into an i18next tree as login.provider, keeping the app's own keys", () => {
    const tree = { login: { title: "Sign in", errors: { credentials: "Wrong" }, provider: { continueInBrowser: "Finish in your browser." } }, other: 1 };
    const merged = withProviderSignInTexts(tree, "es");
    log("merged login", merged.login);
    expect(merged.other).toBe(1);
    expect(merged.login).toEqual({
      title: "Sign in",
      errors: { credentials: "Wrong" },
      provider: { continueInBrowser: "Finish in your browser.", ...providerSignInTexts.es },
    });
    // The input tree is left as it was.
    expect(tree.login.provider).toEqual({ continueInBrowser: "Finish in your browser." });
    expect(withProviderSignInTexts({}, "en")).toEqual({ login: { provider: providerSignInTexts.en } });
  });

  it("names each return error's key under login.provider.errors", () => {
    for (const code of PROVIDER_SIGN_IN_ERRORS) expect(providerSignInErrorKey(code)).toBe(`login.provider.errors.${code}`);
  });
});
