/**
 * @test-id PARROT-MOBILE-LOGIN-SIGNIN-ONLY-001
 * @level unit
 * @req ACCT-AUTH-10[parrot]
 * @why ACCT-AUTH-10 binds the `parrot` app id on both platforms: Parrot desktop creates accounts
 *   (`apps/parrot/desktop/tests/sign-up.test.tsx`), Parrot's phone app only signs in, under "Sign in with your
 *   SpaceFleet account", with no sign-up or email-verification mode and no call to those APIs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "..");
const SRC = join(APP, "src");
const LOGIN = readFileSync(join(SRC, "screens/LoginScreen.tsx"), "utf8");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

describe("Parrot phone signs in only (ACCT-AUTH-10)", () => {
  it("@req ACCT-AUTH-10[parrot] the phone sign-in screen has no sign-up or email-verification mode, under the account heading", () => {
    // Whole words: `confirmPasswordReset` (the kept "Forgot password?" flow) is not a sign-up form's `confirmPassword`.
    const hits = ["signup", "Signup", "signUp", "SignUp", "verifyEmail", "createAccount", "noAccountPrompt", "confirmPassword"].filter((word) =>
      new RegExp(`\\b${word}\\b`).test(LOGIN),
    );
    console.info("[PARROT-MOBILE-LOGIN-SIGNIN-ONLY-001] LoginScreen sign-up words found:", hits);
    expect(hits).toEqual([]);
    expect(LOGIN).toContain('t("login.withAccount")');
  });

  it("@req ACCT-AUTH-10[parrot] no Parrot phone source calls the sign-up or verify-email API", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /\b(signup|signUp|verifyEmail|resendVerification)\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(APP, path));
    console.info("[PARROT-MOBILE-LOGIN-SIGNIN-ONLY-001] files calling sign-up APIs:", offenders);
    expect(offenders).toEqual([]);
  });
});
