// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/api";
import AccountDeleteDialog from "../src/renderer/src/pages/AccountDeleteDialog";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const deleteAccountMock = vi.hoisted(() => vi.fn());
const logoutMock = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({ hasPassword: true }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@/api", () => {
  class ApiError extends Error {
    status: number;
    payload: Record<string, unknown>;
    constructor(status: number, payload: Record<string, unknown>) {
      super(String(payload.error ?? "api_error"));
      this.status = status;
      this.payload = payload;
    }
  }
  return { ApiError, deleteAccount: deleteAccountMock };
});

vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "tok-1", logout: logoutMock }),
  useHasPassword: () => account.hasPassword,
}));

vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// Dump-on-failure: rendered labels + disabled state + API/logout call records so a
// failing assertion is diagnosable offline (e.g. a renamed i18n key or test id).
const dumpSnapshot = (label: string, container: HTMLElement | null, onOpenChange?: Mock) => {
  try {
    console.error(`=== [account-delete-dialog:${label}] snapshot ===`);
    console.error(`deleteAccount calls=${JSON.stringify(deleteAccountMock.mock.calls)}`);
    console.error(`logout callCount=${logoutMock.mock.calls.length}`);
    console.error(`onOpenChange calls=${JSON.stringify(onOpenChange?.mock.calls ?? null)}`);
    if (container) console.error(`container.innerHTML:\n${container.innerHTML}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const setInputValue = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

type DeleteDialogUi = {
  password: () => HTMLInputElement;
  confirm: () => HTMLInputElement;
  code: () => HTMLInputElement | null;
  submit: () => HTMLButtonElement;
  error: () => HTMLElement | null;
  form: () => HTMLFormElement;
};

describe("AccountDeleteDialog (#145)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const onOpenChange = vi.fn();

  const mount = async (
    extra: { periodEndDeleteAt?: string | null; onScheduled?: (deleteAt: string) => void } = {},
  ): Promise<DeleteDialogUi> => {
    console.info(`[account-delete-dialog:setup] mounting AccountDeleteDialog in a jsdom root`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<AccountDeleteDialog open onOpenChange={onOpenChange} {...extra} />);
      await Promise.resolve();
    });
    const q = <T extends HTMLElement>(selector: string) => container?.querySelector(selector) as T | null;
    return {
      password: () => q<HTMLInputElement>("#accountDeletePassword")!,
      confirm: () => q<HTMLInputElement>("#accountDeleteConfirm")!,
      code: () => q<HTMLInputElement>("#accountDeleteCode"),
      submit: () => q<HTMLButtonElement>('[data-testid="account-delete-confirm"]')!,
      error: () => q<HTMLElement>('[data-testid="account-delete-error"]'),
      form: () => q<HTMLFormElement>('[data-testid="account-delete-form"]')!,
    };
  };

  const clickSubmit = async (ui: DeleteDialogUi) => {
    await act(async () => {
      ui.form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    deleteAccountMock.mockReset();
    logoutMock.mockReset();
    logoutMock.mockResolvedValue(undefined);
    onOpenChange.mockReset();
    account.hasPassword = true;
  });

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    if (container?.parentNode) container.parentNode.removeChild(container);
    container = null;
  });

  it("shows the irreversible warning and tells the user to download the library first", async () => {
    const ui = await mount();
    const text = container?.textContent ?? "";
    console.info(`[account-delete-dialog:copy] text=${JSON.stringify(text)}`);
    try {
      expect(text).toContain("account.deletion.confirmDescription");
      expect(container?.querySelector('[data-testid="account-delete-download-warning"]')?.textContent).toContain(
        "account.deletion.downloadWarning",
      );
      expect(ui.code()).toBeNull();
    } catch (err) {
      dumpSnapshot("copy", container);
      throw err;
    }
  });

  it("keeps Delete disabled until a password AND the word DELETE are entered", async () => {
    const ui = await mount();
    console.info(`[account-delete-dialog:gate] initial disabled=${ui.submit().disabled}`);
    try {
      expect(ui.submit().disabled).toBe(true);

      await setInputValue(ui.password(), "hunter22");
      expect(ui.submit().disabled).toBe(true); // password alone is not enough

      await setInputValue(ui.confirm(), "delete");
      expect(ui.submit().disabled).toBe(true); // exact, case-sensitive word

      await setInputValue(ui.confirm(), "DELETE");
      expect(ui.submit().disabled).toBe(false);

      await setInputValue(ui.password(), "");
      expect(ui.submit().disabled).toBe(true); // DELETE alone is not enough

      await clickSubmit(ui);
      expect(deleteAccountMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpSnapshot("gate", container);
      throw err;
    }
  });

  it("calls deleteAccount with password + DELETE, closes, then logs out", async () => {
    deleteAccountMock.mockResolvedValue({ status: "deletion_scheduled" });
    const ui = await mount();
    await setInputValue(ui.password(), "hunter22");
    await setInputValue(ui.confirm(), "DELETE");
    await clickSubmit(ui);
    console.info(
      `[account-delete-dialog:submit] deleteAccount=${JSON.stringify(deleteAccountMock.mock.calls)} logout=${logoutMock.mock.calls.length}`,
    );
    try {
      expect(deleteAccountMock).toHaveBeenCalledTimes(1);
      expect(deleteAccountMock).toHaveBeenCalledWith("tok-1", { password: "hunter22", confirm: "DELETE" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(logoutMock).toHaveBeenCalledWith("signOut");
    } catch (err) {
      dumpSnapshot("submit", container, onOpenChange);
      throw err;
    }
  });

  it("shows a wrong-password error and does not log out", async () => {
    deleteAccountMock.mockRejectedValue(new ApiError(401, { error: "invalid_password" }));
    const ui = await mount();
    await setInputValue(ui.password(), "nope");
    await setInputValue(ui.confirm(), "DELETE");
    await clickSubmit(ui);
    try {
      expect(ui.error()?.textContent).toBe("account.deletion.errors.invalidPassword");
      expect(logoutMock).not.toHaveBeenCalled();
      expect(ui.submit().disabled).toBe(false);
    } catch (err) {
      dumpSnapshot("wrong-password", container, onOpenChange);
      throw err;
    }
  });

  it("asks for the 2FA code when the API requires one, then resubmits with it", async () => {
    deleteAccountMock
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "email" }))
      .mockResolvedValueOnce({ status: "deletion_scheduled" });
    const ui = await mount();
    await setInputValue(ui.password(), "hunter22");
    await setInputValue(ui.confirm(), "DELETE");
    await clickSubmit(ui);
    console.info(`[account-delete-dialog:2fa] after first submit code field present=${Boolean(ui.code())}`);
    try {
      expect(ui.code()).not.toBeNull();
      expect(ui.error()?.textContent).toBe("account.deletion.errors.twoFactorRequired");
      expect(ui.submit().disabled).toBe(true); // needs the code now
      expect(logoutMock).not.toHaveBeenCalled();

      await setInputValue(ui.code()!, "123456");
      expect(ui.submit().disabled).toBe(false);
      await clickSubmit(ui);

      expect(deleteAccountMock).toHaveBeenCalledTimes(2);
      expect(deleteAccountMock).toHaveBeenLastCalledWith("tok-1", {
        password: "hunter22",
        confirm: "DELETE",
        twoFactorCode: "123456",
      });
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(logoutMock).toHaveBeenCalledWith("signOut");
    } catch (err) {
      dumpSnapshot("2fa", container, onOpenChange);
      throw err;
    }
  });

  it("@req ACCT-AUTH-04[badger-desktop] an account without a password deletes with the emailed code alone", async () => {
    account.hasPassword = false;
    deleteAccountMock
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "email" }))
      .mockResolvedValueOnce({ status: "deletion_scheduled" });
    const ui = await mount();
    const hint = container?.querySelector('[data-testid="accountDeletePassword-no-password"]');
    console.info(`[account-delete-dialog:no-password] password field=${Boolean(ui.password())} hint=${hint?.textContent}`);
    try {
      expect(ui.password()).toBeNull();
      expect(hint?.textContent).toBe("account.security.noPasswordHint");
      await setInputValue(ui.confirm(), "DELETE");
      expect(ui.submit().disabled).toBe(false);
      await clickSubmit(ui);
      expect(deleteAccountMock).toHaveBeenLastCalledWith("tok-1", { password: "", confirm: "DELETE" });
      expect(ui.code()).not.toBeNull();

      await setInputValue(ui.code()!, "482913");
      await clickSubmit(ui);
      console.info(`[account-delete-dialog:no-password] calls=${JSON.stringify(deleteAccountMock.mock.calls)}`);
      expect(deleteAccountMock).toHaveBeenLastCalledWith("tok-1", { password: "", confirm: "DELETE", twoFactorCode: "482913" });
      expect(logoutMock).toHaveBeenCalledWith("signOut");
    } catch (err) {
      dumpSnapshot("no-password", container, onOpenChange);
      throw err;
    }
  });

  it("cancel closes the dialog without calling the API", async () => {
    const ui = await mount();
    const cancel = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("account.deletion.cancel"),
    );
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    try {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(deleteAccountMock).not.toHaveBeenCalled();
      expect(ui.submit()).not.toBeNull();
    } catch (err) {
      dumpSnapshot("cancel", container, onOpenChange);
      throw err;
    }
  });
  // ACCT-DEL-03: a paid yearly plan past its guarantee chooses end of the paid year (default) or now.
  it("@req ACCT-DEL-03 offers no choice when deleting is immediate", async () => {
    await mount();
    const modes = container?.querySelector('[data-testid="account-delete-mode"]');
    console.info(`[account-delete-dialog:no-choice] mode fieldset present=${Boolean(modes)}`);
    try {
      expect(modes).toBeNull();
    } catch (err) {
      dumpSnapshot("no-choice", container, onOpenChange);
      throw err;
    }
  });

  it("@req ACCT-DEL-03 books the deletion for the end of the paid year by default and keeps the user signed in", async () => {
    const onScheduled = vi.fn();
    deleteAccountMock.mockResolvedValue({ status: "deletion_scheduled_for_period_end", deleteAt: "2027-03-01T00:00:00.000Z" });
    const ui = await mount({ periodEndDeleteAt: "2027-03-01T00:00:00.000Z", onScheduled });
    const end = container?.querySelector<HTMLInputElement>('[data-testid="account-delete-mode-end"]');
    console.info(`[account-delete-dialog:book] end checked=${end?.checked}`);
    await setInputValue(ui.password(), "hunter22");
    await setInputValue(ui.confirm(), "DELETE");
    await clickSubmit(ui);
    try {
      expect(end?.checked).toBe(true);
      expect(deleteAccountMock).toHaveBeenCalledWith("tok-1", { password: "hunter22", confirm: "DELETE", mode: "end_of_period" });
      expect(onScheduled).toHaveBeenCalledWith("2027-03-01T00:00:00.000Z");
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(logoutMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpSnapshot("book", container, onOpenChange);
      throw err;
    }
  });

  it("@req ACCT-DEL-03 deletes at once and signs out when the user picks now", async () => {
    const onScheduled = vi.fn();
    deleteAccountMock.mockResolvedValue({ status: "deletion_scheduled" });
    const ui = await mount({ periodEndDeleteAt: "2027-03-01T00:00:00.000Z", onScheduled });
    const now = container?.querySelector<HTMLInputElement>('[data-testid="account-delete-mode-now"]');
    await act(async () => {
      now?.click();
      await Promise.resolve();
    });
    console.info(`[account-delete-dialog:now] now checked=${now?.checked}`);
    await setInputValue(ui.password(), "hunter22");
    await setInputValue(ui.confirm(), "DELETE");
    await clickSubmit(ui);
    try {
      expect(deleteAccountMock).toHaveBeenCalledWith("tok-1", { password: "hunter22", confirm: "DELETE", mode: "now" });
      expect(onScheduled).not.toHaveBeenCalled();
      expect(logoutMock).toHaveBeenCalledWith("signOut");
    } catch (err) {
      dumpSnapshot("now", container, onOpenChange);
      throw err;
    }
  });

  it("@req ACCT-DEL-03 the intro says the booked deletion can be undone, and permanent only for now", async () => {
    await mount({ periodEndDeleteAt: "2027-03-01T00:00:00.000Z" });
    const keys = () =>
      ["bookedTitle", "bookedDescription", "confirmTitle", "confirmDescription"].filter((k) =>
        (container?.textContent ?? "").includes(`account.deletion.${k}`),
      );
    const booked = keys();
    const now = container?.querySelector<HTMLInputElement>('[data-testid="account-delete-mode-now"]');
    await act(async () => {
      now?.click();
      await Promise.resolve();
    });
    const immediate = keys();
    console.info(`[account-delete-dialog:intro] booked=${JSON.stringify(booked)} now=${JSON.stringify(immediate)}`);
    try {
      expect(booked).toEqual(["bookedTitle", "bookedDescription"]);
      expect(immediate).toEqual(["confirmTitle", "confirmDescription"]);
    } catch (err) {
      dumpSnapshot("intro", container, onOpenChange);
      throw err;
    }
  });
});
