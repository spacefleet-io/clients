// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  RadioGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  RadioGroupItem: ({ value, id }: { value?: string; id?: string }) => <input type="radio" value={value} id={id} readOnly />,
}));

const account = vi.hoisted(() => ({ hasPassword: true }));
vi.mock("@/auth", () => ({ useHasPassword: () => account.hasPassword }));

// On assertion failure, dump the rendered button labels + the mock call
// counts the test cares about so a routing regression is diagnosable from
// the CI log alone. Wrapped so a dump failure can't mask the real failure.
const dumpTwoFactorSnapshot = (
  label: string,
  ctx: {
    container?: HTMLElement | null;
    handlers?: Record<string, { mock?: { calls?: unknown[][] } }>;
  },
) => {
  try {
    console.error(`=== [account-two-factor-section:${label}] snapshot ===`);
    if (ctx.container) {
      const buttons = Array.from(ctx.container.querySelectorAll("button")).map(
        (b) => b.textContent ?? "",
      );
      console.error(`rendered buttons (${buttons.length}):\n${JSON.stringify(buttons, null, 2)}`);
      console.error(`container.textContent:\n${ctx.container.textContent ?? "(empty)"}`);
    }
    if (ctx.handlers) {
      const counts: Record<string, { calls: number; args: unknown[][] }> = {};
      for (const [name, fn] of Object.entries(ctx.handlers)) {
        counts[name] = {
          calls: fn?.mock?.calls?.length ?? 0,
          args: fn?.mock?.calls ?? [],
        };
      }
      console.error(`handler call counts:\n${JSON.stringify(counts, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("AccountTwoFactorSection", () => {
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

  it("@bugfix @regression-proof routes extracted 2fa enable, disable, and copy actions correctly", async () => {
    const setEnableMethod = vi.fn();
    const setEmailEnableCode = vi.fn();
    const setTotpCode = vi.fn();
    const setReauthPassword = vi.fn();
    const setReauthCode = vi.fn();
    const resetTwoFactorFlows = vi.fn();
    const startEnable = vi.fn();
    const requestEmailEnable = vi.fn();
    const confirmEmailEnable = vi.fn();
    const generateTotpSetup = vi.fn();
    const confirmTotpEnable = vi.fn();
    const copyText = vi.fn();
    const startDisable = vi.fn();
    const confirmDisable = vi.fn();

    const { default: AccountTwoFactorSection } = await import("../src/renderer/src/pages/AccountTwoFactorSection");

    console.info(`[account-two-factor-section:setup] rendering enable/email flow`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <AccountTwoFactorSection
          twoFactorEnabled={false}
          twoFactorMethod={null}
          twoFactorBusy={false}
          twoFactorMessage="ready"
          twoFactorError={null}
          enableFlowOpen
          enableMethod="email"
          setEnableMethod={setEnableMethod}
          emailEnableRequested
          emailEnableCode="123456"
          setEmailEnableCode={setEmailEnableCode}
          totpSetupState={{ secret: "secret", otpauthUrl: "otpauth://app", qrCode: "data:image/png;base64,qr" }}
          totpCode="654321"
          setTotpCode={setTotpCode}
          disableFlowOpen={false}
          reauthPassword="pw"
          setReauthPassword={setReauthPassword}
          reauthCode=""
          setReauthCode={setReauthCode}
          reauthCodeAsked={false}
          resetTwoFactorFlows={resetTwoFactorFlows}
          startEnable={startEnable}
          requestEmailEnable={requestEmailEnable}
          confirmEmailEnable={confirmEmailEnable}
          generateTotpSetup={generateTotpSetup}
          confirmTotpEnable={confirmTotpEnable}
          copyText={copyText}
          startDisable={startDisable}
          confirmDisable={confirmDisable}
        />
      );
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    console.info(
      `[account-two-factor-section:email-enable] clicking resendCode + enable + startOver across ${buttons.length} buttons`,
    );

    await act(async () => {
      buttons.find((button) => button.textContent?.includes("account.twoFactor.resendCode"))?.click();
      buttons.find((button) => button.textContent?.includes("account.twoFactor.enable"))?.click();
      buttons.find((button) => button.textContent?.includes("account.common.startOver"))?.click();
      await Promise.resolve();
    });

    if (
      requestEmailEnable.mock.calls.length !== 1 ||
      confirmEmailEnable.mock.calls.length !== 1 ||
      resetTwoFactorFlows.mock.calls.length !== 1
    ) {
      dumpTwoFactorSnapshot("email-enable", {
        container,
        handlers: { requestEmailEnable, confirmEmailEnable, resetTwoFactorFlows },
      });
    }
    expect(requestEmailEnable).toHaveBeenCalledTimes(1);
    expect(confirmEmailEnable).toHaveBeenCalledTimes(1);
    expect(resetTwoFactorFlows).toHaveBeenCalledTimes(1);

    console.info(`[account-two-factor-section:setup] re-rendering enable/totp flow`);
    await act(async () => {
      root?.render(
        <AccountTwoFactorSection
          twoFactorEnabled={false}
          twoFactorMethod={null}
          twoFactorBusy={false}
          twoFactorMessage={null}
          twoFactorError={null}
          enableFlowOpen
          enableMethod="totp"
          setEnableMethod={setEnableMethod}
          emailEnableRequested={false}
          emailEnableCode=""
          setEmailEnableCode={setEmailEnableCode}
          totpSetupState={{ secret: "secret", otpauthUrl: "otpauth://app", qrCode: "data:image/png;base64,qr" }}
          totpCode="654321"
          setTotpCode={setTotpCode}
          disableFlowOpen={false}
          reauthPassword="pw"
          setReauthPassword={setReauthPassword}
          reauthCode=""
          setReauthCode={setReauthCode}
          reauthCodeAsked={false}
          resetTwoFactorFlows={resetTwoFactorFlows}
          startEnable={startEnable}
          requestEmailEnable={requestEmailEnable}
          confirmEmailEnable={confirmEmailEnable}
          generateTotpSetup={generateTotpSetup}
          confirmTotpEnable={confirmTotpEnable}
          copyText={copyText}
          startDisable={startDisable}
          confirmDisable={confirmDisable}
        />
      );
      await Promise.resolve();
    });

    const totpButtons = Array.from(container.querySelectorAll("button"));
    console.info(
      `[account-two-factor-section:totp-enable] clicking copy + regenerateQr + enable across ${totpButtons.length} buttons`,
    );
    await act(async () => {
      totpButtons.find((button) => button.textContent?.includes("account.common.copy"))?.click();
      totpButtons.find((button) => button.textContent?.includes("account.twoFactor.regenerateQr"))?.click();
      totpButtons.find((button) => button.textContent?.includes("account.twoFactor.enable"))?.click();
      await Promise.resolve();
    });

    const copiedSecret =
      copyText.mock.calls.length === 1 && copyText.mock.calls[0]?.[0] === "secret";
    if (
      !copiedSecret ||
      generateTotpSetup.mock.calls.length !== 1 ||
      confirmTotpEnable.mock.calls.length !== 1
    ) {
      dumpTwoFactorSnapshot("totp-enable", {
        container,
        handlers: { copyText, generateTotpSetup, confirmTotpEnable },
      });
    }
    expect(copyText).toHaveBeenCalledWith("secret");
    expect(generateTotpSetup).toHaveBeenCalledTimes(1);
    expect(confirmTotpEnable).toHaveBeenCalledTimes(1);

    console.info(`[account-two-factor-section:setup] re-rendering disable flow`);
    await act(async () => {
      root?.render(
        <AccountTwoFactorSection
          twoFactorEnabled
          twoFactorMethod="email"
          twoFactorBusy={false}
          twoFactorMessage={null}
          twoFactorError={null}
          enableFlowOpen={false}
          enableMethod=""
          setEnableMethod={setEnableMethod}
          emailEnableRequested={false}
          emailEnableCode=""
          setEmailEnableCode={setEmailEnableCode}
          totpSetupState={null}
          totpCode=""
          setTotpCode={setTotpCode}
          disableFlowOpen
          reauthPassword="pw"
          setReauthPassword={setReauthPassword}
          reauthCode="999999"
          setReauthCode={setReauthCode}
          reauthCodeAsked
          resetTwoFactorFlows={resetTwoFactorFlows}
          startEnable={startEnable}
          requestEmailEnable={requestEmailEnable}
          confirmEmailEnable={confirmEmailEnable}
          generateTotpSetup={generateTotpSetup}
          confirmTotpEnable={confirmTotpEnable}
          copyText={copyText}
          startDisable={startDisable}
          confirmDisable={confirmDisable}
        />
      );
      await Promise.resolve();
    });

    const disableButtons = Array.from(container.querySelectorAll("button"));
    console.info(
      `[account-two-factor-section:disable] clicking disable across ${disableButtons.length} buttons`,
    );
    await act(async () => {
      disableButtons.find((button) => button.textContent?.includes("account.twoFactor.disable"))?.click();
      await Promise.resolve();
    });

    if (confirmDisable.mock.calls.length !== 1) {
      dumpTwoFactorSnapshot("disable", { container, handlers: { confirmDisable } });
    }
    expect(confirmDisable).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-AUTH-04
  it("asks for the password and the current code before turning 2FA off", async () => {
    const confirmDisable = vi.fn();
    const setReauthPassword = vi.fn();
    const setReauthCode = vi.fn();
    const noop = vi.fn();
    const { default: AccountTwoFactorSection } = await import("../src/renderer/src/pages/AccountTwoFactorSection");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const renderDisable = async (password: string, code: string) => {
      await act(async () => {
        root?.render(
          <AccountTwoFactorSection
            twoFactorEnabled
            twoFactorMethod="totp"
            twoFactorBusy={false}
            twoFactorMessage={null}
            twoFactorError={null}
            enableFlowOpen={false}
            enableMethod=""
            setEnableMethod={noop}
            emailEnableRequested={false}
            emailEnableCode=""
            setEmailEnableCode={noop}
            totpSetupState={null}
            totpCode=""
            setTotpCode={noop}
            disableFlowOpen
            reauthPassword={password}
            setReauthPassword={setReauthPassword}
            reauthCode={code}
            setReauthCode={setReauthCode}
            reauthCodeAsked={false}
            resetTwoFactorFlows={noop}
            startEnable={noop}
            requestEmailEnable={noop}
            confirmEmailEnable={noop}
            generateTotpSetup={noop}
            confirmTotpEnable={noop}
            copyText={noop}
            startDisable={noop}
            confirmDisable={confirmDisable}
          />,
        );
        await Promise.resolve();
      });
    };
    const disableButton = () =>
      Array.from(container?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "account.twoFactor.disable",
      ) as HTMLButtonElement | undefined;

    for (const [label, password, code, enabled] of [
      ["empty", "", "", false],
      ["password only", "pw", "", false],
      ["code only", "", "123456", false],
      ["password + code", "pw", "123456", true],
    ] as const) {
      await renderDisable(password, code);
      const passwordInput = container.querySelector("#twoFactorPassword") as HTMLInputElement | null;
      const codeInput = container.querySelector("#twoFactorReauthCode") as HTMLInputElement | null;
      console.info(
        `[account-two-factor-section:reauth] ${label}: password field=${Boolean(passwordInput)} type=${passwordInput?.type} code field=${Boolean(codeInput)} disable enabled=${disableButton()?.disabled === false}`,
      );
      if (!passwordInput || !codeInput || disableButton()?.disabled === enabled) {
        dumpTwoFactorSnapshot(`reauth-${label}`, { container, handlers: { confirmDisable } });
      }
      expect(passwordInput?.type).toBe("password");
      expect(codeInput).not.toBeNull();
      expect(disableButton()?.disabled).toBe(!enabled);
    }

    await act(async () => {
      disableButton()?.click();
      await Promise.resolve();
    });
    expect(confirmDisable).toHaveBeenCalledTimes(1);
  });

  it("@req ACCT-AUTH-04[badger-desktop] an account without a password turns 2FA off with the code alone", async () => {
    account.hasPassword = false;
    const confirmDisable = vi.fn();
    const noop = vi.fn();
    const { default: AccountTwoFactorSection } = await import("../src/renderer/src/pages/AccountTwoFactorSection");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const renderDisable = async (code: string) => {
      await act(async () => {
        root?.render(
          <AccountTwoFactorSection
            twoFactorEnabled
            twoFactorMethod="totp"
            twoFactorBusy={false}
            twoFactorMessage={null}
            twoFactorError={null}
            enableFlowOpen={false}
            enableMethod=""
            setEnableMethod={noop}
            emailEnableRequested={false}
            emailEnableCode=""
            setEmailEnableCode={noop}
            totpSetupState={null}
            totpCode=""
            setTotpCode={noop}
            disableFlowOpen
            reauthPassword=""
            setReauthPassword={noop}
            reauthCode={code}
            setReauthCode={noop}
            reauthCodeAsked={false}
            resetTwoFactorFlows={noop}
            startEnable={noop}
            requestEmailEnable={noop}
            confirmEmailEnable={noop}
            generateTotpSetup={noop}
            confirmTotpEnable={noop}
            copyText={noop}
            startDisable={noop}
            confirmDisable={confirmDisable}
          />,
        );
        await Promise.resolve();
      });
    };
    const disableButton = () =>
      Array.from(container?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "account.twoFactor.disable",
      ) as HTMLButtonElement | undefined;

    await renderDisable("");
    console.info(
      `[account-two-factor-section:no-password] password field=${Boolean(container.querySelector("#twoFactorPassword"))} hint=${Boolean(container.querySelector('[data-testid="twoFactorPassword-no-password"]'))} disable enabled=${disableButton()?.disabled === false}`,
    );
    expect(container.querySelector("#twoFactorPassword")).toBeNull();
    expect(container.querySelector('[data-testid="twoFactorPassword-no-password"]')?.textContent).toBe("account.security.noPasswordHint");
    expect(disableButton()?.disabled).toBe(true);

    await renderDisable("123456");
    expect(disableButton()?.disabled).toBe(false);
    await act(async () => {
      disableButton()?.click();
      await Promise.resolve();
    });
    expect(confirmDisable).toHaveBeenCalledTimes(1);
  });
});
