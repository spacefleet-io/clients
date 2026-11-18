// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-LIBRARY-KEY-STEP-001
 * @level unit
 * @req UX-KEY-01[badger-desktop,parrot]
 * @req PRIV-KEY-01[badger-desktop,parrot]
 * @why Badger and Parrot desktop show the same key step (Chris 2026-11-12: "the setup step to enter/save the key
 *   should be the same shared one between the 2 apps"). The erase is the last resort: it says the whole account's
 *   library goes, for every profile and both apps, points to any signed-in app first, and runs only once the confirm
 *   word and the password are typed. A refused erase maps to the same outcome in both apps.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/components/pair-with-phone", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: (props: { mode?: string; onBack: () => void }) => (
    <div data-testid="pair-with-phone" data-mode={props.mode}>
      <button data-testid="pair-back" onClick={props.onBack}>
        back
      </button>
    </div>
  ),
}));

import { LibraryKeyStep } from "../src/components/library-key-step";
import { libraryKeyEraseOutcomeOf, type LibraryKeyEraseOutcome } from "../src/libraryKeyErase";

const SUITE = "[DESKTOP-SHELL-LIBRARY-KEY-STEP-001]";
let container: HTMLDivElement;
let root: Root;
const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const setValue = async (field: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const flush = async () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });

const onErase = vi.fn(async (_password: string, _code?: string): Promise<LibraryKeyEraseOutcome> => ({ status: "erased" }));

const mount = async (hasPassword?: boolean) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <LibraryKeyStep
        mode="enter"
        language="en"
        app="parrot"
        onSubmitKey={async () => undefined}
        pairing={{ actions: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() } as never, onApproved: async () => "verified" as never }}
        onErase={onErase}
        hasPassword={hasPassword}
      />,
    );
  });
  await flush();
};

beforeEach(() => onErase.mockClear());
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("@req UX-KEY-01 the shared desktop key step", () => {
  it("starts with 12 empty boxes and Continue off", async () => {
    await mount();
    const boxes = container.querySelectorAll('[data-testid="library-key-box-input"]');
    console.info(`${SUITE} boxes=${boxes.length} continue=${(q("library-key-continue") as HTMLButtonElement).disabled}`);
    expect(boxes).toHaveLength(12);
    expect((q("library-key-continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("erases only once ERASE and the password are typed, and asks for the code when two-factor is on", async () => {
    onErase.mockResolvedValueOnce({ status: "codeNeeded", method: "email" });
    await mount();
    await act(async () => q("key-lost-start-new-library")!.click());
    await flush();
    const warning = q("reset-warning")?.textContent ?? "";
    console.info(`${SUITE} warning=${JSON.stringify(warning)}`);
    expect(warning).toContain("for every profile");
    expect(warning).toContain("music, movies and shows");
    expect(warning).toContain("in Badger and Parrot");
    expect(q("reset-other-device")?.textContent).toContain("even on another profile of this account");
    const submit = q("reset-submit") as HTMLButtonElement;
    await setValue(q("reset-password") as HTMLInputElement, "pw");
    expect(submit.disabled).toBe(true);
    await setValue(q("reset-confirm-word") as HTMLInputElement, "erase");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flush();
    expect(onErase).toHaveBeenCalledWith("pw", undefined);
    expect(q("reset-code")).not.toBeNull();
  });

  it("sends the user to another device from the erase dialog, before any erase", async () => {
    await mount();
    await act(async () => q("key-lost-start-new-library")!.click());
    await flush();
    await act(async () => (q("reset-other-device-link") as HTMLButtonElement).click());
    await flush();
    console.info(`${SUITE} pairing=${q("pair-with-phone")?.dataset.mode ?? "none"} dialog=${q("reset-submit") !== null}`);
    expect(q("pair-with-phone")?.dataset.mode).toBe("key");
    expect(q("reset-submit")).toBeNull();
    expect(onErase).not.toHaveBeenCalled();
  });

  it("@req ACCT-AUTH-04[badger-desktop] an account without a password erases with the code alone", async () => {
    onErase.mockResolvedValueOnce({ status: "codeNeeded", method: "email" });
    await mount(false);
    await act(async () => q("key-lost-start-new-library")!.click());
    await flush();
    console.info(`${SUITE} no-password hint=${JSON.stringify(q("reset-no-password")?.textContent)} field=${q("reset-password") !== null}`);
    expect(q("reset-password")).toBeNull();
    expect(q("reset-no-password")?.textContent).toContain("no password");
    const submit = q("reset-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await setValue(q("reset-confirm-word") as HTMLInputElement, "erase");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flush();
    expect(onErase).toHaveBeenLastCalledWith("", undefined);
    await setValue(q("reset-code") as HTMLInputElement, "482913");
    await act(async () => submit.click());
    await flush();
    console.info(`${SUITE} no-password calls=${JSON.stringify(onErase.mock.calls)}`);
    expect(onErase).toHaveBeenLastCalledWith("", "482913");
  });
});

describe("@req PRIV-KEY-01[badger-desktop,parrot] libraryKeyEraseOutcomeOf", () => {
  it.each([
    [new ApiError(401, { error: "invalid_password" }), { status: "failed", reason: "invalidPassword" }],
    [new ApiError(401, { error: "two_factor_required", method: "totp" } as never), { status: "codeNeeded", method: "totp" }],
    [new ApiError(401, { error: "two_factor_required" }), { status: "codeNeeded", method: "email" }],
    [new ApiError(401, { error: "two_factor_invalid" }), { status: "failed", reason: "invalidCode" }],
    [new ApiError(429, { error: "rate_limited", retryAfterSeconds: 90 } as never), { status: "failed", reason: "tooManyAttempts", minutes: 2 }],
    [new ApiError(503, { error: "unavailable" }), { status: "failed", reason: "other" }],
    [new Error("offline"), { status: "failed", reason: "other" }],
  ])("maps %s", (err, outcome) => {
    expect(libraryKeyEraseOutcomeOf(err)).toEqual(outcome);
  });
});
