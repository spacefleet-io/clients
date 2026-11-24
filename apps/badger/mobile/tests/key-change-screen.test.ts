/**
 * @test-id BADGER-MOBILE-KEY-CHANGE-SCREEN-001
 * @level unit
 * @req ACCT-KEYCHG-01[badger-mobile]
 * @req ACCT-KEYCHG-03[badger-mobile]
 * @req ACCT-KEYCHG-05[badger-mobile]
 * @req ACCT-KEYCHG-06[badger-mobile]
 * @req ACCT-KEYCHG-07[badger-mobile]
 * @req ACCT-KEYCHG-08[badger-mobile]
 * @req ACCT-KEYCHG-09[badger-mobile]
 * @req STOR-RESEAL-10[badger-mobile]
 * @why Main 2026-11-23 (option A): Badger's phone changes the media library key with the media re-seal. The screen
 *   mounts the shared key change (`createKeyChange`): the password goes to the run's open, a switched key is stored
 *   and the session ends, a copy that waits on mobile data says so and "Use mobile data" lets it go on, iOS is told to
 *   keep Badger open and plugged in, leaving the app pauses the copying, and Stop asks first. The controller and the
 *   network gate are stand-ins; their own tests are packages/media-reseal and MOBILE-RESEAL-NETWORK-001.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { keyChangeEtaText } from "@space/shared/keyChangeText";
import { KEY_CHANGE_IDLE, type KeyChangeOutcome, type KeyChangeState } from "@space/media-reseal";
import type { BadgerPhoneKeyChangeOptions } from "../src/lib/keyChange";
import { ResetKeyScreen } from "../src/screens/ResetKeyScreen";

type AlertButton = { text: string; style?: string; onPress?: () => void };

const ctl = vi.hoisted(() => ({
  os: "android",
  appState: [] as Array<(state: string) => void>,
  alerts: [] as Array<{ title: string; body: string; buttons: AlertButton[] }>,
  options: null as BadgerPhoneKeyChangeOptions | null,
  phase: "form" as string,
  started: [] as unknown[],
  startResult: null as (() => Promise<KeyChangeOutcome>) | null,
  pauses: 0,
  stops: 0,
  stored: [] as string[],
  logouts: [] as string[],
  gatePaused: false,
  gateListeners: [] as Array<() => void>,
  mobileData: [] as boolean[],
  switchNows: 0,
  files: [] as Array<{ key: string; sizeBytes: number }>,
  deleted: [] as Array<Array<{ key: string; sizeBytes: number }>>,
}));

vi.mock("react-native", async () => {
  const base = (await import("./setup/reactNativeMock")).reactNativeBase();
  return {
    ...base,
    Platform: {
      ...(base.Platform as object),
      get OS() {
        return ctl.os;
      },
    },
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        ctl.appState.push(listener);
        return { remove: () => undefined };
      },
    },
    Alert: {
      alert: (title: string, body: string, buttons: AlertButton[] = []) => {
        ctl.alerts.push({ title, body, buttons });
      },
    },
  };
});
vi.mock("@space/mobile-shell/components", () => ({
  MobileButton: "Button",
  MobileInput: "Input",
  MobileScreen: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/components/SectionHeader", () => ({ SectionHeader: "SectionHeader" }));
vi.mock("../src/components/SettingsRows", () => ({ SwitchRow: "SwitchRow" }));
vi.mock("@space/mobile-shell/libraryKeyWords", () => ({ LibraryKeyWordsGrid: "LibraryKeyWordsGrid" }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../src/theme/theme", () => ({ theme: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }) }));
vi.mock("../src/store/auth", () => ({
  useAuth: () => ({
    token: "token-1",
    user: { hasPassword: true },
    logout: async (reason: string) => {
      ctl.logouts.push(reason);
    },
  }),
}));
vi.mock("../src/store/library", () => ({ useLibrary: () => ({ sealForRotation: async () => null }) }));
vi.mock("../src/lib/onboarding", () => ({
  setStoredLibraryKey: async (key: string) => {
    ctl.stored.push(key);
  },
}));
vi.mock("../src/lib/resealNetwork", () => ({
  createResealNetworkGate: () => ({
    beforeFile: async () => undefined,
    setUseMobileData: (allowed: boolean) => {
      ctl.mobileData.push(allowed);
    },
    paused: () => ctl.gatePaused,
    subscribe: (listener: () => void) => {
      ctl.gateListeners.push(listener);
      return () => undefined;
    },
  }),
}));
vi.mock("../src/lib/keyChange", () => ({
  createBadgerPhoneKeyChange: (options: BadgerPhoneKeyChangeOptions) => {
    ctl.options = options;
    return {
      state: () => ({ ...KEY_CHANGE_IDLE, phase: ctl.phase }),
      start: async (credentials: unknown) => {
        ctl.started.push(credentials);
        return ctl.startResult ? await ctl.startResult() : "stopped";
      },
      resume: async () => "stopped",
      switchNow: async () => {
        ctl.switchNows += 1;
        return "switched";
      },
      poll: async () => null,
      stop: async () => {
        ctl.stops += 1;
      },
      pause: () => {
        ctl.pauses += 1;
      },
      unreadableFiles: async () => ctl.files,
      deleteUnreadableFiles: async (files: Array<{ key: string; sizeBytes: number }>) => {
        ctl.deleted.push(files);
      },
    };
  },
}));

let tree: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};

const mount = async () => {
  await act(async () => {
    tree = create(React.createElement(ResetKeyScreen));
  });
  await flush();
  return tree!;
};

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map((child) => textOf(child)).join("");
const texts = (root: ReactTestRenderer) => root.root.findAll((n) => String(n.type) === "Text").map((n) => textOf(n));
const byTestId = (root: ReactTestRenderer, id: string) => root.root.find((n) => n.props.testID === id && typeof n.type === "string");
const hasTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((n) => n.props.testID === id).length > 0;

/** Types the password, ticks the confirm and presses Replace key; `outcome` is what the run answers. */
const submit = async (root: ReactTestRenderer, outcome: () => Promise<KeyChangeOutcome>) => {
  ctl.startResult = outcome;
  const password = root.root.find((n) => String(n.type) === "Input" && n.props.label === "Account password");
  await act(async () => password.props.onChangeText("pw"));
  await act(async () => byTestId(root, "key-change-confirm").props.onValueChange(true));
  await act(async () => byTestId(root, "key-change-submit").props.onPress());
  await flush();
};

