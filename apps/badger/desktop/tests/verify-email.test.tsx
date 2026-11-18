// @vitest-environment jsdom

import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const verifyEmailMock = vi.hoisted(() => vi.fn());
const resendVerificationMock = vi.hoisted(() => vi.fn());
const setSessionMock = vi.hoisted(() => vi.fn());
const ApiErrorMock = vi.hoisted(
  () =>
    class ApiError extends Error {
      payload: Record<string, unknown>;

      constructor(status: number, payload: Record<string, unknown>) {
        super(String(payload.error ?? status));
        this.payload = payload;
      }
    }
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../src/renderer/src/api", () => ({
  verifyEmail: verifyEmailMock,
  resendVerification: resendVerificationMock,
  ApiError: ApiErrorMock,
}));

vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({
    setSession: setSessionMock,
  }),
}));

vi.mock("../src/renderer/src/components/PublicTopNav", () => ({
  default: () => <div data-testid="top-nav" />,
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  LanguageMenu: () => <div data-testid="language-menu" />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
}));

// On assertion failure, dump enough renderer + mock state to diagnose offline
// (per "Tests log generously": tests must self-diagnose, never recommend manual
// repro). Body wrapped in try/catch so a dump failure can't mask the real assertion.
const dumpVerifyEmailSnapshot = (label: string, container: HTMLDivElement | null) => {
  try {
    console.error(`=== [verify-email:${label}] snapshot ===`);
    const inputs = Array.from(container?.querySelectorAll("input") ?? []);
    console.error(
      `inputs(${inputs.length})=${JSON.stringify(inputs.map((i) => ({ name: i.name, value: i.value })))}`,
    );
    console.error(`container.textContent=${JSON.stringify(container?.textContent ?? null)}`);
    console.error(
      `verifyEmail.calls=${JSON.stringify(verifyEmailMock.mock.calls)} setSession.calls=${setSessionMock.mock.calls.length}`,
    );
    console.error(`resendVerification.calls=${JSON.stringify(resendVerificationMock.mock.calls)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("VerifyEmailPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
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
    verifyEmailMock.mockReset();
    resendVerificationMock.mockReset();
    setSessionMock.mockReset();
  });

  const renderPage = async (route = "/verify?email=user@example.com") => {
    console.info(`[verify-email:render] mounting VerifyEmailPage at route=${route}`);
    const { default: VerifyEmailPage } = await import("../src/renderer/src/pages/VerifyEmail");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <StrictMode>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path="/verify" element={<VerifyEmailPage />} />
              <Route path="/onboarding/key" element={<div>onboarding</div>} />
            </Routes>
          </MemoryRouter>
        </StrictMode>
      );
      await Promise.resolve();
    });
    console.info(`[verify-email:render] mounted, inputs=${container?.querySelectorAll("input").length ?? 0}`);
  };

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("[@bugfix][@regression-proof] verifies an email with a code and opens onboarding", async () => {
    verifyEmailMock.mockResolvedValue({
      token: "session-token",
      user: { id: "user-1", email: "user@example.com" },
    });

    await renderPage();

    const inputs = container?.querySelectorAll("input") ?? [];
    const emailInput = inputs[0] as HTMLInputElement;
    const codeInput = inputs[1] as HTMLInputElement;
    const form = container?.querySelector("form");

    console.info(`[verify-email:verify-code] submitting code=123456 email=${emailInput.value}`);
    await act(async () => {
      setInputValue(codeInput, "123456");
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const startedAt = Date.now();
    await vi.waitFor(() => {
      const ok = verifyEmailMock.mock.calls.length > 0 && setSessionMock.mock.calls.length === 1;
      if (!ok) {
        console.info(
          `[verify-email:verify-code] waiting elapsed=${Date.now() - startedAt}ms verifyEmail.calls=${verifyEmailMock.mock.calls.length} setSession.calls=${setSessionMock.mock.calls.length}`,
        );
        dumpVerifyEmailSnapshot("verify-code-pending", container);
      }
      expect(verifyEmailMock).toHaveBeenCalledWith(emailInput.value, "123456");
      expect(setSessionMock).toHaveBeenCalledTimes(1);
    });
    console.info(`[verify-email:verify-code] verified, setSession invoked`);
  });

  it("[@bugfix][@regression-proof] shows an invalid-code error instead of trying a token flow", async () => {
    verifyEmailMock.mockRejectedValue(new ApiErrorMock(401, { error: "invalid_code" }));
    await renderPage();

    const codeInput = container?.querySelectorAll("input")[1] as HTMLInputElement;
    const form = container?.querySelector("form");

    console.info(`[verify-email:invalid-code] submitting bad code=000000 (mock rejects 401 invalid_code)`);
    await act(async () => {
      setInputValue(codeInput, "000000");
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const startedAt = Date.now();
    await vi.waitFor(() => {
      const shown = container?.textContent?.includes("verifyEmail.errors.invalidCode") ?? false;
      if (!shown) {
        console.info(
          `[verify-email:invalid-code] waiting elapsed=${Date.now() - startedAt}ms textContent=${JSON.stringify(container?.textContent ?? null)}`,
        );
        dumpVerifyEmailSnapshot("invalid-code-pending", container);
      }
      expect(container?.textContent).toContain("verifyEmail.errors.invalidCode");
    });
    console.info(`[verify-email:invalid-code] invalid-code error surfaced`);
  });

  it("resends verification for the entered email", async () => {
    resendVerificationMock.mockResolvedValue({ ok: true });
    await renderPage();

    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    const resendButton = buttons.find((button) => button.textContent?.includes("verifyEmail.resend"));
    console.info(
      `[verify-email:resend] buttons=${buttons.length} resendButton-found=${Boolean(resendButton)}`,
    );
    await act(async () => {
      resendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    if (resendVerificationMock.mock.calls.length !== 1) {
      dumpVerifyEmailSnapshot("resend-mismatch", container);
    }
    expect(resendVerificationMock).toHaveBeenCalledWith("user@example.com");
  });
});
