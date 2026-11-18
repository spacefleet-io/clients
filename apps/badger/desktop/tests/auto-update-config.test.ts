// @vitest-environment jsdom
/**
 * REL-UPD-01: the `autoUpdate` client setting defaults ON. Builds before REL-UPD-01 wrote the old default
 * (`autoUpdate: false`) with every settings save, so a stored `false` only counts once the user flipped the switch
 * themselves (`autoUpdateChosen`); `updateSetting("autoUpdate", …)` records that choice.
 *
 * Diagnostic logging: suite id `auto-update-config`, phase markers `[auto-update-config:<case>]`.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ setUiLanguage: vi.fn(async () => undefined) }));
vi.mock("@/lib/accountUiLanguage", () => ({ announceUiLanguagePick: vi.fn() }));

import { coerceClientConfig, defaultClientConfig, loadClientConfig } from "../src/renderer/src/lib/config";
import { useClientSettings } from "../src/renderer/src/lib/settings/useClientSettings";

const CONFIG_KEY = "sf_client_config_v1";

const dumpAutoUpdateSnapshot = (label: string, input: unknown, coerced: { autoUpdate?: unknown; autoUpdateChosen?: unknown } | null) => {
  console.error(
    `[auto-update-config:${label}:dump] ${JSON.stringify({
      input,
      coerced: { autoUpdate: coerced?.autoUpdate, autoUpdateChosen: coerced?.autoUpdateChosen },
      defaults: { autoUpdate: defaultClientConfig.autoUpdate, autoUpdateChosen: defaultClientConfig.autoUpdateChosen },
      stored: window.localStorage.getItem(CONFIG_KEY),
    })}`,
  );
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Badger has no @testing-library: a minimal renderHook over react-dom.
let mounted: Root[] = [];
const renderHook = <T>(hook: () => T): { result: { current: T } } => {
  const result = { current: undefined as T };
  const Probe = () => {
    result.current = hook();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  act(() => root.render(React.createElement(Probe)));
  return { result };
};

afterEach(() => {
  act(() => mounted.forEach((root) => root.unmount()));
  mounted = [];
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("autoUpdate config (REL-UPD-01)", () => {
  // @req REL-UPD-01
  it("defaults to true, not yet chosen", () => {
    console.info("[auto-update-config:default] checking defaultClientConfig");
    if (defaultClientConfig.autoUpdate !== true) dumpAutoUpdateSnapshot("default", "(none)", defaultClientConfig);
    expect(defaultClientConfig.autoUpdate).toBe(true);
    expect(defaultClientConfig.autoUpdateChosen).toBe(false);
  });

  // @req REL-UPD-01
  it.each<[string, unknown, boolean, boolean]>([
    ["no stored value (null)", null, true, false],
    ["no stored value (undefined)", undefined, true, false],
    ["config without the key", { playbackQuality: "1080p" }, true, false],
    ["stored true", { autoUpdate: true }, true, false],
    // The old off-by-default value every pre-REL-UPD-01 save wrote: old installs flip ON.
    ["stored false without autoUpdateChosen", { autoUpdate: false }, true, false],
    ["stored false, autoUpdateChosen not strictly true", { autoUpdate: false, autoUpdateChosen: "yes" }, true, false],
    ["stored false chosen by the user", { autoUpdate: false, autoUpdateChosen: true }, false, true],
    ["stored true chosen by the user", { autoUpdate: true, autoUpdateChosen: true }, true, true],
    ["chosen with the value missing", { autoUpdateChosen: true }, true, true],
  ])("coerceClientConfig: %s", (label, input, autoUpdate, autoUpdateChosen) => {
    console.info(`[auto-update-config:coerce] ${label} input=${JSON.stringify(input)}`);
    const coerced = coerceClientConfig(input);
    if (coerced.autoUpdate !== autoUpdate || coerced.autoUpdateChosen !== autoUpdateChosen) dumpAutoUpdateSnapshot(label, input, coerced);
    expect(coerced.autoUpdate).toBe(autoUpdate);
    expect(coerced.autoUpdateChosen).toBe(autoUpdateChosen);
  });

  // @req REL-UPD-01
  it("loadClientConfig: an old install's stored {autoUpdate:false} loads ON; a chosen false stays OFF", () => {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ autoUpdate: false }));
    const oldInstall = loadClientConfig();
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ autoUpdate: false, autoUpdateChosen: true }));
    const chosen = loadClientConfig();
    console.info(`[auto-update-config:load] oldInstall=${oldInstall.autoUpdate} chosen=${chosen.autoUpdate}`);
    expect(oldInstall.autoUpdate).toBe(true);
    expect(chosen.autoUpdate).toBe(false);
  });

  // @req REL-UPD-01
  it("updateSetting('autoUpdate', false) saves autoUpdateChosen:true, survives a reload, and tells the main process", () => {
    const setAutoUpdate = vi.fn(async (_enabled: boolean) => ({ ok: true }));
    vi.stubGlobal("spaceBadger", { updater: { setAutoUpdate } });
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ autoUpdate: false }));
    const { result } = renderHook(() => useClientSettings());
    const before = result.current.config.autoUpdate;
    act(() => result.current.updateSetting("autoUpdate", false));
    const stored = JSON.parse(window.localStorage.getItem(CONFIG_KEY) ?? "null") as Record<string, unknown> | null;
    const reloaded = loadClientConfig();
    console.info(
      `[auto-update-config:update-setting] before=${before} stored=${JSON.stringify({ autoUpdate: stored?.autoUpdate, autoUpdateChosen: stored?.autoUpdateChosen })} reloaded=${reloaded.autoUpdate} bridge=${JSON.stringify(setAutoUpdate.mock.calls)}`,
    );
    try {
      expect(before).toBe(true);
      expect(result.current.config).toMatchObject({ autoUpdate: false, autoUpdateChosen: true });
      expect(stored).toMatchObject({ autoUpdate: false, autoUpdateChosen: true });
      expect(reloaded.autoUpdate).toBe(false);
      expect(setAutoUpdate.mock.calls).toEqual([[false]]);
    } catch (err) {
      dumpAutoUpdateSnapshot("update-setting", stored, result.current.config);
      throw err;
    }
  });

  it("updateSetting on another key does not mark autoUpdate as chosen", () => {
    const { result } = renderHook(() => useClientSettings());
    act(() => result.current.updateSetting("autoplayNextEpisode", false));
    const stored = JSON.parse(window.localStorage.getItem(CONFIG_KEY) ?? "null") as Record<string, unknown> | null;
    console.info(`[auto-update-config:other-key] stored=${JSON.stringify(stored)}`);
    expect(stored?.autoUpdateChosen).toBe(false);
    expect(loadClientConfig().autoUpdate).toBe(true);
  });
});
