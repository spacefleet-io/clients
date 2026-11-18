// @vitest-environment jsdom
/**
 * #25 (Chris 2026-10-13): Settings → Transcoding lets the user change what
 * uploads do while a video plays (full speed / slow down / pause) on THIS
 * computer. It shows the stored value, explains the chosen value in plain words,
 * and writes changes through the device-settings bridge (main sends them to the
 * runtime at once, even during playback).
 *
 * @bugfix @regression-proof
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import TranscodingSection from "../src/renderer/src/components/settings/sections/TranscodingSection";
import type { DeviceUploadsDuringPlaybackSettings, UploadsDuringPlayback } from "../src/shared/uploadPlaybackDefault";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[transcoding-section-uploads-playback]";

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
  Switch: ({ checked }: { checked?: boolean }) => <button type="button" data-checked={checked ? "true" : "false"} />,
  Checkbox: ({ checked }: { checked?: boolean }) => <button type="button" data-checked={checked ? "true" : "false"} />,
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const stored = (mode: UploadsDuringPlayback): DeviceUploadsDuringPlaybackSettings => ({
  mode,
  answered: true,
  answer: "accepted",
  recommendation: { mode, reason: "modest", hardware: null, detectedAt: "2026-10-13T00:00:00.000Z" },
  updatedAt: "2026-10-13T00:00:00.000Z",
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const dump = (label: string) => {
  console.error(`=== ${P}:${label} ===\n${container?.innerHTML ?? "(no container)"}\n=== end ===`);
};

const render = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TranscodingSection />);
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
  window.localStorage.clear();
});

describe("TranscodingSection — uploads while a video plays", () => {
  it("shows the stored value with a plain explanation, says it is this computer only, and saves a change", async () => {
    const setUploadsDuringPlayback = vi.fn(async (mode: UploadsDuringPlayback) => {
      console.info(`${P}:bridge setUploadsDuringPlayback(${mode})`);
      return { ...stored(mode), answer: "settings" as const };
    });
    Object.assign(window, {
      sf: {
        deviceSettings: {
          getTranscode: vi.fn(async () => ({
            fallbackCopy: false,
            answered: true,
            answer: "accepted",
            recommendation: { fallbackCopy: false, reason: "weak", hardware: null, detectedAt: "x" },
            updatedAt: "x",
          })),
          answerFirstRun: vi.fn(),
          setFallbackCopy: vi.fn(),
          getUploadsDuringPlayback: vi.fn(async () => stored("throttle")),
          answerUploadsFirstRun: vi.fn(),
          setUploadsDuringPlayback,
        },
      },
    });
    await render();
    const text = container?.textContent ?? "";
    console.info(`${P}:text=${text}`);
    expect(text).toContain("settings.video.uploadsDuringPlayback.title");
    expect(text).toContain("settings.video.uploadsDuringPlayback.subtitle");
    expect(text).toContain("settings.video.uploadsDuringPlayback.hint.throttle");

    const select = container?.querySelector<HTMLSelectElement>('[data-testid="settings-uploads-playback-select"]');
    if (!select) dump("no-select");
    expect(select?.value).toBe("throttle");
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(["full", "throttle", "pause"]);

    await act(async () => {
      select!.value = "pause";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    console.info(`${P}:after change calls=${JSON.stringify(setUploadsDuringPlayback.mock.calls)}`);
    expect(setUploadsDuringPlayback).toHaveBeenCalledWith("pause");
    expect(container?.querySelector<HTMLSelectElement>('[data-testid="settings-uploads-playback-select"]')?.value).toBe("pause");
    expect(container?.textContent).toContain("settings.video.uploadsDuringPlayback.hint.pause");
  });

  it("is hidden when there is no device-settings bridge for it (web build)", async () => {
    Object.assign(window, { sf: {} });
    await render();
    expect(container?.querySelector('[data-testid="settings-uploads-playback-select"]')).toBeNull();
  });

  it("puts the old value back when saving fails", async () => {
    Object.assign(window, {
      sf: {
        deviceSettings: {
          getTranscode: vi.fn(async () => {
            throw new Error("not needed");
          }),
          getUploadsDuringPlayback: vi.fn(async () => stored("full")),
          setUploadsDuringPlayback: vi.fn(async () => {
            throw new Error("disk full");
          }),
        },
      },
    });
    await render();
    const select = container!.querySelector<HTMLSelectElement>('[data-testid="settings-uploads-playback-select"]')!;
    await act(async () => {
      select.value = "pause";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container!.querySelector<HTMLSelectElement>('[data-testid="settings-uploads-playback-select"]')?.value).toBe("full");
  });
});
