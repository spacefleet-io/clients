import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

// On a missing-substring failure, dump which expected tokens are absent from
// which source file so the CI log pinpoints the regression without a repro.
const dumpStartupShellSnapshot = (
  label: string,
  files: Record<string, string>,
  expectations: Array<{ file: string; token: string; present: boolean }>
) => {
  try {
    console.error(`=== [startup-shell-source:${label}] snapshot ===`);
    for (const [name, src] of Object.entries(files)) {
      console.error(`file=${name} length=${src.length}`);
    }
    const missing = expectations.filter((e) => !e.present);
    console.error(`expectations: total=${expectations.length} missing=${missing.length}`);
    console.error(`missing tokens:\n${JSON.stringify(missing, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("badger startup shell source contracts", () => {
  it("routes auth and onboarding screens through the shared desktop startup shell", () => {
    console.info(`[startup-shell-source:setup] reading auth + onboarding page sources`);
    const login = readSource("src/renderer/src/pages/Login.tsx");
    const signup = readSource("src/renderer/src/pages/Signup.tsx");
    const verify = readSource("src/renderer/src/pages/VerifyEmail.tsx");
    const onboardingKey = readSource("src/renderer/src/pages/OnboardingKey.tsx");
    console.info(
      `[startup-shell-source:setup] sizes login=${login.length} signup=${signup.length} verify=${verify.length} onboardingKey=${onboardingKey.length}`
    );

    // Track each expected contract token so a failure can dump exactly which is
    // absent, rather than only surfacing the first failing expect().
    const files = { login, signup, verify, onboardingKey };
    const checks: Array<{ file: string; token: string; negate?: boolean }> = [
      { file: "login", token: "DesktopStartupPage" },
      { file: "login", token: "DesktopStartupControls" },
      { file: "login", token: "AuthCardLayout" },
      { file: "login", token: "desktopAuthInputClassName" },
      { file: "login", token: "DesktopAuthPrimaryButton" },
      { file: "login", token: "DesktopAuthPrompt" },
      { file: "login", token: "desktopAuthPromptActionClassName" },
      { file: "login", token: "DesktopForgotPasswordLink" },
      { file: "signup", token: "DesktopStartupPage" },
      { file: "signup", token: "DesktopStartupControls" },
      { file: "signup", token: "AuthCardLayout" },
      { file: "signup", token: "desktopAuthInputClassName" },
      { file: "signup", token: "DesktopAuthPrimaryButton" },
      { file: "signup", token: "DesktopAuthPrompt" },
      { file: "signup", token: "desktopAuthSignupButtonClassName" },
      { file: "signup", token: "desktopAuthSignupAccentTextClassName" },
      { file: "verify", token: "DesktopStartupPage" },
      { file: "verify", token: "DesktopStartupCard" },
      { file: "onboardingKey", token: "DesktopStartupPage" },
      { file: "onboardingKey", token: "DesktopStartupCard" },
      { file: "onboardingKey", token: 'maxWidthClassName="max-w-2xl"' },
      { file: "onboardingKey", token: "CardFooter", negate: true },
    ];
    const expectations = checks.map((c) => {
      const has = files[c.file as keyof typeof files].includes(c.token);
      return { file: c.file, token: c.token, present: c.negate ? !has : has };
    });
    if (expectations.some((e) => !e.present))
      dumpStartupShellSnapshot("routes-startup-shell", files, expectations);

    expect(login).toContain("DesktopStartupPage");
    expect(login).toContain("DesktopStartupControls");
    expect(login).toContain("AuthCardLayout");
    expect(login).toContain("desktopAuthInputClassName");
    expect(login).toContain("DesktopAuthPrimaryButton");
    expect(login).toContain("DesktopAuthPrompt");
    expect(login).toContain("desktopAuthPromptActionClassName");
    expect(login).toContain("DesktopForgotPasswordLink");

    expect(signup).toContain("DesktopStartupPage");
    expect(signup).toContain("DesktopStartupControls");
    expect(signup).toContain("AuthCardLayout");
    expect(signup).toContain("desktopAuthInputClassName");
    expect(signup).toContain("DesktopAuthPrimaryButton");
    expect(signup).toContain("DesktopAuthPrompt");
    expect(signup).toContain("desktopAuthSignupButtonClassName");
    expect(signup).toContain("desktopAuthSignupAccentTextClassName");

    expect(verify).toContain("DesktopStartupPage");
    expect(verify).toContain("DesktopStartupCard");

    expect(onboardingKey).toContain("DesktopStartupPage");
    expect(onboardingKey).toContain("DesktopStartupCard");
    expect(onboardingKey).toContain('maxWidthClassName="max-w-2xl"');
    expect(onboardingKey).not.toContain("CardFooter");
  });
});
