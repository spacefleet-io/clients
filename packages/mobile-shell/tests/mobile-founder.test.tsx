/**
 * @test-id MOBILE-SHELL-FOUNDER-UI-001
 * @level unit
 * @req WAIT-FOUND-04[badger-mobile,parrot]
 * @why Founder launch 2026-11-18: on the phone a founder sees the one-time "🎫 Founder ticket recognised." notice in the
 *   shell's floating notice (tap opens Settings, the cross closes, or it leaves after the fixed time), and however it
 *   leaves the API is told (`POST /account/founder/notice-seen`) so no device shows it again. Settings shows "Founder 🎫 ·
 *   since the waitlist, {date}" on the account, with "Founder price, −30% for life" next to the plan (the phone shows no
 *   prices, ACCT-PAY-02). A non-founder sees neither. Everything reads in the app's language.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FounderStatusResponse } from "@space/shared/founder";
import { getFounderStatus, markFounderNoticeSeen } from "@space/shared/api";
import { createFounderWatch, founderWatch } from "../src/founder";
import { MobileFounderBadge, MobileFounderNotice, MobileFounderNoticeHost } from "../src/components/mobile-founder";
import { NOTICE_DURATION_MS } from "../src/notice-queue";

const i18nState = vi.hoisted(() => ({ language: "en" }));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("@space/shared/api", () => ({
  getFounderStatus: vi.fn(),
  markFounderNoticeSeen: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ warn: () => undefined, info: () => undefined }) }));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ i18n: { language: i18nState.language } }) }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#ffb357", textMuted: "#aaa" } }),
}));
// The toast's own layout is covered by MOBILE-SHELL-NOTICE-OVERLAY-001; here only what the founder notice hands it.
vi.mock("../src/components/mobile-notice-toast", () => ({ MobileNoticeToast: "MobileNoticeToast" }));

const TEST_ID = "MOBILE-SHELL-FOUNDER-UI-001";
const log = (...args: unknown[]) => console.info(`[${TEST_ID}]`, ...args);
const SINCE = "2026-03-03T10:00:00.000Z";
const PENDING: FounderStatusResponse = { founder: true, since: SINCE, noticePending: true };
const SEEN: FounderStatusResponse = { founder: true, since: SINCE, noticePending: false };

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const toastIn = (tree: ReactTestRenderer) => tree.root.findAll((node) => node.type === ("MobileNoticeToast" as unknown as React.ElementType));

const signInAs = async (answer: FounderStatusResponse) => {
  vi.mocked(getFounderStatus).mockResolvedValueOnce(answer);
  await act(async () => {
    await founderWatch.refresh(`tok-${Math.random()}`, { force: true });
  });
};

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  i18nState.language = "en";
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  act(() => founderWatch.reset());
  vi.useRealTimers();
});

describe("MobileFounderBadge", () => {
  it("shows nothing before the status is known, nor for a non-founder", async () => {
    act(() => {
      renderer = create(<MobileFounderBadge showPriceLabel />);
    });
    log("before status:", JSON.stringify(renderer!.toJSON()));
    expect(renderer!.toJSON()).toBeNull();
    await signInAs({ founder: false, since: null, noticePending: false });
    log("non-founder:", JSON.stringify(renderer!.toJSON()));
    expect(renderer!.toJSON()).toBeNull();
  });

  it("shows 'Founder 🎫 · since …' and, next to the plan, the founder price line; leaves on sign-out", async () => {
    act(() => {
      renderer = create(<MobileFounderBadge showPriceLabel />);
    });
    await signInAs(SEEN);
    const byTestId = (id: string) => renderer!.root.findAll((node) => typeof node.type === "string" && node.props?.testID === id);
    const [badge] = byTestId("settings-founder-badge");
    const prices = byTestId("settings-founder-price");
    log("badge en:", textOf(badge), "| prices:", prices.map(textOf));
    expect(textOf(badge)).toMatch(/^Founder 🎫 · since the waitlist, .*2026Founder price, −30% for life$/);
    expect(prices.map(textOf)).toEqual(["Founder price, −30% for life"]);

    act(() => founderWatch.reset());
    log("after sign-out:", JSON.stringify(renderer!.toJSON()));
    expect(renderer!.toJSON()).toBeNull();
  });

  it("reads in the app's language, without the price line where no plan is shown", async () => {
    i18nState.language = "fr";
    act(() => {
      renderer = create(<MobileFounderBadge />);
    });
    await signInAs(SEEN);
    const badge = renderer!.root.find((node) => typeof node.type === "string" && node.props?.testID === "settings-founder-badge");
    log("badge fr:", textOf(badge));
    expect(textOf(badge)).toMatch(/^Fondateur 🎫 · depuis la liste d'attente, .*2026$/);
    expect(renderer!.root.findAll((node) => node.props?.testID === "settings-founder-price")).toHaveLength(0);
  });
});

describe("MobileFounderNotice", () => {
  it("hands the shell's floating notice the founder title, body and close label; tap opens, the cross closes", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    act(() => {
      renderer = create(<MobileFounderNotice language="fr" onOpen={onOpen} onClose={onClose} />);
    });
    const [toast] = toastIn(renderer!);
    log("toast props:", JSON.stringify({ ...toast.props, onOpen: undefined, onClose: undefined }));
    expect(toast.props.testID).toBe("founder-notice");
    expect(toast.props.title).toBe("🎫 Remise fondateur reconnue.");
    expect(toast.props.hint).toBe("Vos −30 % à vie s'appliquent à votre offre.");
    expect(toast.props.closeLabel).toBe("J'ai compris");
    expect(toast.props.accessibilityLabel).toBe("🎫 Remise fondateur reconnue. Vos −30 % à vie s'appliquent à votre offre.");
    toast.props.onOpen();
    toast.props.onClose();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MobileFounderNoticeHost (Parrot's phone)", () => {
  /** A host over its own watch whose API answers `answers` in turn; returns what the API was told. */
  const mountHost = async (answers: FounderStatusResponse[], props: { held?: boolean } = {}) => {
    const queue = [...answers];
    const seen: string[] = [];
    const watch = createFounderWatch({
      fetchStatus: async () => (queue.length > 1 ? queue.shift()! : queue[0]),
      markSeen: async (token) => {
        seen.push(token);
        log("POST notice-seen", token);
        return { ok: true };
      },
      log: (event, payload) => log("watch:", event, JSON.stringify(payload)),
    });
    const onOpen = vi.fn();
    await act(async () => {
      renderer = create(<MobileFounderNoticeHost token="tok-p" watch={watch} onOpen={onOpen} {...props} />);
    });
    return { seen, onOpen, watch };
  };

  it("shows the notice once on sign-in, opens Settings on tap and marks it seen", async () => {
    const { seen, onOpen } = await mountHost([PENDING]);
    const [toast] = toastIn(renderer!);
    log("shown:", toast?.props.title);
    expect(toast.props.title).toBe("🎫 Founder ticket recognised.");
    await act(async () => toast.props.onOpen());
    log("after tap: toasts", toastIn(renderer!).length, "seen", seen);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(toastIn(renderer!)).toHaveLength(0);
    expect(seen).toEqual(["tok-p"]);
  });

  it("marks it seen when it leaves on its own after the fixed time", async () => {
    vi.useFakeTimers();
    const { seen } = await mountHost([PENDING]);
    expect(toastIn(renderer!)).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(NOTICE_DURATION_MS + 10);
    });
    log("after timeout: toasts", toastIn(renderer!).length, "seen", seen);
    expect(toastIn(renderer!)).toHaveLength(0);
    expect(seen).toEqual(["tok-p"]);
  });

  it("waits, unseen, while the player covers the shell", async () => {
    const { seen, watch, onOpen } = await mountHost([PENDING], { held: true });
    log("held: toasts", toastIn(renderer!).length, "seen", seen);
    expect(toastIn(renderer!)).toHaveLength(0);
    expect(seen).toEqual([]);
    // Back from the player: the notice shows then.
    await act(async () => {
      renderer!.update(<MobileFounderNoticeHost token="tok-p" watch={watch} onOpen={onOpen} held={false} />);
    });
    log("released: toasts", toastIn(renderer!).length);
    expect(toastIn(renderer!)).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it("shows nothing when the notice was already seen", async () => {
    const { seen } = await mountHost([SEEN]);
    log("already seen: toasts", toastIn(renderer!).length);
    expect(toastIn(renderer!)).toHaveLength(0);
    expect(seen).toEqual([]);
    expect(vi.mocked(markFounderNoticeSeen)).not.toHaveBeenCalled();
  });
});
