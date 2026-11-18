// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-SETUP-BRAND-001
 * @level unit
 * @req UX-THEME-02[parrot]
 * @why Parrot's first setup must look like Badger's: the fleet's startup card with the floating Parrot mascot glowing
 *   green, and Parrot's green accent in place of the old lime.
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => {
  const Pass = ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>;
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      const { size: _size, variant: _variant, ...rest } = props;
      return <button {...rest}>{children}</button>;
    },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Spinner: () => <span />,
    KeySavedWarningDialog: () => null,
    LanguageMenu: () => <div data-testid="language-menu" />,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
  };
});

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const state: ParrotState = {
  setup: { step: "language", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

describe("Parrot desktop setup brand", () => {
  it("shows the floating Parrot mascot with a green glow above the setup card", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Setup t={translator("en")} state={state} onState={() => undefined} />));
    // The picture comes from @space/parrot-core (REL-CD-30); the bundler gives it a path ending in mascot.webp.
    const mascot = host.querySelector('img[src*="mascot"][src$=".webp"]');
    console.log("[parrot-setup-brand] mascot src", mascot?.getAttribute("src"));
    expect(mascot).not.toBeNull();
    expect(mascot?.parentElement?.className).toContain("animate-float");
    expect(mascot?.className).toContain("rgba(64,221,143,0.3)");
    expect(host.querySelector('[data-testid="setup-language"]')).not.toBeNull();
    // UX-SETUP-08: the language is step 0 and shows no count.
    expect(host.querySelector('[data-testid="setup-progress"]')).toBeNull();
    act(() => root.unmount());
  });

  it("uses Parrot green as the primary colour", () => {
    const css = readFileSync(resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
    expect(css).toContain("--primary: 150 70% 56%;");
    expect(css).not.toContain("96 62% 58%");
  });
});
