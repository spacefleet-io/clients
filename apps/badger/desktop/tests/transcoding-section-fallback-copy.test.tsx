// @vitest-environment jsdom
/**
 * #25 (Chris 2026-10-09, reworked 2026-10-13): Settings → Transcoding shows THIS computer's
 * "fallback 360p copy" value (device-local, not the account ladder), says it
 * applies to this computer only, and writes changes through the
 * device-settings bridge. The account quality chips offer neither 360p nor
 * 480p — the device value alone decides the fallback copy.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import TranscodingSection from "../src/renderer/src/components/settings/sections/TranscodingSection";
import type { DeviceTranscodeSettings } from "../src/shared/transcodeDefault";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[transcoding-section-fallback-copy]";

if (typeof window.localStorage === "undefined" || typeof window.localStorage.setItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    writable: true,
  });
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@space/ui", () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  Select: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props}>{children}</select>,
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
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (next: boolean) => void }) => (
    <button type="button" data-checked={checked ? "true" : "false"} onClick={() => onCheckedChange?.(!checked)} />
  ),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const stored = (fallbackCopy: boolean): DeviceTranscodeSettings => ({
  fallbackCopy,
  answered: true,
  answer: "accepted",
  recommendation: { fallbackCopy, reason: "weak", hardware: null, detectedAt: "2026-10-09T00:00:00.000Z" },
  updatedAt: "2026-10-09T00:00:00.000Z",
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const dump = (label: string) => {
  console.error(`=== ${P}:${label} ===\n${container?.innerHTML ?? "(no container)"}\n=== end ===`);
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  window.localStorage.clear();
});

describe("TranscodingSection — this computer's fallback 360p copy", () => {
  it("shows the device value, says it is this computer only, and saves changes", async () => {
    const setFallbackCopy = vi.fn(async (value: boolean) => {
      console.info(`${P}:bridge setFallbackCopy(${value})`);
      return { ...stored(value), answer: "settings" as const };
    });
    Object.assign(window, {
      sf: { deviceSettings: { getTranscode: vi.fn(async () => stored(false)), answerFirstRun: vi.fn(), setFallbackCopy } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TranscodingSection />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    console.info(`${P}:text=${text}`);
    expect(text).toContain("settings.video.fallbackCopy.title");
    expect(text).toContain("settings.video.fallbackCopy.subtitle");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="settings-fallback-copy-switch"]');
    if (!toggle) dump("no-switch");
    expect(toggle?.getAttribute("data-checked")).toBe("false");

    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    console.info(`${P}:after click calls=${JSON.stringify(setFallbackCopy.mock.calls)}`);
    expect(setFallbackCopy).toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-testid="settings-fallback-copy-switch"]')?.getAttribute("data-checked")).toBe("true");
  });

  it("the account quality chips offer neither 360p nor 480p: the device value alone decides the fallback copy", async () => {
    Object.assign(window, { sf: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TranscodingSection />);
    });
    const chips = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    console.info(`${P}:chips=${JSON.stringify(chips)}`);
    expect(chips).toContain("720p");
    expect(chips).not.toContain("360p");
    expect(chips).not.toContain("480p");
  });
});
