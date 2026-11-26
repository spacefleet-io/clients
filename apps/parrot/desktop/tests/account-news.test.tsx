// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-ACCOUNT-NEWS-001
 * @level integration (real Library shell, bell and history, real translators; `window.parrot` mocked, its
 *   `listAccountNotices` answering what `GET /account/notices` gives)
 * @why Chris, 2026-11-26, UX-NOTICE-05: news about the account (a device signed in, a payment, storage over its limit)
 *   reaches every app through the api and joins the bell's history, whichever device it happened on. Parrot desktop
 *   reads it through main, which holds the session, and leads its entries to Settings ▸ Account.
 * @covers apps/parrot/desktop/src/renderer/src/Library.tsx, apps/parrot/desktop/src/main/index.ts,
 *   packages/desktop-shell/src/hooks/useAccountNews.ts
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import type { ParrotLanguage, ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-ACCOUNT-NEWS-001]";
const stateIn = (language: ParrotLanguage): ParrotState => ({
  setup: { step: "errorReports", done: true, language, folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
});
const library = { snapshotVersion: 1, artists: [], albums: [], tracks: [] };
const news = {
  notices: [
    {
      id: "session:s-tv",
      key: "new-device-s-tv",
      level: "info",
      title: { key: "notify.account.newDevice" },
      message: { key: "notify.account.newDeviceMessage", vars: { name: "Salon", type: { key: "notify.account.deviceType.tv" } } },
      action: { label: { key: "notify.account.openDevices" }, target: "devices" },
      createdAt: "2026-11-26T10:00:00.000Z",
    },
  ],
};

describe("account news", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  // The tray sits in a portal, outside the container.
  const q = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (node: HTMLElement | undefined) => {
    if (!node) throw new Error("nothing to click");
    await act(async () => node.click());
    await flush();
  };
  const render = async (language: ParrotLanguage) => {
    await act(async () => root.render(<Library t={translator(language)} state={stateIn(language)} onState={() => undefined} />));
    await flush();
  };
  const entry = () => q("notice-entry-new-device-s-tv").map((node) => node.parentElement?.textContent ?? "");

  beforeEach(async () => {
    localStorage.clear();
    // This computer already read the account's news once, so what comes now is new to it.
    localStorage.setItem("parrot.notifications.u1", JSON.stringify({ entries: [], accountSyncedAt: 1 }));
    Object.defineProperty(window, "parrot", {
      configurable: true,
      value: {
        ...streamBridgeStub(),
        ...exportBridgeStub(),
        listAccountNotices: vi.fn(async () => ({ ok: true, value: news })),
        getLibrary: vi.fn(async () => ({ ok: true, library })),
        getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0, published: 0 })),
        getImportScan: vi.fn(async () => null),
        getLyrics: vi.fn(async () => null),
        onLyricsChanged: vi.fn(() => () => undefined),
        onLibraryChanged: vi.fn(() => () => undefined),
        onLibraryPatch: vi.fn(() => () => undefined),
        onImportStatus: vi.fn(() => () => undefined),
        getCoversWaiting: vi.fn(async () => []),
        onCoversWaiting: vi.fn(() => () => undefined),
        getImportJobs: vi.fn(async () => []),
        onImportJobs: vi.fn(() => () => undefined),
        dismissImportJob: vi.fn(async () => []),
        getBackgroundWork: vi.fn(async () => []),
        onBackgroundWork: vi.fn(() => () => undefined),
        getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
        onKept: vi.fn(() => () => undefined),
        playbackUrl: vi.fn(async () => "blob:none"),
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req UX-NOTICE-05[parrot]
  it("puts a device signed in elsewhere on the bell, in the language picked afterwards, and leads to Settings ▸ Account", async () => {
    await render("en");
    console.info(SUITE, "read", vi.mocked(window.parrot.listAccountNotices).mock.calls.length, "badge", q("nav-notifications-count")[0]?.textContent);
    expect(window.parrot.listAccountNotices).toHaveBeenCalled();
    expect(q("nav-notifications-count")[0]?.textContent).toBe("1");

    await click(q("nav-notifications")[0]);
    await click(q("notice-entry-new-device-s-tv")[0]);
    console.info(SUITE, "entry (en)", entry());
    expect(entry()[0]).toContain("New device added");
    expect(entry()[0]).toContain("Salon (TV)");

    await render("de");
    console.info(SUITE, "entry (de)", entry());
    expect(entry()[0]).toContain("Salon (Fernseher)");

    await render("en");
    const open = q("notice-entry-open-new-device-s-tv");
    console.info(SUITE, "open button", open.map((node) => node.textContent));
    expect(open[0]?.textContent).toBe("See devices");
    await click(open[0]);
    console.info(SUITE, "settings ▸ account", q("library-pair-device").length);
    expect(q("library-pair-device")).toHaveLength(1);
  });
});
