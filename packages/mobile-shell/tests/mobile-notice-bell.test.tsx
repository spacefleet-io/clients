/**
 * @test-id MOBILE-SHELL-NOTICE-HISTORY-001
 * @level unit
 * @req UX-NOTICE-04[badger-mobile]
 * @req UX-NOTICE-11[badger-mobile]
 * @req UX-NOTICE-12[badger-mobile]
 * @req UX-NOTICE-13[badger-mobile]
 * @why Chris 2026-11-26 (notifications draft): on the phone a missed notice was gone for good. Now the shell's header
 *   holds a bell with the number of unread entries ("9+" above 9, none when all are seen), a repeat of the same notice
 *   replaces its entry and counts once, the bell opens a history screen that marks everything seen, each entry's button
 *   leads where the notice led, the cross removes one and "Clear all" empties it. Entries keep their text keys, so the
 *   list reads in the app's language of the moment, and the history survives a restart (AsyncStorage, one per user).
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncStorageHistory, createNoticeHistory, historyStorageKey, type NoticeHistory } from "@space/notify-core/history";
import type { Notice, TextVars } from "@space/notify-core/kinds";
import { notifyTexts, notifyTranslator, type NotifyLanguage } from "@space/notify-core/texts";
import { useAccountNoticeHistory, type NoticeHistoryStorage } from "../src/notice-history";
import { MobileNoticeBell } from "../src/components/mobile-notice-bell";

const i18nState = vi.hoisted(() => ({ language: "en" }));

vi.mock("react-native", async () => {
  // Hoisted mock factory: React is imported inside it because the factory runs before the file's imports.
  const { createElement } = await import("react");
  return {
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? createElement("Modal", null, children) : null),
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: "Text",
    View: "View",
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("lucide-react-native", () => ({ Bell: "Bell", X: "X" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#ffb357", bg: "#000", surface: "#111", border: "#222", text: "#fff", textMuted: "#aaa", textDim: "#777" },
  }),
}));
// The app's own key an entry may carry (the button of a new-device entry), in two languages.
const APP_TEXTS: Record<string, Record<string, string>> = {
  en: { "account.devices.title": "Your devices" },
  fr: { "account.devices.title": "Vos appareils" },
};
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: TextVars) => APP_TEXTS[i18nState.language]?.[key] ?? notifyTranslator(i18nState.language as NotifyLanguage)(key, vars),
    i18n: { language: i18nState.language },
  }),
}));

const TEST_ID = "MOBILE-SHELL-NOTICE-HISTORY-001";
const log = (...args: unknown[]) => console.info(`[${TEST_ID}]`, ...args);

const memoryStorage = () => {
  const data = new Map<string, string>();
  const storage: NoticeHistoryStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
  return { data, storage };
};

const deviceNotice = (id: string, name: string): Notice => ({
  key: `device-${id}`,
  kind: "headsUp",
  level: "info",
  scope: "account",
  title: { key: "notify.account.newDevice" },
  message: { key: "notify.account.newDeviceMessage", vars: { name, type: "TV" } },
  action: { label: { key: "account.devices.title" }, target: "devices" },
});

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const byId = (tree: ReactTestRenderer, id: string) => tree.root.findAll((node) => node.props.testID === id && typeof node.type === "string");
const press = (tree: ReactTestRenderer, id: string) => {
  const [node] = tree.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function");
  if (!node) throw new Error(`no pressable ${id}`);
  act(() => node.props.onPress());
};
const countText = (tree: ReactTestRenderer) => {
  const [count] = byId(tree, "nav-notifications-count");
  return count ? textOf(count) : null;
};

let renderer: ReactTestRenderer | null = null;
let history: NoticeHistory;
let opened: string[];

const mount = () => {
  act(() => {
    renderer = create(<MobileNoticeBell history={history} onOpenTarget={(target) => opened.push(target)} />);
  });
  return renderer!;
};

beforeEach(async () => {
  i18nState.language = "en";
  opened = [];
  history = createNoticeHistory({ storage: asyncStorageHistory(memoryStorage().storage, "test") });
  await history.ready;
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

describe("MobileNoticeBell", () => {
  it("shows the unread number, a repeat counting once, '9+' above 9 and none once the history is opened", () => {
    const tree = mount();
    expect(countText(tree)).toBeNull();
    act(() => {
      history.record(deviceNotice("a", "Living room"));
      history.record(deviceNotice("b", "Kitchen"));
      history.record(deviceNotice("a", "Living room"));
    });
    log("after a, b, a again:", countText(tree), history.getAll().map((entry) => entry.key));
    expect(countText(tree)).toBe("2");
    expect(history.getAll().map((entry) => entry.key)).toEqual(["device-a", "device-b"]);
    act(() => {
      for (let i = 0; i < 9; i += 1) history.record(deviceNotice(`n${i}`, `Device ${i}`));
    });
    log("after 11 devices:", countText(tree));
    expect(countText(tree)).toBe("9+");

    press(tree, "nav-notifications");
    log("opened; count:", countText(tree), "unread:", history.unreadCount());
    expect(byId(tree, "notice-history")).toHaveLength(1);
    expect(countText(tree)).toBeNull();
    expect(history.unreadCount()).toBe(0);
    // An entry arriving while the history is open is seen at once.
    act(() => {
      history.record(deviceNotice("late", "Laptop"));
    });
    expect(history.unreadCount()).toBe(0);
  });

  it("lists entries in the language of the moment; the button follows the target, the cross removes, Clear all empties", () => {
    act(() => {
      history.record(deviceNotice("a", "Living room"));
    });
    const tree = mount();
    press(tree, "nav-notifications");
    const [entry] = byId(tree, "notice-entry-device-a");
    log("entry (en):", textOf(entry));
    expect(textOf(entry)).toContain(notifyTexts.en.account.newDevice);
    expect(textOf(entry)).toContain("Living room (TV)");
    expect(textOf(entry)).toContain("Your devices");

    i18nState.language = "fr";
    act(() => {
      renderer!.update(<MobileNoticeBell history={history} onOpenTarget={(target) => opened.push(target)} />);
    });
    const [entryFr] = byId(tree, "notice-entry-device-a");
    log("entry (fr):", textOf(entryFr));
    expect(textOf(entryFr)).toContain(notifyTexts.fr.account.newDevice);
    expect(textOf(entryFr)).toContain("Vos appareils");

    press(tree, "notice-entry-open-device-a");
    log("opened targets:", opened);
    expect(opened).toEqual(["devices"]);
    expect(byId(tree, "notice-history")).toHaveLength(0);

    act(() => {
      history.record(deviceNotice("b", "Kitchen"));
    });
    press(tree, "nav-notifications");
    press(tree, "notice-entry-remove-device-b");
    expect(history.getAll().map((e) => e.key)).toEqual(["device-a"]);
    press(tree, "notice-history-clear");
    log("after clear:", history.getAll().length);
    expect(history.getAll()).toHaveLength(0);
    expect(textOf(byId(tree, "notice-history-empty")[0])).toBe(notifyTexts.fr.empty);
  });
});

describe("useAccountNoticeHistory", () => {
  const Probe = ({ storageKey, storage, onHistory }: { storageKey: string | null; storage: NoticeHistoryStorage; onHistory: (h: NoticeHistory | null) => void }) => {
    onHistory(useAccountNoticeHistory(storageKey, storage));
    return null;
  };

  it("keeps one history per user in AsyncStorage, read back after a restart; none signed out", async () => {
    const { data, storage } = memoryStorage();
    const key = historyStorageKey("user-1");
    let seen: NoticeHistory | null = null;
    act(() => {
      renderer = create(<Probe storageKey={key} storage={storage} onHistory={(h) => (seen = h)} />);
    });
    const first = seen as NoticeHistory | null;
    if (!first) throw new Error("no history for a signed-in user");
    await first.ready;
    first.record(deviceNotice("a", "Living room"));
    await vi.waitFor(() => expect(data.get(key)).toContain("device-a"));
    log("saved under", key, "=", data.get(key)?.slice(0, 80));
    expect(key).toBe("sf.notifications.user-1");

    act(() => renderer!.unmount());
    act(() => {
      renderer = create(<Probe storageKey={key} storage={storage} onHistory={(h) => (seen = h)} />);
    });
    const second = seen as NoticeHistory | null;
    if (!second) throw new Error("no history after restart");
    await second.ready;
    expect(second.getAll().map((e) => e.key)).toEqual(["device-a"]);

    act(() => {
      renderer!.update(<Probe storageKey={null} storage={storage} onHistory={(h) => (seen = h)} />);
    });
    expect(seen).toBeNull();
  });
});
