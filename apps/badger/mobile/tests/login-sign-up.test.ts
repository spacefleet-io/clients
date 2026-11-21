/**
 * @test-id MOBILE-LOGIN-SIGN-UP-001
 * @level unit
 *
 * The phone creates a free account; the TV only signs in (ACCT-AUTH-10, Chris 2026-11-19: "users can signup on
 * mobile, they just can't pay"). The phone's sign-in screen opens the shared create-account card (the rendered flow is
 * in `login-provider-sign-in.test.ts` and `packages/mobile-shell/tests/mobile-sign-up.test.tsx`), its five translation
 * files carry the sign-up and code words, and no phone source names a price or a way to pay (ACCT-PAY-02). The TV's
 * password path is the same sign-in screen, which draws no create-account link there. A failed sign-in shows the
 * message for its real cause (ACCT-AUTH-11).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import de from "../../../../packages/mobile-shell/src/i18n/de.json";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import es from "../../../../packages/mobile-shell/src/i18n/es.json";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";
import nl from "../../../../packages/mobile-shell/src/i18n/nl.json";
import { withSignInErrorTexts } from "@space/shared/signInError";

const APP = resolve(__dirname, "..");
const SRC = join(APP, "src");
const LOGIN = readFileSync(join(SRC, "screens/LoginScreen.tsx"), "utf8");
const LOCALES = [
  ["en", en],
  ["fr", fr],
  ["nl", nl],
  ["de", de],
  ["es", es],
] as const;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = ""): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((out, [key, value]) => {
    if (typeof value === "string") out[`${prefix}${key}`] = value;
    else Object.assign(out, flatten(value, `${prefix}${key}.`));
    return out;
  }, {});

describe("the phone creates a free account, the TV signs in (ACCT-AUTH-10)", () => {
  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it("the sign-in screen opens the shared create-account card on a phone only", () => {
    const wired = {
      card: LOGIN.includes("<MobileSignUp"),
      phoneOnly: /if \(!IS_TV && mode !== "signin"\)/.test(LOGIN),
      linkPhoneOnly: /\{IS_TV \? null : \(\s*<View style=\{styles\.prompts\}>\s*<MobileAuthLink[\s\S]*?testID="login-create-account"/.test(LOGIN),
    };
    console.info("[sign-up] LoginScreen wiring:", wired);
    expect(wired).toEqual({ card: true, phoneOnly: true, linkPhoneOnly: true });
  });

  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it("the TV's password path is this same sign-in screen", () => {
    const tvSignIn = readFileSync(join(SRC, "tv/screens/TvSignInScreen.tsx"), "utf8");
    const navigator = readFileSync(join(SRC, "navigation/AppNavigator.tsx"), "utf8");
    const usesLogin = tvSignIn.includes("<LoginScreen");
    console.info("[sign-up] TvSignInScreen renders LoginScreen:", usesLogin);
    expect(usesLogin).toBe(true);
    expect(navigator).toMatch(/IS_TV \? TvSignInScreen : LoginScreen/);
  });

  // @req ACCT-SIGNIN-04[badger-tv]
  it("the TV opens on the QR code, with the password form one button away", () => {
    const tvSignIn = readFileSync(join(SRC, "tv/screens/TvSignInScreen.tsx"), "utf8");
    const opensOnCode = /const \[passwordMode, setPasswordMode\] = useState\(false\)/.test(tvSignIn);
    console.info("[sign-up] TV opens on the QR code:", opensOnCode);
    expect(opensOnCode).toBe(true);
    expect(tvSignIn).toContain('testID="tv-pairing-use-password"');
    expect(tvSignIn).toContain('testID="tv-pairing-use-code"');
  });

  // @req ACCT-AUTH-10[badger-mobile]
  it.each(LOCALES)("the %s translation file has every sign-up and code word", (lang, tree) => {
    const flat = flatten(tree as Tree);
    const needed = [
      ...Object.keys(flatten(en as Tree)).filter((key) => key.startsWith("signup.") || key.startsWith("verifyEmail.")),
      "login.noAccountPrompt",
      "login.createAccount",
      "login.provider.signUpWith",
    ];
    const missing = needed.filter((key) => !flat[key]?.trim());
    console.info(`[sign-up] ${lang} missing:`, missing);
    expect(needed.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // @req ACCT-AUTH-10[badger-mobile]
  it("no phone source or phone text names a price or a way to pay (ACCT-PAY-02)", () => {
    // API calls and links that take money: a checkout, a plan change, the payment provider, the pricing page.
    const payment = /\b(startCheckout|completeStancerPayment|updateSubscription|createCheckout\w*|billingPortal\w*|stancer)\b|\/pricing\b|\/checkout\b/i;
    const sources = sourceFiles(SRC)
      .filter((path) => payment.test(readFileSync(path, "utf8")))
      .map((path) => relative(APP, path));
    const texts = LOCALES.flatMap(([lang, tree]) =>
      Object.entries(flatten(tree as Tree))
        .filter(([key, text]) => (key.startsWith("signup.") || key.startsWith("verifyEmail.")) && /€|\$\d|\bprice|\bprix|\bpreis|\bprecio|\bprijs/i.test(text))
        .map(([key]) => `${lang}:${key}`),
    );
    console.info("[sign-up] payment hits:", { sources, texts });
    expect(sources).toEqual([]);
    expect(texts).toEqual([]);
  });
});

describe("a failed sign-in says why (ACCT-AUTH-11)", () => {
  // @req ACCT-AUTH-11[badger-mobile,badger-tv]
  it("the sign-in screen maps every failure through the shared classifier and logs it", () => {
    const wired = {
      classifies: /classifySignInError\(err\)/.test(LOGIN),
      mapsKey: /signInErrorMessageKey\(failure\)/.test(LOGIN),
      logs: /log\.warn\("login\.failed"/.test(LOGIN),
      noBlanketFailed: !LOGIN.includes("login.errors.failed"),
    };
    console.info("[sign-in-why] LoginScreen wiring:", wired);
    expect(wired).toEqual({ classifies: true, mapsKey: true, logs: true, noBlanketFailed: true });
  });

  // @req ACCT-AUTH-11[badger-mobile,badger-tv]
  it.each(LOCALES)("the %s translation the app loads has every sign-in failure message", (lang, tree) => {
    // `login.errors` lives in @space/shared/signInError; mobile-shell's i18n merges it into each file.
    const login: unknown = withSignInErrorTexts(tree, lang).login;
    const found = login && typeof login === "object" && "errors" in login ? login.errors : null;
    const errors: Record<string, unknown> = found && typeof found === "object" ? { ...found } : {};
    const keys = ["credentials", "emailNotVerified", "deletionPending", "timeout", "unreachable", "serverError", "unknown", "invalidCode"];
    const missing = keys.filter((key) => {
      const text = errors[key];
      return typeof text !== "string" || !text.trim();
    });
    console.info(`[sign-in-why] ${lang} login.errors:`, errors);
    expect(missing).toEqual([]);
  });
});

describe("the phone's Delete account says what goes before it deletes (ACCT-DEL-02)", () => {
  const FORM = readFileSync(join(APP, "../../../packages/mobile-shell/src/components/mobile-delete-account.tsx"), "utf8");
  const SCREEN = readFileSync(join(SRC, "screens/DeleteAccountScreen.tsx"), "utf8");

  // @req ACCT-DEL-02[badger-mobile]
  it("the Delete account screen is the shared form, which shows the warning and the download-first line", () => {
    const wired = {
      sharedForm: SCREEN.includes("<MobileDeleteAccount"),
      warning: FORM.includes('t("deleteAccount.warning")'),
      keepFiles: FORM.includes('t("deleteAccount.keepFiles")'),
    };
    console.info("[delete-warning] wiring:", wired);
    expect(wired).toEqual({ sharedForm: true, warning: true, keepFiles: true });
  });

  // @req ACCT-DEL-02[badger-mobile]
  it.each(LOCALES)("the %s translation has the warning and the download-first line", (lang, tree) => {
    const flat = flatten(tree as Tree);
    const missing = ["deleteAccount.warning", "deleteAccount.keepFiles"].filter((key) => !flat[key]?.trim());
    console.info(`[delete-warning] ${lang} missing:`, missing);
    expect(missing).toEqual([]);
  });
});
