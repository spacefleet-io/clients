// @vitest-environment jsdom
/**
 * REL-LOG-06: Settings → System has a "Send error reports" switch for this computer. It is disabled while
 * the answer loads, shows what main stored, saves a change through the preload bridge and starts or stops
 * this window's reporting at once. Without a bridge (web build) the row is not shown.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemSection from "../src/renderer/src/components/settings/sections/SystemSection";
import type { ErrorReportsState } from "@space/error-report/desktop";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[error-reports-settings-switch]";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "de-DE" } }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  StatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={rest["data-testid"]}
      disabled={disabled}
      data-checked={checked ? "true" : "false"}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
vi.mock("@space/desktop-shell/services/runtime-status", () => ({
  useRuntimeStatus: () => ({ status: "ready", restart: vi.fn(), restarting: false }),
}));

const adapter = vi.hoisted(() => ({ setEnabled: vi.fn(async (_enabled: boolean) => undefined), create: vi.fn() }));
vi.mock("@space/error-report/electron-renderer", () => ({
  createElectronRendererReporting: ({ release }: { release: string }) => {
    adapter.create(release);
    return { setEnabled: adapter.setEnabled, isEnabled: () => false };
  },
}));

const SWITCH = '[data-testid="settings-error-reports-switch"]';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SystemSection />);
  });
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "sf");
});

describe("@req REL-LOG-06[badger-desktop] Settings → System error reports switch", () => {
  it("shows the stored answer, says what is sent, saves a change and starts reporting live", async () => {
    const stored = (decision: ErrorReportsState["decision"]): ErrorReportsState => ({ decision, available: true, release: "9.9.9" });
    const set = vi.fn(async (decision: "on" | "off") => {
      console.info(`${P}:bridge set(${decision})`);
      return stored(decision);
    });
    Object.assign(window, { sf: { errorReports: { get: vi.fn(async () => stored("undecided")), set } } });
    await mount();

    const text = container!.textContent ?? "";
    console.info(`${P}:text=${text}`);
    expect(text).toContain("settings.system.errorReports.title");
    expect(text).toContain("settings.system.errorReports.subtitle");
    // The one line is followed by the "What's in a report?" link to the privacy policy's error-reports part.
    const link = container!.querySelector<HTMLAnchorElement>('[data-testid="settings-error-reports-link"]');
    console.info(`${P}:link href=${link?.getAttribute("href")} text=${link?.textContent}`);
    expect(link?.textContent).toBe("settings.system.errorReports.link");
    expect(link?.getAttribute("href")).toBe("https://spacefleet.io/de/privacy#error-reports");
    expect(link?.getAttribute("target")).toBe("_blank");

    const toggle = () => container!.querySelector<HTMLButtonElement>(SWITCH);
    expect(toggle()).not.toBeNull();
    // An unanswered question reads as off, and nothing was loaded or started.
    expect(toggle()!.getAttribute("data-checked")).toBe("false");
    expect(toggle()!.disabled).toBe(false);
    expect(adapter.create).not.toHaveBeenCalled();

    await act(async () => {
      toggle()!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    console.info(`${P}:after on calls=${JSON.stringify(set.mock.calls)} adapter=${adapter.create.mock.calls.length}`);
    expect(set).toHaveBeenLastCalledWith("on");
    expect(toggle()!.getAttribute("data-checked")).toBe("true");
    expect(adapter.create).toHaveBeenCalledWith("9.9.9");
    expect(adapter.setEnabled).toHaveBeenLastCalledWith(true);

    await act(async () => {
      toggle()!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(set).toHaveBeenLastCalledWith("off");
    expect(toggle()!.getAttribute("data-checked")).toBe("false");
    expect(adapter.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("is disabled while the answer loads and shows 'on' when main stored it", async () => {
    let release: (state: ErrorReportsState) => void = () => undefined;
    const get = vi.fn(() => new Promise<ErrorReportsState>((resolve) => (release = resolve)));
    Object.assign(window, { sf: { errorReports: { get, set: vi.fn() } } });
    await mount();
    expect(container!.querySelector<HTMLButtonElement>(SWITCH)!.disabled).toBe(true);
    await act(async () => {
      release({ decision: "on", available: false, release: "9.9.9" });
    });
    const toggle = container!.querySelector<HTMLButtonElement>(SWITCH)!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("data-checked")).toBe("true");
    // This build has no reporting address: the answer shows, nothing was loaded.
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("goes back to the stored value when saving fails", async () => {
    const set = vi.fn(async () => {
      throw new Error("disk full");
    });
    Object.assign(window, { sf: { errorReports: { get: vi.fn(async () => ({ decision: "off", available: true, release: "9.9.9" })), set } } });
    await mount();
    await act(async () => {
      container!.querySelector<HTMLButtonElement>(SWITCH)!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledWith("on");
    expect(container!.querySelector<HTMLButtonElement>(SWITCH)!.getAttribute("data-checked")).toBe("false");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("has no row without the bridge (web build)", async () => {
    Object.assign(window, { sf: {} });
    await mount();
    expect(container!.querySelector(SWITCH)).toBeNull();
  });
});
