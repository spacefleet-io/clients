/**
 * @vitest-environment jsdom
 *
 * ACCT-AUTH-11: when the API refuses a pairing step for now (429 `rate_limited`, OPS-LIMIT-02), the "Approve a device"
 * dialog of Badger and Parrot desktop says "Too many attempts. Try again in N minutes." with the API's wait, in the
 * app's language, instead of a fixed "wait a minute".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovePairingResult, PairingRequestView } from "@space/pairing-crypto";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => {
  const Plain = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
      <button {...props}>{children}</button>
    ),
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: Plain,
    DialogDescription: Plain,
    DialogFooter: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  };
});

import { PairDeviceDialog, type PairDeviceActions } from "../src/components/pair-device-dialog";

const TEST = "[pair-dialog-429]";

describe("PairDeviceDialog on a 429", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const submitCode = async (code: string) => {
    const input = container.querySelector<HTMLInputElement>('[data-testid="pair-approve-code"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('[data-testid="pair-approve-code-step"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  const actionsRefusing = (refusal: ApprovePairingResult<PairingRequestView>): PairDeviceActions => ({
    lookup: vi.fn(async () => refusal),
    approve: vi.fn(async () => ({ ok: true as const, value: null })),
    deny: vi.fn(async () => ({ ok: true as const, value: null })),
  });

  it("@req ACCT-AUTH-11 says when to try again, from the API's retryAfterSeconds, in the app's language", async () => {
    const cases: Array<[PairDeviceActions, "en" | "fr" | "de", string]> = [
      [actionsRefusing({ ok: false, kind: "rate_limited", retryAfterSeconds: 130 }), "en", "Too many attempts. Try again in 3 minutes."],
      [actionsRefusing({ ok: false, kind: "rate_limited", retryAfterSeconds: 40 }), "fr", "Trop de tentatives. Réessayez dans 1 minute."],
      // A proxy's 429 without a body: the shared default wait.
      [actionsRefusing({ ok: false, kind: "rate_limited" }), "de", "Zu viele Versuche. Versuch es in 15 Minuten nochmal."],
    ];
    for (const [actions, language, expected] of cases) {
      console.info(TEST, "phase: mount", { language });
      await act(async () => {
        root.render(<PairDeviceDialog open onOpenChange={() => undefined} actions={actions} language={language} key={language} />);
      });
      await submitCode("ABCD-EFGH");
      const shown = container.querySelector('[data-testid="pair-approve-error"]')?.textContent;
      console.info(TEST, "phase: refused", { language, shown });
      expect(actions.lookup).toHaveBeenCalledWith("ABCD-EFGH");
      expect(shown).toBe(expected);
    }
  });

  it("@req ACCT-AUTH-11 other refusals keep their own sentence", async () => {
    const actions = actionsRefusing({ ok: false, kind: "not_found" });
    await act(async () => {
      root.render(<PairDeviceDialog open onOpenChange={() => undefined} actions={actions} language="en" />);
    });
    await submitCode("ABCD-EFGH");
    const shown = container.querySelector('[data-testid="pair-approve-error"]')?.textContent ?? "";
    console.info(TEST, "phase: not found", { shown });
    expect(shown).not.toContain("Too many attempts");
    expect(shown.length).toBeGreaterThan(0);
  });
});
