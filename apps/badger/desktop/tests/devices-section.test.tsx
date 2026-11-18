// @vitest-environment jsdom
/**
 * ACCT-DEV-01: the signed-in device list (type, name, last seen, sign out) and ACCT-PAIR-03: the toast for
 * a device that appeared since this computer last looked.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@space/shared/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ listDevices: vi.fn(), revokeDevice: vi.fn(), getMe: vi.fn() }));
const auth = vi.hoisted(() => ({ logout: vi.fn(async () => undefined) }));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));

vi.mock("@/api", () => api);
vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { id: "u1" }, logout: auth.logout }),
}));
// ACCT-DEV-03: whether this computer holds the library key decides if Sign out asks first.
const keyStore = vi.hoisted(() => ({ key: null as string | null }));
vi.mock("@/lib/onboarding", () => ({ getStoredLibraryKey: vi.fn(async () => keyStore.key) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => nav.navigate }));
// `t` must be referentially stable: both components reload / re-subscribe when it changes.
const i18n = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}` : key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
// The real Dialog (Radix) renders through a portal into document.body, so the open/closed behaviour is exercised.
vi.mock("@space/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@space/ui")>()), toast }));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { rendererLogger: log };
});
import DevicesSection from "../src/renderer/src/components/settings/sections/DevicesSection";
import NewDeviceNotifier, {
  DEVICES_SETTINGS_PATH,
  NEW_DEVICE_NOTICE_DURATION_MS,
  NEW_DEVICE_POLL_INTERVAL_MS,
} from "../src/renderer/src/components/NewDeviceNotifier";
import { announceNewDevices, DEVICES_CHANGED_EVENT, deviceKind, findNewDevices, readKnownDeviceIds, sortDevices } from "../src/renderer/src/lib/devices";
import { __resetAppWindowVisibilityForTests, __setAppWindowHiddenForTests } from "../src/renderer/src/lib/appWindowVisibility";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const session = (over: Partial<Session> & { id: string }): Session => ({
  clientType: "badger-desktop",
  deviceType: "desktop",
  deviceName: "Living room PC",
  createdAt: minutesAgo(600),
  lastSeen: minutesAgo(5),
  current: false,
  ...over,
});

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

describe("device helpers", () => {
  it("@req ACCT-DEV-01 tells the type from the declared type, else from the client", () => {
    expect(deviceKind({ deviceType: "kodi", clientType: "badger-kodi" })).toBe("kodi");
    expect(deviceKind({ deviceType: null, clientType: "badger-jellyfin" })).toBe("jellyfin");
    expect(deviceKind({ deviceType: null, clientType: "client-mobile" })).toBe("mobile");
    expect(deviceKind({ deviceType: null, clientType: "client-web" })).toBe("web");
    expect(deviceKind({ deviceType: "web", clientType: "badger-web" })).toBe("web");
    expect(deviceKind({ deviceType: null, clientType: "badger-web" })).toBe("web");
    expect(deviceKind({ deviceType: undefined, clientType: "something-new" })).toBe("other");
  });

  it("@req ACCT-DEV-01 lists this device first, then the most recently seen", () => {
    const sorted = sortDevices([
      session({ id: "old", lastSeen: minutesAgo(900) }),
      session({ id: "me", current: true, lastSeen: minutesAgo(900) }),
      session({ id: "recent", lastSeen: minutesAgo(1) }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["me", "recent", "old"]);
  });

  it("@req ACCT-PAIR-03 finds sessions this computer has not seen, never the current one", () => {
    const fresh = findNewDevices(new Set(["a"]), [session({ id: "a" }), session({ id: "b" }), session({ id: "me", current: true })]);
    expect(fresh.map((s) => s.id)).toEqual(["b"]);
  });

  it("@req ACCT-PAIR-03 only records what is there on the first look, then announces additions once", () => {
    const storage = memoryStorage();
    const notify = vi.fn();
    expect(announceNewDevices("u1", [session({ id: "a" })], notify, storage)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    const announced = announceNewDevices("u1", [session({ id: "a" }), session({ id: "b" })], notify, storage);
    expect(announced.map((s) => s.id)).toEqual(["b"]);
    expect(notify).toHaveBeenCalledTimes(1);

    announceNewDevices("u1", [session({ id: "a" }), session({ id: "b" })], notify, storage);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("DevicesSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const mount = async (node: React.ReactNode) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(node));
    await flush();
  };
  // The list lives in a dialog portalled into document.body, not inside the page container.
  const rows = () => [...document.body.querySelectorAll('[data-testid="device-row"]')];
  const listDialog = () => document.body.querySelector('[data-testid="devices-dialog"]');
  const openList = async () => {
    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent === "account.devices.viewAll");
    await act(async () => trigger?.click());
    await flush();
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  // @req UX-LIST-01[badger-desktop]
  it("shows one summary row on the page and keeps the full device list in a scrolling dialog", async () => {
    const many = Array.from({ length: 12 }, (_, i) => session({ id: `d${i}`, deviceName: `Device ${i}`, lastSeen: minutesAgo(i + 1) }));
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true, deviceName: "Living room PC" }), ...many] });
    await mount(<DevicesSection />);

    // Page: one summary row (count + this computer's name + "See all"); none of the 13 devices is listed.
    console.info("[UX-LIST-01 devices] page text:", container.textContent);
    expect(rows()).toHaveLength(0);
    expect(listDialog()).toBeNull();
    expect(container.textContent).toContain("account.devices.summary|count=13");
    expect(container.textContent).toContain("account.devices.summaryThisDevice|name=Living room PC");
    expect(container.textContent).not.toContain("Device 3");
    // The device list adds exactly one button to the page, however many devices there are. The other button is
    // the fixed "Pair a device" row (ACCT-PAIR-01, #775): one action, not a list item, so it does not grow.
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    console.info("[UX-LIST-01 devices] page buttons:", buttons);
    expect(buttons).toEqual(["account.devices.viewAll", "pairApprove.open"]);
    expect(buttons).not.toContain("account.devices.signOut");

    await openList();

    // Dialog: every device, inside a container that scrolls on its own.
    expect(listDialog()).not.toBeNull();
    expect(rows()).toHaveLength(13);
    expect(listDialog()?.textContent).toContain("Device 11");
    const scroller = listDialog()?.querySelector('[data-testid="setting-list-scroll"]');
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(listDialog()?.className).toContain("max-h-");
    expect(scroller?.querySelectorAll('[data-testid="device-row"]')).toHaveLength(13);

    // Closing the dialog returns to the short page.
    const close = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Close");
    await act(async () => close?.click());
    await flush();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("account.devices.summary|count=13");
  });

  it("@req ACCT-DEV-01 shows each device's type, name and last seen, and says what signing out does", async () => {
    api.listDevices.mockResolvedValue({
      sessions: [
        session({ id: "me", current: true, deviceName: "Living room PC" }),
        session({ id: "phone", deviceType: "mobile", clientType: "client-mobile", deviceName: "Pixel", lastSeen: minutesAgo(125) }),
      ],
    });
    await mount(<DevicesSection />);
    await openList();

    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("Living room PC");
    expect(rows()[0]?.textContent).toContain("account.devices.type.desktop");
    expect(rows()[0]?.textContent).toContain("account.devices.thisDevice");
    expect(rows()[1]?.textContent).toContain("Pixel");
    expect(rows()[1]?.textContent).toContain("account.devices.type.mobile");
    expect(rows()[1]?.textContent).toContain("account.devices.lastSeen|when=account.storage.relativeHours|value=2");
    expect(document.body.textContent).toContain("account.devices.subtitle");
  });

  it("@req ACCT-DEV-01 signs another device out and removes it from the list", async () => {
    api.listDevices.mockResolvedValue({
      sessions: [session({ id: "me", current: true }), session({ id: "tv", deviceType: "tv", deviceName: "Living room" })],
    });
    api.revokeDevice.mockResolvedValue({ ok: true });
    await mount(<DevicesSection />);
    await openList();

    const button = rows()[1]?.querySelector("button") as HTMLButtonElement;
    expect(button.title).toContain("account.devices.signOutHint");
    await act(async () => button.click());
    await flush();

    expect(api.revokeDevice).toHaveBeenCalledWith("tok-1", "tv");
    expect(rows()).toHaveLength(1);
  });

  it("@req ACCT-DEV-01 @req ACCT-DEV-03 signs this computer out through the normal sign-out, at once when it holds no key", async () => {
    keyStore.key = null;
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await mount(<DevicesSection />);
    await openList();
    await act(async () => (rows()[0]?.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    // The user signing this computer out forgets its library key (ACCT-DEV-01).
    expect(auth.logout).toHaveBeenCalledWith("signOut");
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith("/login");
  });

  /**
   * @test-id devices-section-sign-out-key-check
   * @level integration (real DevicesSection + real sign-out key-check hook and Radix Dialog; api, auth, key storage stubbed)
   * @req ACCT-DEV-03
   * @why Signing this computer out from the device list is the user's own Sign out, so a computer holding the library
   *   key must ask whether it was saved, exactly like the top-nav Sign out.
   */
  it("@req ACCT-DEV-03 asks whether the key was saved before signing this computer out when it holds the key", async () => {
    keyStore.key = "a2V5LWJ5dGVzLWZvci10ZXN0cw==";
    try {
      api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
      await mount(<DevicesSection />);
      await openList();
      await act(async () => (rows()[0]?.querySelector("button") as HTMLButtonElement).click());
      await flush();
      const question = () => document.body.querySelector('[data-testid="sign-out-key-check"]');
      const button = (text: string) =>
        [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
      console.info(
        `[devices-section-sign-out-key-check] asked=${Boolean(question())} listOpen=${Boolean(listDialog())} logout=${auth.logout.mock.calls.length}`,
      );
      expect(question()).not.toBeNull();
      expect(auth.logout).not.toHaveBeenCalled();

      await act(async () => button("nav.signOutKeyCheck.cancel").click());
      await flush();
      console.info(`[devices-section-sign-out-key-check] after-cancel asked=${Boolean(question())} logout=${auth.logout.mock.calls.length}`);
      expect(question()).toBeNull();
      expect(auth.logout).not.toHaveBeenCalled();

      await openList();
      await act(async () => (rows()[0]?.querySelector("button") as HTMLButtonElement).click());
      await flush();
      await act(async () => button("nav.signOutKeyCheck.confirm").click());
      await flush();
      console.info(`[devices-section-sign-out-key-check] after-confirm logout=${JSON.stringify(auth.logout.mock.calls)} nav=${JSON.stringify(nav.navigate.mock.calls)}`);
      expect(auth.logout).toHaveBeenCalledTimes(1);
      expect(auth.logout).toHaveBeenCalledWith("signOut");
      expect(api.revokeDevice).not.toHaveBeenCalled();
      expect(nav.navigate).toHaveBeenCalledWith("/login");
    } finally {
      keyStore.key = null;
    }
  });

  it("@req ACCT-DEV-01 says when a device could not be signed out and keeps it listed", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true }), session({ id: "tv" })] });
    api.revokeDevice.mockRejectedValue(new Error("offline"));
    await mount(<DevicesSection />);
    await openList();
    await act(async () => (rows()[1]?.querySelector("button") as HTMLButtonElement).click());
    await flush();
    expect(document.body.textContent).toContain("account.devices.signOutError");
    expect(rows()).toHaveLength(2);
  });

  it("@req ACCT-PAIR-03 refreshes the list when the notifier sees a new device, and when the window regains focus", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await mount(<DevicesSection />);
    await openList();
    expect(rows()).toHaveLength(1);

    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true }), session({ id: "kodi-1", deviceName: "Living room" })] });
    await act(async () => window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)));
    await flush();
    expect(rows()).toHaveLength(2);

    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(rows()).toHaveLength(1);
  });
});

