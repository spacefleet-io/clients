// @vitest-environment jsdom
/**
 * @req ACCT-PAIR-07
 * The "Continue with your Badger account" card on a computer's sign-in screen (and its Parrot twin): the offer with the
 * sister app's real icon, the waiting state with Cancel, the one-line failure, and "Use another account".
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientUiLanguage } from "@space/shared/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SameDeviceSignIn } from "../src/components/same-device-sign-in-card";
import { sameDeviceSignInStrings } from "../src/components/same-device-sign-in-strings";
import type { SiblingSignInActions, SiblingSignInResult } from "../src/sibling/types";

const SUITE = "[same-device-sign-in-card.test]";
const log = (message: string, extra?: unknown) => console.info(SUITE, message, extra ?? "");

const approved = { status: "approved" as const, token: "parrot-token", user: { id: "user-1", email: "ada@example.test" }, libraryKey: "key" };

describe("SameDeviceSignIn", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = async (props: Partial<React.ComponentProps<typeof SameDeviceSignIn>> & { actions: SiblingSignInActions }) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SameDeviceSignIn
          language="en"
          app="parrot"
          onApproved={vi.fn(async () => "verified" as const)}
          onHide={vi.fn()}
          {...props}
        />,
      );
    });
  };
  const text = () => container.textContent ?? "";
  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: HTMLElement | null) => {
    expect(el).not.toBeNull();
    await act(async () => {
      el!.click();
    });
  };
  const actionsWith = (signIn: () => Promise<SiblingSignInResult>): SiblingSignInActions => ({
    offer: vi.fn(async () => ({ app: "badger" as const, email: "ada@example.test" })),
    signIn: vi.fn(signIn),
    cancel: vi.fn(async () => undefined),
  });

  it.each(["en", "fr", "de", "es", "nl"] as ClientUiLanguage[])("offers the sister app's account with its real icon (%s)", async (language) => {
    const actions = actionsWith(async () => approved);
    await mount({ actions, language });
    log("offer", { language, text: text() });
    const strings = sameDeviceSignInStrings[language];
    expect(text()).toContain(strings.title.replace("{Other}", "Badger"));
    expect(text()).toContain(strings.body.replace("{Other}", "Badger"));
    expect(text()).toContain("ada@example.test");
    expect(text()).toContain(strings.link);
    const icon = byTestId("same-device-sign-in-icon") as HTMLImageElement;
    expect(icon.tagName).toBe("IMG");
    expect(icon.getAttribute("src")).toMatch(/badger-app-icon/);
    // One line: the email truncates, the words before it never wrap.
    const email = byTestId("same-device-sign-in-email");
    expect(email?.className).toContain("truncate");
    expect(byTestId("same-device-sign-in-continue")?.className).toContain("whitespace-nowrap");
    // The card and its button may shrink below the email's width (`min-w-0`), so a long email truncates instead of
    // widening Badger's sign-in grid past its panel (2026-11-23). The geometry itself is checked in the desktop e2e.
    expect(byTestId("same-device-sign-in-card")?.className).toContain("min-w-0");
    expect(byTestId("same-device-sign-in-continue")?.className).toContain("min-w-0");
  });

  it("shows nothing while the sister app is not signed in", async () => {
    const actions = actionsWith(async () => approved);
    actions.offer = vi.fn(async () => null);
    await mount({ actions });
    log("no offer", { html: container.innerHTML });
    expect(container.innerHTML).toBe("");
  });

  it("signs in with one click, waits, then hands the approval over", async () => {
    const answer = Promise.withResolvers<SiblingSignInResult>();
    const actions = actionsWith(() => answer.promise);
    const onApproved = vi.fn(async () => "verified" as const);
    await mount({ actions, onApproved });
    await click(byTestId("same-device-sign-in-continue"));
    log("waiting", { text: text() });
    expect(text()).toContain("Signing in with Badger…");
    expect(text()).toContain("Cancel");
    await act(async () => answer.resolve(approved));
    expect(onApproved).toHaveBeenCalledWith(approved);
  });

  it("Cancel stops the sign-in and goes back to the offer", async () => {
    const answer = Promise.withResolvers<SiblingSignInResult>();
    const actions = actionsWith(() => answer.promise);
    await mount({ actions, language: "fr" });
    await click(byTestId("same-device-sign-in-continue"));
    expect(text()).toContain("Connexion avec Badger…");
    await click(byTestId("same-device-sign-in-cancel"));
    expect(actions.cancel).toHaveBeenCalled();
    await act(async () => answer.resolve({ status: "cancelled" }));
    log("after cancel", { text: text() });
    expect(text()).toContain("Continuer avec votre compte Badger");
  });

  it.each([
    ["the sister app fails", async () => ({ status: "failed" }) as SiblingSignInResult, "verified"],
    ["the key does not match", async () => approved, "mismatch"],
  ] as const)("shows the one-line failure when %s", async (_label, signIn, check) => {
    const actions = actionsWith(signIn);
    await mount({ actions, onApproved: vi.fn(async () => check) });
    await click(byTestId("same-device-sign-in-continue"));
    log("failure", { text: text() });
    expect(text()).toBe("Badger could not sign you in. Sign in another way.");
    expect(byTestId("same-device-sign-in-continue")).toBeNull();
  });

  it("Use another account hides the offer", async () => {
    const actions = actionsWith(async () => approved);
    const onHide = vi.fn();
    await mount({ actions, onHide });
    await click(byTestId("same-device-sign-in-other-account"));
    log("hidden", { html: container.innerHTML });
    expect(onHide).toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
