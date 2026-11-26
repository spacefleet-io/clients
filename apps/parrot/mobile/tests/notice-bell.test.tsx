/**
 * @test-id PARROT-MOBILE-NOTICE-BELL-001
 * @level unit
 * @req UX-NOTICE-04[parrot,parrot-tv]
 * @req UX-NOTICE-05[parrot,parrot-tv]
 * @req UX-NOTICE-12[parrot]
 * @covers apps/parrot/mobile/src/screens/NoticeBell.tsx
 * @covers apps/parrot/mobile/src/state/notices.ts
 *
 * Parrot's phone bell is the shared `MobileNoticeBell` (Badger's phone's) over the signed-in user's history; every
 * entry's button opens Settings, where Parrot keeps the account. The history, on the phone and the TV, is kept under the
 * fleet's key for that user and fed the account's news with the session's token.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { token: "tok-1", user: { id: "user-1" } } as { token: string; user: { id: string } } | null,
  history: { entries: [], unread: 2 } as unknown,
  historyKeys: [] as (string | null)[],
  news: [] as [unknown, string | undefined][],
  bell: null as { history: unknown; onOpenTarget: (target: string) => void } | null,
  Pass: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("react-native", () => ({ StyleSheet: { create: <T,>(styles: T) => styles }, View: h.Pass }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { name: "async-storage" } }));
vi.mock("@space/mobile-shell/notice-history", () => ({
  useAccountNoticeHistory: (key: string | null) => {
    h.historyKeys.push(key);
    return key ? h.history : null;
  },
}));
vi.mock("@space/mobile-shell/account-news", () => ({
  useAccountNews: (history: unknown, token: string | undefined) => void h.news.push([history, token]),
}));
vi.mock("@space/mobile-shell/notice-bell", () => ({
  MobileNoticeBell: (props: { history: unknown; onOpenTarget: (target: string) => void }) => {
    h.bell = props;
    return null;
  },
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ session: h.session }) }));

import { ParrotNoticeBell } from "../src/screens/NoticeBell";

const SUITE = "[PARROT-MOBILE-NOTICE-BELL-001]";
let renderer: ReactTestRenderer | null = null;

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  h.session = { token: "tok-1", user: { id: "user-1" } };
  h.historyKeys = [];
  h.news = [];
  h.bell = null;
});

const render = (onOpenSettings: () => void) =>
  act(() => {
    renderer = create(<ParrotNoticeBell onOpenSettings={onOpenSettings} />);
  });

describe(`${SUITE} Parrot phone bell`, () => {
  it("shows the signed-in user's history under the fleet's key, fed the account's news with the session's token", () => {
    render(() => {});
    console.info(SUITE, "keys", { keys: h.historyKeys, news: h.news.at(-1)?.[1] });
    expect(h.historyKeys.at(-1)).toBe("sf.notifications.user-1");
    expect(h.bell?.history).toBe(h.history);
    expect(h.news.at(-1)).toEqual([h.history, "tok-1"]);
  });

  it("every entry's button opens Settings, where Parrot keeps the account", () => {
    const opened: string[] = [];
    render(() => opened.push("settings"));
    for (const target of ["devices", "billing", "storage"]) act(() => h.bell?.onOpenTarget(target));
    expect(opened).toEqual(["settings", "settings", "settings"]);
  });

  it("signed out: no history and no news request", () => {
    h.session = null;
    render(() => {});
    expect(h.historyKeys.at(-1)).toBeNull();
    expect(h.bell?.history).toBeNull();
    expect(h.news.at(-1)).toEqual([null, undefined]);
  });
});