describe("NewDeviceNotifier", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    __resetAppWindowVisibilityForTests();
    vi.useRealTimers();
  });

  it("@req ACCT-PAIR-03 stays quiet on the first look, then toasts the name and type of a device added later", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(toast).not.toHaveBeenCalled();

    api.listDevices.mockResolvedValue({
      sessions: [session({ id: "me", current: true }), session({ id: "kodi-1", deviceType: "kodi", deviceName: "Living room" })],
    });
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));

    expect(api.listDevices).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "account.devices.newDevice|name=Living room,type=account.devices.type.kodi",
      expect.objectContaining({ id: "new-device-kodi-1", duration: NEW_DEVICE_NOTICE_DURATION_MS }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("@req ACCT-PAIR-03 @req UX-NOTICE-01[badger-desktop] the toast leaves after a fixed time, and its action closes it and opens the device list", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    api.listDevices.mockResolvedValue({
      sessions: [session({ id: "me", current: true }), session({ id: "tv-1", deviceType: "tv", deviceName: "Den" })],
    });
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));
    expect(toast).toHaveBeenCalledTimes(1);
    const options = toast.mock.calls[0][1] as {
      id: string;
      duration: number;
      action: { label: string; onClick: () => void };
    };
    console.info("[UX-NOTICE-01] desktop toast options", JSON.stringify({ id: options.id, duration: options.duration, label: options.action.label }));
    expect(options.duration).toBe(8_000);
    expect(options.action.label).toBe("account.devices.newDeviceOpen");
    options.action.onClick();
    expect(toast.dismiss).toHaveBeenCalledWith("new-device-tv-1");
    expect(nav.navigate).toHaveBeenCalledWith(DEVICES_SETTINGS_PATH);
    expect(DEVICES_SETTINGS_PATH).toBe("/settings?section=devices");
  });

  it("@req ACCT-PAIR-03 keeps checking after a failed check", async () => {
    api.listDevices.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it("@req ACCT-DEV-01 signs this computer out when the device check is refused because its session was revoked", async () => {
    api.listDevices.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    api.getMe.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.getMe).toHaveBeenCalledWith("tok-1");
    expect(auth.logout).toHaveBeenCalledTimes(1);
    // Signed out from another device = a session the server refused: the key stays (#1361).
    expect(auth.logout).toHaveBeenCalledWith("sessionRejected");
  });

  it("@req ACCT-DEV-01 stays signed in when the refused device check turns out to be a blip", async () => {
    api.listDevices.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    api.getMe.mockResolvedValue({ user: { id: "u1" } });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.getMe).toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("@req ACCT-DEV-01 stays signed in when the device check fails for a reason other than being refused", async () => {
    api.listDevices.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.getMe).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("@req ACCT-PAIR-03 tells an open devices list to refresh when it sees a new device", async () => {
    const refresh = vi.fn();
    window.addEventListener(DEVICES_CHANGED_EVENT, refresh);
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(refresh).not.toHaveBeenCalled();

    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true }), session({ id: "kodi-1" })] });
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
    window.removeEventListener(DEVICES_CHANGED_EVENT, refresh);
  });

  /**
   * @bugfix @regression-proof
   * Closed test 2026-11-13: a device added while the player played (external mpv, the app window hidden) was toasted
   * into the hidden window, timed out there and recorded as seen, so the user never saw it. The check now waits while
   * the window is hidden and runs when it shows again; a toast still up when the player opens is taken back unseen.
   */
  const playerOpens = () => __setAppWindowHiddenForTests({ hidden: true, atMs: Date.now(), reason: "external-mpv-hide" });
  const playerCloses = () => __setAppWindowHiddenForTests({ hidden: false, atMs: Date.now(), reason: "external-mpv-show" });
  const known = () => [...(readKnownDeviceIds("u1") ?? [])].sort();

  it("@bugfix @regression-proof @req ACCT-PAIR-03 a device added while the player is open is toasted unseen only once the player closes", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => playerOpens());

    api.listDevices.mockResolvedValue({
      sessions: [session({ id: "me", current: true }), session({ id: "tv-1", deviceType: "tv", deviceName: "Den" })],
    });
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS * 3));
    console.info("[NEW-DEVICE-BEHIND-PLAYER] player open", JSON.stringify({ toasts: toast.mock.calls.length, known: known() }));
    expect(toast).not.toHaveBeenCalled();
    expect(known()).toEqual(["me"]);

    await act(async () => playerCloses());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    console.info("[NEW-DEVICE-BEHIND-PLAYER] player closed", JSON.stringify({ toasts: toast.mock.calls.length, known: known() }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "account.devices.newDevice|name=Den,type=account.devices.type.tv",
      expect.objectContaining({ id: "new-device-tv-1", duration: NEW_DEVICE_NOTICE_DURATION_MS }),
    );
  });

  it("@bugfix @regression-proof @req ACCT-PAIR-03 a toast still up when the player opens is taken back unseen and shown again after", async () => {
    api.listDevices.mockResolvedValue({ sessions: [session({ id: "me", current: true })] });
    await act(async () => root.render(<NewDeviceNotifier />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    api.listDevices.mockResolvedValue({
      sessions: [session({ id: "me", current: true }), session({ id: "tv-1", deviceType: "tv", deviceName: "Den" })],
    });
    await act(async () => vi.advanceTimersByTimeAsync(NEW_DEVICE_POLL_INTERVAL_MS));
    expect(toast).toHaveBeenCalledTimes(1);

    await act(async () => playerOpens());
    console.info("[NEW-DEVICE-BEHIND-PLAYER] player opened over toast", JSON.stringify({ dismissed: toast.dismiss.mock.calls, known: known() }));
    expect(toast.dismiss).toHaveBeenCalledWith("new-device-tv-1");
    expect(known()).toEqual(["me"]);

    await act(async () => playerCloses());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][1]).toEqual(expect.objectContaining({ id: "new-device-tv-1" }));
  });
});