/** The controller reports a state, as `createKeyChange` does while it runs. */
const report = async (state: Partial<KeyChangeState>) => {
  ctl.phase = state.phase ?? ctl.phase;
  await act(async () => ctl.options!.onState({ ...KEY_CHANGE_IDLE, ...state }));
};

const progress = { totalFiles: 4, doneFiles: 1, keptFiles: 0, transferBytes: 800, transferredBytes: 200 };

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  Object.assign(ctl, {
    os: "android",
    options: null,
    phase: "form",
    startResult: null,
    pauses: 0,
    stops: 0,
    gatePaused: false,
    switchNows: 0,
    files: [],
  });
  for (const list of [ctl.appState, ctl.alerts, ctl.started, ctl.stored, ctl.logouts, ctl.gateListeners, ctl.mobileData, ctl.deleted]) list.length = 0;
});

describe("Badger phone key change screen (BADGER-MOBILE-KEY-CHANGE-SCREEN-001)", () => {
  it("sends the password with the run's open; a switched key is stored and the session ends", async () => {
    const root = await mount();
    expect(texts(root)).toContain("New media library key");
    expect(byTestId(root, "key-change-submit").props.disabled).toBe(true);
    await submit(root, async () => "switched");
    console.info("[BADGER-MOBILE-KEY-CHANGE-SCREEN-001] started", JSON.stringify(ctl.started), "logouts", JSON.stringify(ctl.logouts));
    expect(ctl.started).toEqual([{ password: "pw" }]);
    expect(ctl.stored).toEqual([ctl.options!.newKeyBase64]);
    expect(ctl.logouts).toEqual(["sessionRejected"]);
  });

  it("asks for the code when the account wants one, and says where it was sent", async () => {
    const root = await mount();
    await submit(root, async () => {
      throw new ApiError(401, { error: "two_factor_required", method: "email" });
    });
    expect(root.root.findAll((n) => String(n.type) === "Input" && n.props.label === "Verification code")).toHaveLength(1);
    expect(texts(root)).toContain("We sent a verification code. Check your email or authenticator.");
    expect(ctl.logouts).toEqual([]);
  });

  it.each([
    ["ios", "Keep Badger open on screen and plugged in until this ends. If Badger closes, the key change starts over the next time."],
    ["android", "Keep Badger open until this ends. If Badger closes, the key change starts over the next time."],
  ])("while copying on %s, says how to keep it going", async (os, note) => {
    ctl.os = os;
    const root = await mount();
    await submit(root, () => new Promise<KeyChangeOutcome>(() => undefined));
    await report({ phase: "resealing", progress, etaSeconds: 300 });
    console.info("[BADGER-MOBILE-KEY-CHANGE-SCREEN-001]", os, JSON.stringify(texts(root)));
    expect(texts(root)).toContain("Copying your files with the new key");
    expect(textOf(byTestId(root, "key-change-keep-open"))).toBe(note);
  });

  it("the estimate is the shared one, counting the download and the upload of every file", async () => {
    const root = await mount();
    await submit(root, () => new Promise<KeyChangeOutcome>(() => undefined));
    await report({ phase: "resealing", progress, etaSeconds: 300 });
    expect(texts(root)).toEqual(expect.arrayContaining([keyChangeEtaText("en", 300), "1 of 4 files · 200 B / 800 B"]));
  });

  it("a switch waiting on another device offers Switch now once the server says so", async () => {
    const root = await mount();
    await submit(root, async () => "waiting");
    await report({ phase: "waiting", progress, uploadsInFlight: 2, switchNowAt: null });
    expect(hasTestId(root, "key-change-waiting")).toBe(true);
    expect(root.root.findAll((n) => String(n.type) === "Button" && n.props.label === "Switch now")).toHaveLength(0);
    await report({ phase: "waiting", progress, uploadsInFlight: 2, switchNowAt: "2026-01-01T00:00:00.000Z" });
    const switchNow = root.root.find((n) => String(n.type) === "Button" && n.props.label === "Switch now");
    await act(async () => switchNow.props.onPress());
    await flush();
    expect(ctl.switchNows).toBe(1);
    expect(ctl.logouts).toEqual(["sessionRejected"]);
  });

  it("unreadable files are counted, listed and deleted, and the copying goes on", async () => {
    ctl.files = [
      { key: "media/a", sizeBytes: 2048 },
      { key: "media/b", sizeBytes: 4096 },
    ];
    const root = await mount();
    await submit(root, () => new Promise<KeyChangeOutcome>(() => undefined));
    await report({ phase: "resealing", progress: { ...progress, keptFiles: 2 } });
    expect(texts(root)).toContain("2 files can't be opened with your current key. They stay as they are.");
    const see = root.root.find((n) => String(n.type) === "Button" && n.props.label === "See the 2 files");
    await act(async () => see.props.onPress());
    await flush();
    expect(texts(root)).toEqual(expect.arrayContaining(["media/a", "media/b"]));
    const del = root.root.find((n) => String(n.type) === "Button" && n.props.label === "Delete 2 files");
    await act(async () => del.props.onPress());
    await flush();
    expect(ctl.deleted).toEqual([ctl.files]);
    expect(ctl.alerts.at(-1)!.title).toBe("Files deleted");
    expect(hasTestId(root, "key-change-keep-open")).toBe(true);
  });

  it("on mobile data says the copying waits, and Use mobile data lets it go on", async () => {
    const root = await mount();
    await submit(root, () => new Promise<KeyChangeOutcome>(() => undefined));
    await report({ phase: "resealing", progress });
    expect(hasTestId(root, "key-change-mobile-data-paused")).toBe(false);
    ctl.gatePaused = true;
    await act(async () => ctl.gateListeners.forEach((listener) => listener()));
    expect(texts(root)).toEqual(expect.arrayContaining(["Paused on mobile data", "Copying carries on when this phone is on Wi-Fi."]));
    await act(async () => byTestId(root, "key-change-use-mobile-data").props.onValueChange(true));
    expect(ctl.mobileData).toEqual([true]);
    expect(hasTestId(root, "key-change-mobile-data-paused")).toBe(false);
  });

  it("pauses the copying when the app leaves the screen", async () => {
    const root = await mount();
    await submit(root, () => new Promise<KeyChangeOutcome>(() => undefined));
    await report({ phase: "resealing", progress });
    await act(async () => ctl.appState.forEach((listener) => listener("background")));
    expect(ctl.pauses).toBe(1);
    expect(root).toBeTruthy();
  });

  it("Stop sits under More options and asks Keep going / Stop first", async () => {
    const root = await mount();
    await submit(root, async () => "stopped");
    await report({ phase: "ready", progress });
    expect(hasTestId(root, "key-change-stop")).toBe(false);
    const more = root.root.find((n) => String(n.type) === "Button" && n.props.label === "More options");
    await act(async () => more.props.onPress());
    await act(async () => byTestId(root, "key-change-stop").props.onPress());
    const ask = ctl.alerts.at(-1)!;
    expect([ask.title, ask.buttons.map((b) => b.text)]).toEqual(["Stop the key change?", ["Keep going", "Stop"]]);
    expect(ctl.stops).toBe(0);
    await act(async () => ask.buttons[1]!.onPress!());
    await flush();
    expect(ctl.stops).toBe(1);
    expect(ctl.alerts.at(-1)!.title).toBe("Key change stopped");
    expect(hasTestId(root, "key-change-submit")).toBe(true);
  });
});
