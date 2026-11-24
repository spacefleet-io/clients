// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-CHANGE-HIDDEN-001
 * @level unit
 * @why ACCT-KEYCHG-04 (Chris 2026-11-23): Badger offers to change the media library key exactly when the server would
 *   accept it, so no user meets the media refusal. Badger desktop re-seals media (STOR-RESEAL-01), so that is every
 *   account whose readiness is known (`GET /library/recovery/rotate`), with or without media. The test renders the real
 *   Security settings section (account calls and the recovery flows stubbed, the server's answer driven) and checks the
 *   "Library access" panel keeps Show key, hides the Replace key card only while the answer is unknown, and the erase
 *   entry stays in every case.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyRotationReadiness } from "@space/shared/keyChange";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const server = vi.hoisted(() => ({ readiness: null as KeyRotationReadiness | null }));
vi.mock("@space/shared/useKeyRotationReadiness", () => ({ useKeyRotationReadiness: () => server.readiness }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), () => undefined] }));
vi.mock("@/auth", () => ({ useAuth: () => ({ token: null, logout: async () => undefined }), useHasPassword: () => true }));
vi.mock("@/api", () => ({
  ApiError: class ApiError extends Error {},
  TwoFactorMethod: {},
  cancelScheduledDeletion: vi.fn(),
  changePassword: vi.fn(),
  confirmEmailTwoFactorEnable: vi.fn(),
  confirmTotp: vi.fn(),
  disableTwoFactor: vi.fn(),
  getDeletionOptions: vi.fn(async () => null),
  getSettings: vi.fn(),
  requestEmailTwoFactorEnable: vi.fn(),
  setupTotp: vi.fn(),
}));
vi.mock("@/lib/settings/useLibraryRecoveryFlows", () => ({
  useLibraryRecoveryFlows: () => ({ setShowKeyOpen: () => undefined, setRecoveryOpen: () => undefined, setResetOpen: () => undefined }),
}));
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  cn: (...names: unknown[]) => names.filter(Boolean).join(" "),
}));
// The lazy dialogs and the two-factor block are not under test.
vi.mock("../src/renderer/src/pages/AccountTwoFactorSection", () => ({ default: () => null }));
vi.mock("../src/renderer/src/pages/AccountDeleteDialog", () => ({ default: () => null }));
vi.mock("../src/renderer/src/pages/SettingsRecoveryDialogs", () => ({ default: () => null }));

describe("@req ACCT-KEYCHG-04[badger-desktop] Badger settings offer a key change only when the server accepts it", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  const renderSection = async (readiness: KeyRotationReadiness | null) => {
    server.readiness = readiness;
    const { default: SecuritySection } = await import("../src/renderer/src/components/settings/sections/SecuritySection");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<SecuritySection />));
    const text = container.textContent ?? "";
    console.info(
      `[key-change-hidden] readiness=${JSON.stringify(readiness)} buttons=${JSON.stringify([...container.querySelectorAll("button")].map((b) => b.textContent))}`
    );
    expect(text).toContain("settings.recovery.title");
    expect(text).toContain("settings.recovery.show.button");
    expect(text).toContain("settings.recovery.reset.title");
    return { text, card: container.querySelector("[data-testid='settings-key-change']") };
  };

  it("offers no key change while the server's answer is not known (loading, offline); erasing stays offered", async () => {
    const { text, card } = await renderSection(null);
    expect(text).not.toContain("Replace media library key");
    expect(text).not.toContain("Create new key");
    expect(card).toBeNull();
  });

  it.each([
    ["without media", { needsMediaReseal: false }],
    ["with media (re-sealed during the change)", { needsMediaReseal: true }],
  ])("offers the key change to an account %s", async (_label, readiness) => {
    const { text, card } = await renderSection(readiness);
    expect(card).not.toBeNull();
    expect(text).toContain("Replace media library key");
    expect(text).toContain("Create new key");
  });
});
