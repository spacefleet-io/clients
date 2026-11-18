/**
 * @test-id PARROT-MOBILE-SIGN-IN-MASCOT-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @req UX-THEME-02[parrot]
 * @req UX-SETUP-06[parrot]
 * @why The approved sign-in shows the floating Parrot mascot over "SIGN IN WITH YOUR ACCOUNT". A phone now signs in
 *   first, on LoginScreen, before the setup (UX-SETUP-06), so the setup has no sign-in step left and LoginScreen is
 *   the one sign-in every phone sees, with Parrot's mascot picture.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const BRAND = /<MobileAuthBrand iconSource=\{PARROT_MASCOT\} subtitle=\{t\("login\.withAccount"\)\.toUpperCase\(\)\} \/>/;

/** The source of one top-level `const Name = (...) => { ... };` component. */
const component = (file: string, name: string) => {
  const text = readFileSync(resolve(SRC, file), "utf8");
  const start = text.indexOf(`const ${name} = `);
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("\n};\n", start));
};

describe("Parrot's sign-in mascot", () => {
  it("floats over the sign-in screen, the first screen of a new phone; the setup has no sign-in step", () => {
    const login = component("screens/LoginScreen.tsx", "LoginScreen");
    const setup = readFileSync(resolve(SRC, "setup/SetupFlow.tsx"), "utf8");
    console.info("[PARROT-MOBILE-SIGN-IN-MASCOT-001] brand", JSON.stringify({ login: BRAND.test(login), setupSignIn: setup.includes("SignInStep") }));
    expect(login).toMatch(BRAND);
    expect(setup).not.toContain("SignInStep");
  });

  it("uses Parrot's mascot picture, which ships with the app", () => {
    const brand = readFileSync(resolve(SRC, "brand.ts"), "utf8");
    const asset = /PARROT_MASCOT = require\("\.\/(assets\/[\w.-]+)"\)/.exec(brand)?.[1];
    expect(asset).toBe("assets/mascot.webp");
    expect(existsSync(resolve(SRC, asset!))).toBe(true);
  });
});
