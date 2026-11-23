/**
 * @test-id MOBILE-LOGIN-SIGNIN-ONLY-001
 * @level unit
 *
 * The phone and TV apps only sign in (ACCT-AUTH-10): the sign-in screen (also the TV's "use a password" path) has no
 * sign-up or email-verification mode, no app source calls the sign-up API, and the phone's translation files carry no
 * sign-up words. A failed sign-in shows the message for its real cause (ACCT-AUTH-11).
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

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

describe("phone and TV sign in only (ACCT-AUTH-10)", () => {
  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it("the sign-in screen has no sign-up or email-verification mode", () => {
    // Whole words: `confirmPasswordReset` (the kept "Forgot password?" flow) is not the sign-up form's `confirmPassword`.
    const hits = ["signup", "Signup", "verifyEmail", "createAccount", "noAccountPrompt", "confirmPassword", "AuthMode"].filter((word) =>
      new RegExp(`\\b${word}\\b`).test(LOGIN)
    );
    console.info("[sign-in-only] LoginScreen sign-up words found:", hits);
    expect(hits).toEqual([]);
  });

  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it("no phone or TV source calls the sign-up or verify-email API", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /\b(signup|verifyEmail|resendVerification)\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(APP, path));
    console.info("[sign-in-only] files calling sign-up APIs:", offenders);
    expect(offenders).toEqual([]);
  });

  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it("the TV's password path is this same sign-in screen", () => {
    const tvSignIn = readFileSync(join(SRC, "tv/screens/TvSignInScreen.tsx"), "utf8");
    const navigator = readFileSync(join(SRC, "navigation/AppNavigator.tsx"), "utf8");
    const usesLogin = tvSignIn.includes("<LoginScreen");
    console.info("[sign-in-only] TvSignInScreen renders LoginScreen:", usesLogin);
    expect(usesLogin).toBe(true);
    expect(navigator).toMatch(/IS_TV \? TvSignInScreen : LoginScreen/);
  });

  // @req ACCT-SIGNIN-04[badger-tv]
  it("the TV opens on the QR code, with the password form one button away", () => {
    const tvSignIn = readFileSync(join(SRC, "tv/screens/TvSignInScreen.tsx"), "utf8");
    const opensOnCode = /const \[passwordMode, setPasswordMode\] = useState\(false\)/.test(tvSignIn);
    console.info("[sign-in-only] TV opens on the QR code:", opensOnCode);
    expect(opensOnCode).toBe(true);
    expect(tvSignIn).toContain('testID="tv-pairing-use-password"');
    expect(tvSignIn).toContain('testID="tv-pairing-use-code"');
  });

  // @req ACCT-AUTH-10[badger-mobile,badger-tv]
  it.each([
    ["en", en],
    ["fr", fr],
    ["nl", nl],
    ["de", de],
    ["es", es],
  ] as const)("the %s translation file has no sign-up words", (lang, tree) => {
    const t = tree as Record<string, unknown> & { login: Record<string, unknown> };
    const leftovers = [
      "signup" in t ? "signup" : null,
      "verifyEmail" in t ? "verifyEmail" : null,
      "createAccount" in t.login ? "login.createAccount" : null,
      "noAccountPrompt" in t.login ? "login.noAccountPrompt" : null,
    ].filter(Boolean);
    console.info(`[sign-in-only] ${lang} leftovers:`, leftovers);
    expect(leftovers).toEqual([]);
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
  it.each([
    ["en", en],
    ["fr", fr],
    ["nl", nl],
    ["de", de],
    ["es", es],
  ] as const)("the %s translation the app loads has every sign-in failure message", (lang, tree) => {
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
