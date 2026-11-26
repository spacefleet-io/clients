/**
 * @test-id MOBILE-SHELL-TV-NOTICE-HISTORY-001
 * @level unit
 * @req UX-NOTICE-04[badger-tv]
 * @req UX-NOTICE-11[badger-tv]
 * @req UX-NOTICE-12[badger-tv]
 * @req UX-NOTICE-13[badger-tv]
 * @why Chris 2026-11-26 (notifications draft): on the TV a missed notice was gone for good. Now Settings holds a
 *   "Notifications" row whose end shows the number of unread entries ("9+" above 9, none when all are seen) and opens the
 *   history as a list dialog: opening it marks everything seen, OK on an entry follows its target, "Clear all" empties it,
 *   and the same notice again replaces its entry and counts once. Entries keep their text keys, so they read in the
 *   app's language of the moment.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeHistory, type NoticeHistory } from "@space/notify-core/history";
import type { Notice, TextVars } from "@space/notify-core/kinds";
import { notifyTranslator, type NotifyLanguage } from "@space/notify-core/texts";
import type { TvListDialogItem } from "../src/tv/TvListDialog";
import { TvNoticeHistoryDialog, TvNotificationsRow } from "../src/tv/TvNoticeHistory";

const i18nState = vi.hoisted(() => ({ language: "en" }));

// The row and the dialog are drawn by the shared TV pieces (their own tests cover focus and layout); here they are host
// elements, so the test reads what this file hands them.
vi.mock("../src/tv/TvRow", () => ({ TvRow: "TvRow" }));
vi.mock("../src/tv/TvListDialog", () => ({ TvListDialog: "TvListDialog" }));
vi.mock("lucide-react-native", () => ({ Bell: "Bell" }));
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

const TEST_ID = "MOBILE-SHELL-TV-NOTICE-HISTORY-001";
const log = (...args: unknown[]) => console.info(`[${TEST_ID}]`, ...args);

const deviceNotice = (id: string, name: string): Notice => ({
  key: `device-${id}`,
  kind: "headsUp",
  level: "info",
  scope: "account",
  title: { key: "notify.account.newDevice" },
  message: { key: "notify.account.newDeviceMessage", vars: { name, type: "TV" } },
  action: { label: { key: "account.devices.title" }, target: "devices" },
});

const host = (tree: ReactTestRenderer, type: string): ReactTestInstance => tree.root.find((node) => node.type === type);
const rowEnd = (tree: ReactTestRenderer) => host(tree, "TvRow").props.end;
const items = (tree: ReactTestRenderer): TvListDialogItem[] => host(tree, "TvListDialog").props.items;

describe("the TV's notice history (MOBILE-SHELL-TV-NOTICE-HISTORY-001)", () => {
  let history: NoticeHistory;
  const mounted: ReactTestRenderer[] = [];
  const render = (element: React.ReactElement) => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(element);
    });
    mounted.push(tree);
    return tree;
  };

  beforeEach(() => {
    // A synchronous in-memory store: the history is loaded at once, as in a TV that already read its saved entries.
    let saved: string | null = null;
    history = createNoticeHistory({
      storage: {
        read: () => saved,
        write: (raw) => {
          saved = raw;
        },
      },
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    i18nState.language = "en";
  });
  afterEach(() => {
    act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
  });

  it("the Settings row shows the unread count, counts a repeat once, and shows 9+ above nine", () => {
    const tree = render(<TvNotificationsRow history={history} onPress={() => undefined} />);
    log("empty", { end: rowEnd(tree), description: host(tree, "TvRow").props.description });
    expect(rowEnd(tree)).toEqual({ kind: "chevron" });
    expect(host(tree, "TvRow").props.description).toBe("No notifications yet.");
    act(() => {
      history.record(deviceNotice("a", "Laptop"));
      history.record(deviceNotice("a", "Laptop"));
    });
    log("one twice", { end: rowEnd(tree), entries: history.getAll().length });
    expect(history.getAll()).toHaveLength(1);
    expect(rowEnd(tree)).toEqual({ kind: "value", value: "1" });
    expect(host(tree, "TvRow").props.title).toBe("Notifications");
    act(() => {
      for (let i = 0; i < 11; i += 1) history.record(deviceNotice(`n${i}`, `Phone ${i}`));
    });
    log("twelve", { end: rowEnd(tree) });
    expect(rowEnd(tree)).toEqual({ kind: "value", value: "9+" });
  });

  it("opening the history marks every entry seen; OK on an entry follows its target; Clear all empties it", () => {
    history.record(deviceNotice("a", "Laptop"));
    const opened: string[] = [];
    const tree = render(
      <>
        <TvNotificationsRow history={history} onPress={() => undefined} />
        <TvNoticeHistoryDialog history={history} onClose={() => undefined} onOpenTarget={(target) => opened.push(target)} />
      </>,
    );
    const list = items(tree);
    log("open", { items: list.map((item) => [item.label, item.detail]), unread: history.unreadCount(), end: rowEnd(tree) });
    expect(history.unreadCount()).toBe(0);
    expect(rowEnd(tree)).toEqual({ kind: "chevron" });
    expect(list[0]).toMatchObject({ label: "New device added", testID: "notice-entry-device-a" });
    expect(list[0].detail).toMatch(/^Laptop \(TV\) · \d{1,2}:\d{2}/);
    expect(host(tree, "TvListDialog").props.message).toBe("OK opens · Back closes");
    // An entry arriving while the history is open is seen at once.
    act(() => void history.record(deviceNotice("b", "Tablet")));
    expect(history.unreadCount()).toBe(0);
    act(() => items(tree)[0].onPress());
    expect(opened).toEqual(["devices"]);
    const clear = items(tree).at(-1)!;
    expect(clear).toMatchObject({ testID: "notice-history-clear", label: "Clear all", danger: true });
    act(() => clear.onPress());
    log("cleared", { items: items(tree).length, message: host(tree, "TvListDialog").props.message });
    expect(items(tree)).toEqual([]);
    expect(host(tree, "TvListDialog").props.message).toBe("No notifications yet.");
  });

  it("reads in the app's language of the moment", () => {
    history.record(deviceNotice("a", "Laptop"));
    i18nState.language = "fr";
    const tree = render(<TvNoticeHistoryDialog history={history} onClose={() => undefined} onOpenTarget={() => undefined} />);
    const [entry] = items(tree);
    log("fr", entry.label, entry.detail);
    expect(entry.label).toBe("Nouvel appareil ajouté");
    expect(entry.detail).toMatch(/^Laptop \(TV\) /);
    expect(host(tree, "TvListDialog").props.title).toBe("Notifications");
  });
});
