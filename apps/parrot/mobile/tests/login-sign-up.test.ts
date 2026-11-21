/**
 * @test-id PARROT-MOBILE-LOGIN-SIGN-UP-001
 * @level unit
 * @req ACCT-AUTH-10[parrot]
 * @req ACCT-DEL-01[parrot]
 * @req ACCT-DEL-02[parrot]
 * @why Chris 2026-11-19 (chat): "users can signup on mobile, they just can't pay, signing up only creates a free
 *   account. But they should be able to sign up". Parrot's phone opens the shared create-account card from its
 *   sign-in screen (the rendered flow: `login-provider-sign-in.test.tsx`, `packages/mobile-shell/tests/mobile-sign-up.test.tsx`)
 *   and, since it creates accounts, deletes them from Settings (Apple 5.1.1(v), Google Play's account deletion
 *   requirement) with the shared phone form. No Parrot phone source calls a payment API or links to a pricing page
 *   (ACCT-PAY-02).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "..");
const SRC = join(APP, "src");
const read = (path: string) => readFileSync(join(APP, path), "utf8");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

describe("Parrot phone creates free accounts and deletes them (ACCT-AUTH-10, ACCT-DEL-01)", () => {
  it("@req ACCT-AUTH-10[parrot] the sign-in screen opens the shared create-account card under the account heading", () => {
    const login = read("src/screens/LoginScreen.tsx");
    const wired = {
      heading: login.includes('t("login.withAccount")'),
      card: login.includes("<MobileSignUp"),
      link: login.includes('testID="login-create-account"'),
      unverifiedOpensCode: /onUnverified=\{\(\) => setMode\("verify"\)\}/.test(login),
    };
    console.info("[PARROT-MOBILE-LOGIN-SIGN-UP-001] LoginScreen wiring:", wired);
    expect(wired).toEqual({ heading: true, card: true, link: true, unverifiedOpensCode: true });
  });

  it("@req ACCT-DEL-01[parrot] Settings opens the shared delete-account form on its own page", () => {
    const settings = read("src/screens/SettingsScreen.tsx");
    const screen = read("src/screens/DeleteAccountScreen.tsx");
    const app = read("App.tsx");
    const wired = {
      settingsButton: /testID="settings-delete-account"[\s\S]{0,120}navigation\.navigate\("DeleteAccount"\)/.test(settings),
      route: /<Stack\.Screen name="DeleteAccount" component=\{DeleteAccountScreen\} \/>/.test(app),
      sharedForm: screen.includes("<MobileDeleteAccount"),
      signsOut: /onDeleted=\{\(\) => signOut\(\)/.test(screen),
    };
    console.info("[PARROT-MOBILE-LOGIN-SIGN-UP-001] delete-account wiring:", wired);
    expect(wired).toEqual({ settingsButton: true, route: true, sharedForm: true, signsOut: true });
  });

  it("@req ACCT-DEL-02[parrot] the delete page is the shared form, which shows the warning and the download-first line", () => {
    const screen = read("src/screens/DeleteAccountScreen.tsx");
    const form = read("../../../packages/mobile-shell/src/components/mobile-delete-account.tsx");
    const en = JSON.parse(read("../../../packages/mobile-shell/src/i18n/en.json"));
    const wired = {
      sharedForm: screen.includes("<MobileDeleteAccount"),
      warning: form.includes('t("deleteAccount.warning")') && Boolean(en.deleteAccount?.warning),
      keepFiles: form.includes('t("deleteAccount.keepFiles")') && Boolean(en.deleteAccount?.keepFiles),
    };
    console.info("[PARROT-MOBILE-LOGIN-SIGN-UP-001] delete warning wiring:", wired);
    expect(wired).toEqual({ sharedForm: true, warning: true, keepFiles: true });
  });

  it("@req ACCT-AUTH-10[parrot] no Parrot phone source calls a payment API or links to a pricing page", () => {
    const payment = /\b(startCheckout|completeStancerPayment|updateSubscription|createCheckout\w*|billingPortal\w*|stancer)\b|\/pricing\b|\/checkout\b/i;
    const offenders = sourceFiles(SRC)
      .filter((path) => payment.test(readFileSync(path, "utf8")))
      .map((path) => relative(APP, path));
    console.info("[PARROT-MOBILE-LOGIN-SIGN-UP-001] files naming a payment:", offenders);
    expect(offenders).toEqual([]);
  });
});
