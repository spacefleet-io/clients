// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

// Node 25+ exposes a broken localStorage global when --localstorage-file is invalid.
if (typeof window !== "undefined" && (typeof window.localStorage === "undefined" || typeof window.localStorage.setItem !== "function")) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    writable: true,
  });
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../src/renderer/src/i18n", () => ({
  default: { changeLanguage: vi.fn(async () => undefined) },
  setUiLanguage: vi.fn(async () => undefined),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  Select: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select {...props}>{children}</select>
  ),
  Switch: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (next: boolean) => void }) => (
    <button type="button" data-checked={checked ? "true" : "false"} onClick={() => onCheckedChange?.(!checked)} />
  ),
  Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (next: boolean) => void }) => (
    <button type="button" data-checked={checked ? "true" : "false"} onClick={() => onCheckedChange?.(!checked)} />
  ),
  StatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

/**
 * Post-refactor the single-scroll Settings page was decomposed into per-section
 * components hosted by a tabbed shell (components/settings/*). This test now
 * exercises the sections that own the asserted controls directly. The durable
 * @regression-proof intent is unchanged: certain unfinished / removed controls
 * (skip-mode, auto-transcode, auto-upload, watch-folders/-directories, the
 * legacy lookup-proxy + file-management panels) must NEVER surface in release
 * settings, while the shipping controls (quality, autoplay, intro/credits skip,
 * codec/transcode outputs, own-key, metadata tools) must be present.
 */
describe("Settings sections", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    window.localStorage.clear();
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

  it("[@bugfix][@regression-proof] surfaces shipping controls but hides unfinished automation + watched-folder controls across release settings sections", async () => {
    const [{ default: PlaybackSection }, { default: TranscodingSection }, { default: MetadataSection }] =
      await Promise.all([
        import("../src/renderer/src/components/settings/sections/PlaybackSection"),
        import("../src/renderer/src/components/settings/sections/TranscodingSection"),
        import("../src/renderer/src/components/settings/sections/MetadataSection"),
      ]);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (window as typeof window & { sf?: unknown }).sf = {};

    await act(async () => {
      root?.render(
        <>
          <PlaybackSection />
          <TranscodingSection />
          <MetadataSection />
        </>
      );
      await Promise.resolve();
    });

    const text = container?.textContent ?? "";

    // Shipping controls are present, now spread across their sections.
    expect(text).toContain("settings.playback.quality");
    expect(text).toContain("settings.playback.forceQuality.title");
    expect(text).toContain("settings.playback.autoplay.title");
    expect(text).toContain("settings.playback.autoplay.subtitle");
    expect(text).toContain("settings.playback.intro.title");
    expect(text).toContain("settings.playback.credits.title");
    expect(text).toContain("settings.video.outputsTitle");
    expect(text).toContain("settings.video.codecSelection");
    expect(text).toContain("settings.video.maxParallelTranscodes.title");
    expect(text).toContain("settings.advanced.metadataTools.title");

    // The autoplay-next-episode toggle defaults on (the original @bugfix anchor).
    const checkedToggle = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.getAttribute("data-checked") === "true"
    );
    expect(checkedToggle).toBeTruthy();

    // Regression guard: unfinished / removed controls must NOT appear anywhere.
    expect(text).not.toContain("settings.playback.skipMode");
    expect(text).not.toContain("settings.video.autoTranscode.title");
    expect(text).not.toContain("settings.video.autoUpload.title");
    expect(text).not.toContain("settings.advanced.watchDirectories.title");
    expect(text).not.toContain("settings.video.watchFolders.title");
    expect(text).not.toContain("settings.advanced.catalogProxy.title");
    // META-DIRECT-03: the own-key setting was removed.
    expect(text).not.toContain("settings.advanced.catalogOwnKey.title");
    expect(text).not.toContain("settings.advanced.fileManagement.title");
  });

  it("@req PLAY-TRACK-01[badger-desktop] the Playback tab has a Default audio language row (Original first) that saves the picked language", async () => {
    const T = "[settings-page:default-audio]";
    const { default: PlaybackSection } = await import("../src/renderer/src/components/settings/sections/PlaybackSection");
    const { loadClientConfig } = await import("../src/renderer/src/lib/config");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlaybackSection />);
      await Promise.resolve();
    });
    const select = container.querySelector<HTMLSelectElement>("select#defaultAudioLanguage");
    const options = Array.from(select?.options ?? []).map((o) => [o.value, o.textContent]);
    console.info(`${T} phase=rendered value=${JSON.stringify(select?.value)} options=${JSON.stringify(options)}`);
    expect(container.textContent).toContain("settings.playback.audioLanguage.title");
    expect(select?.value, "defaults to Original").toBe("");
    expect(options[0]).toEqual(["", "settings.playback.audioLanguage.original"]);
    expect(options.map(([value]) => value)).toEqual(expect.arrayContaining(["en", "fr", "ja"]));

    await act(async () => {
      select!.value = "fr";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    console.info(`${T} phase=picked-fr stored=${JSON.stringify(loadClientConfig().defaultAudioLanguage)}`);
    expect(loadClientConfig().defaultAudioLanguage).toBe("fr");

    await act(async () => {
      select!.value = "";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    console.info(`${T} phase=picked-original stored=${JSON.stringify(loadClientConfig().defaultAudioLanguage)}`);
    expect(loadClientConfig().defaultAudioLanguage).toBeNull();
  });
});
