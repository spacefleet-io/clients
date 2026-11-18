// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import type SettingsRecoveryDialogsComponent from "../src/renderer/src/pages/SettingsRecoveryDialogs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../src/renderer/src/lib/storage", () => ({
  formatKeyForDisplay: (value: string) => value,
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (next: boolean) => void }) => (
    <button type="button" data-checked={checked ? "true" : "false"} onClick={() => onCheckedChange?.(!checked)} />
  ),
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
}));

const account = vi.hoisted(() => ({ hasPassword: true }));
vi.mock("@/auth", () => ({ useHasPassword: () => account.hasPassword }));

// On assertion failure, dump every action-mock's call count + the rendered
// button inventory so a misrouted dialog action is diagnosable from CI alone
// (per "Tests log generously"). try/catch so a dump failure can't mask the
// real assertion.
const dumpRecoveryDialogsSnapshot = (
  label: string,
  container: HTMLDivElement | null,
  mocks: Record<string, { mock: { calls: unknown[][] } }>,
) => {
  try {
    console.error(`=== [settings-recovery-dialogs:${label}] snapshot ===`);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    console.error(
      `buttons(${buttons.length})=${JSON.stringify(
        buttons.map((b) => ({
          text: b.textContent,
          ariaLabel: b.getAttribute("aria-label"),
          dataChecked: b.getAttribute("data-checked"),
        })),
      )}`,
    );
    const callCounts: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(mocks)) {
      callCounts[name] = { count: fn.mock.calls.length, args: fn.mock.calls };
    }
    console.error(`action-mock call counts=${JSON.stringify(callCounts, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("SettingsRecoveryDialogs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    account.hasPassword = true;
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  const shownKey = { key: "c2hvd24ga2V5", words: generateLibraryKeyWords("en", (b) => b.fill(1)).words };
  const newKey = generateLibraryKeyWords("en", (b) => b.fill(2));

  const renderDialogs = async (SettingsRecoveryDialogs: typeof SettingsRecoveryDialogsComponent, props: Record<string, unknown>) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = vi.fn();
    await act(async () => {
      root?.render(
        <SettingsRecoveryDialogs
          showKeyOpen
          setShowKeyOpen={noop}
          showKeyValue={null}
          copyShowKey={noop}
          showKeyPassword=""
          setShowKeyPassword={noop}
          showKeyNeedsCode={false}
          showKeyCode=""
          setShowKeyCode={noop}
          showKeyMethod={null}
          showKeyNotice={null}
          showKeyError={null}
          showKeyBusy={false}
          submitShowKey={noop}
          recoveryOpen={false}
          setRecoveryOpen={noop}
          recoveryKey={null}
          copyRecoveryKey={noop}
          recoveryConfirmed={false}
          setRecoveryConfirmed={noop}
          recoveryPassword=""
          setRecoveryPassword={noop}
          recoveryNeedsCode={false}
          recoveryCode=""
          setRecoveryCode={noop}
          recoveryMethod={null}
          recoveryNotice={null}
          recoveryError={null}
          recoveryBusy={false}
          submitRecovery={noop}
          resetOpen={false}
          setResetOpen={noop}
          resetConfirmed={false}
          setResetConfirmed={noop}
          resetPassword=""
          setResetPassword={noop}
          resetNeedsCode={false}
          resetCode=""
          setResetCode={noop}
          resetMethod={null}
          resetNotice={null}
          resetError={null}
          resetBusy={false}
          submitReset={noop}
          resetResending={false}
          resendResetCode={noop}
          {...props}
        />,
      );
      await Promise.resolve();
    });
  };

  it("UX-KEY-01: a key received from another device has no words, so Show key shows it grouped and says why", async () => {
    const { default: SettingsRecoveryDialogs } = await import("../src/renderer/src/pages/SettingsRecoveryDialogs");
    await renderDialogs(SettingsRecoveryDialogs, { showKeyValue: { key: "abcdefgh", words: null } });
    const field = container!.querySelector("input[readonly]") as HTMLInputElement | null;
    const note = container!.querySelector('[data-testid="show-key-paired"]')?.textContent;
    console.info(`[settings-recovery-dialogs:paired] field=${field?.value} note=${note}`);
    expect(field?.value).toBe("abcdefgh");
    expect(note).toBe("libraryKeyWords.pairedNoWords");
    expect(container!.querySelector('[data-testid="library-key-words"]')).toBeNull();
  });

  it("@bugfix @regression-proof routes show-key, rotate-key, and reset actions through the extracted dialogs", async () => {
    const submitShowKey = vi.fn();
    const submitRecovery = vi.fn();
    const submitReset = vi.fn();
    const resendResetCode = vi.fn();
    const copyShowKey = vi.fn();
    const copyRecoveryKey = vi.fn();
    const setShowKeyOpen = vi.fn();
    const setRecoveryOpen = vi.fn();
    const setResetOpen = vi.fn();
    const setRecoveryConfirmed = vi.fn();

    console.info(`[settings-recovery-dialogs:setup] importing + mounting all three dialogs open (show/rotate/reset)`);
    const { default: SettingsRecoveryDialogs } = await import("../src/renderer/src/pages/SettingsRecoveryDialogs");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SettingsRecoveryDialogs
          showKeyOpen
          setShowKeyOpen={setShowKeyOpen}
          showKeyValue={shownKey}
          copyShowKey={copyShowKey}
          showKeyPassword="secret"
          setShowKeyPassword={vi.fn()}
          showKeyNeedsCode={false}
          showKeyCode=""
          setShowKeyCode={vi.fn()}
          showKeyMethod={null}
          showKeyNotice={null}
          showKeyError={null}
          showKeyBusy={false}
          submitShowKey={submitShowKey}
          recoveryOpen
          setRecoveryOpen={setRecoveryOpen}
          recoveryKey={newKey}
          copyRecoveryKey={copyRecoveryKey}
          recoveryConfirmed
          setRecoveryConfirmed={setRecoveryConfirmed}
          recoveryPassword="secret"
          setRecoveryPassword={vi.fn()}
          recoveryNeedsCode={false}
          recoveryCode=""
          setRecoveryCode={vi.fn()}
          recoveryMethod={null}
          recoveryNotice={null}
          recoveryError={null}
          recoveryBusy={false}
          submitRecovery={submitRecovery}
          resetOpen
          setResetOpen={setResetOpen}
          resetConfirmed
          setResetConfirmed={vi.fn()}
          resetPassword="secret"
          setResetPassword={vi.fn()}
          resetNeedsCode
          resetCode="123456"
          setResetCode={vi.fn()}
          resetMethod="email"
          resetNotice={null}
          resetError={null}
          resetBusy={false}
          submitReset={submitReset}
          resetResending={false}
          resendResetCode={resendResetCode}
        />
      );
      await Promise.resolve();
    });

    const allMocks = {
      submitShowKey,
      submitRecovery,
      submitReset,
      resendResetCode,
      copyShowKey,
      copyRecoveryKey,
      setShowKeyOpen,
      setRecoveryOpen,
      setResetOpen,
      setRecoveryConfirmed,
    };

    const buttons = Array.from(container.querySelectorAll("button"));
    const copyButtons = buttons.filter((button) => button.getAttribute("aria-label") === "settings.recovery.rotate.copyButton");
    console.info(`[settings-recovery-dialogs:render] mounted buttons=${buttons.length} copyButtons=${copyButtons.length}`);
    if (copyButtons.length !== 2) {
      dumpRecoveryDialogsSnapshot("copy-buttons-count", container, allMocks);
    }
    expect(copyButtons).toHaveLength(2);

    console.info(`[settings-recovery-dialogs:interact] clicking copy/submit/resend/confirm/cancel across all three dialogs`);
    await act(async () => {
      copyButtons[0]?.click();
      copyButtons[1]?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.show.submit"))?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.rotate.submit"))?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.reset.submit"))?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.reset.resend"))?.click();
      buttons.find((button) => button.getAttribute("data-checked") === "true")?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.show.cancel"))?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.rotate.cancel"))?.click();
      buttons.find((button) => button.textContent?.includes("settings.recovery.reset.cancel"))?.click();
      await Promise.resolve();
    });

    const allRouted =
      copyShowKey.mock.calls.length === 1 &&
      copyRecoveryKey.mock.calls.length === 1 &&
      submitShowKey.mock.calls.length === 1 &&
      submitRecovery.mock.calls.length === 1 &&
      submitReset.mock.calls.length === 1 &&
      resendResetCode.mock.calls.length === 1 &&
      setRecoveryConfirmed.mock.calls.some((c) => c[0] === false) &&
      setShowKeyOpen.mock.calls.some((c) => c[0] === false) &&
      setRecoveryOpen.mock.calls.some((c) => c[0] === false) &&
      setResetOpen.mock.calls.some((c) => c[0] === false);
    console.info(
      `[settings-recovery-dialogs:verify] allRouted=${allRouted} copyShowKey=${copyShowKey.mock.calls.length} copyRecoveryKey=${copyRecoveryKey.mock.calls.length} submitShowKey=${submitShowKey.mock.calls.length} submitRecovery=${submitRecovery.mock.calls.length} submitReset=${submitReset.mock.calls.length} resend=${resendResetCode.mock.calls.length}`,
    );
    if (!allRouted) {
      dumpRecoveryDialogsSnapshot("action-routing", container, allMocks);
    }
    const grids = Array.from(container.querySelectorAll('[data-testid="library-key-words"]')).map((grid) =>
      Array.from(grid.querySelectorAll("li")).map((item) => item.textContent),
    );
    console.info(`[settings-recovery-dialogs:words] grids=${JSON.stringify(grids)}`);
    expect(grids).toEqual([
      shownKey.words.map((word, index) => `${index + 1}${word}`),
      newKey.words.map((word, index) => `${index + 1}${word}`),
    ]);
    expect(container.querySelector('[data-testid="show-key-paired"]')).toBeNull();
    expect(copyShowKey).toHaveBeenCalledTimes(1);
    expect(copyRecoveryKey).toHaveBeenCalledTimes(1);
    expect(submitShowKey).toHaveBeenCalledTimes(1);
    expect(submitRecovery).toHaveBeenCalledTimes(1);
    expect(submitReset).toHaveBeenCalledTimes(1);
    expect(resendResetCode).toHaveBeenCalledTimes(1);
    expect(setRecoveryConfirmed).toHaveBeenCalledWith(false);
    expect(setShowKeyOpen).toHaveBeenCalledWith(false);
    expect(setRecoveryOpen).toHaveBeenCalledWith(false);
    expect(setResetOpen).toHaveBeenCalledWith(false);
  });

  it("@req ACCT-AUTH-04[badger-desktop] an account without a password is asked no password to show, rotate or erase the key", async () => {
    account.hasPassword = false;
    const submitShowKey = vi.fn();
    const submitRecovery = vi.fn();
    const submitReset = vi.fn();
    const { default: SettingsRecoveryDialogs } = await import("../src/renderer/src/pages/SettingsRecoveryDialogs");
    await renderDialogs(SettingsRecoveryDialogs, {
      submitShowKey,
      recoveryOpen: true,
      recoveryKey: newKey,
      recoveryConfirmed: true,
      submitRecovery,
      resetOpen: true,
      resetConfirmed: true,
      submitReset,
    });
    const hints = Array.from(container!.querySelectorAll('[data-testid$="-no-password"]')).map((node) => node.getAttribute("data-testid"));
    const passwordFields = container!.querySelectorAll('input[type="password"]').length;
    console.info(`[settings-recovery-dialogs:no-password] hints=${JSON.stringify(hints)} passwordFields=${passwordFields}`);
    expect(passwordFields).toBe(0);
    expect(hints).toHaveLength(3);

    const click = async (label: string) => {
      const button = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    };
    await click("settings.recovery.show.submit");
    await click("settings.recovery.rotate.submit");
    await click("settings.recovery.reset.submit");
    expect(submitShowKey).toHaveBeenCalledTimes(1);
    expect(submitRecovery).toHaveBeenCalledTimes(1);
    expect(submitReset).toHaveBeenCalledTimes(1);
  });
});
