/**
 * Tests for the shared main-process updater `createDesktopUpdater` (packages/desktop-shell/src/updater/main.ts),
 * used by Badger and Parrot desktop (REL-UPD-01, REL-UPD-02).
 *
 * Everything is injected: a fake Electron `app` / `ipcMain`, a fake electron-updater `autoUpdater` (event emitter +
 * spies), a fake window, logger and callbacks. Global `fetch` is stubbed for release-status; fake timers drive the
 * 6-hour automatic check.
 *
 * Diagnostic logging (tests-log-generously): suite id `updater-main`, phase markers `[updater-main:<test>:<phase>]`,
 * `harness.dump(label)` prints the full fake state before assertions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdater,
  SYSTEM_RELAUNCH_DELAY_MS,
  type AutoUpdaterLike,
  type DesktopUpdaterOptions,
  type UpdaterWindow,
} from "../src/updater/main";
import type { SystemProbe } from "../src/updater/systemPackage";
import { AUTO_UPDATE_INTERVAL_MS, UPDATER_CHANNELS, type UpdaterEvent, type UpdaterState } from "../src/updater/types";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type FetchAnswer = { ok: boolean; json?: () => Promise<unknown> } | Error;

/**
 * A fake OS for systemPackage.ts: `files` exist, `path` commands are installed, `owners` is what each package manager
 * answers when asked who owns the helper, `pkexec` the answer of the password dialog + helper.
 */
const fakeProbe = (
  o: {
    env?: Record<string, string>;
    files?: string[];
    path?: string[];
    owners?: Record<string, string>;
    pkexec?: { code: number | null; stdout?: string; stderr?: string };
  } = {},
) => {
  const run = vi.fn(async (command: string, _args: readonly string[]) =>
    command === "pkexec"
      ? { code: o.pkexec?.code ?? 0, stdout: o.pkexec?.stdout ?? "", stderr: o.pkexec?.stderr ?? "" }
      : { code: 0, stdout: o.owners?.[command] ?? "", stderr: "" },
  );
  const relaunchAfterExit = vi.fn((_command: string, _args: readonly string[]) => undefined);
  const probe: SystemProbe = {
    env: o.env ?? {},
    exists: (path) => (o.files ?? []).includes(path),
    onPath: (name) => (o.path ?? []).includes(name),
    run,
    relaunchAfterExit,
  };
  return { probe, run, relaunchAfterExit };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const makeHarness = (
  opts: {
    app?: "badger" | "parrot";
    packaged?: boolean;
    version?: string;
    apiBase?: string;
    platform?: string;
    loaderError?: string;
    fetchAnswer?: FetchAnswer;
    withWindow?: boolean;
    probe?: SystemProbe;
  } = {},
) => {
  const appId = opts.app ?? "badger";
  const electronApp = {
    isPackaged: opts.packaged ?? true,
    getVersion: vi.fn(() => opts.version ?? "1.0.0"),
    quit: vi.fn(),
  };
  const handlers = new Map<string, Handler>();
  const handleCalls: string[] = [];
  const ipcMain = {
    handle: vi.fn((channel: string, listener: Handler) => {
      handleCalls.push(channel);
      handlers.set(channel, listener);
    }),
  };

  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  const au = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    disableDifferentialDownload: false,
    logger: null as unknown,
    setFeedURL: vi.fn((_options: { provider: "generic"; url: string }) => undefined),
    checkForUpdates: vi.fn(async (): Promise<Awaited<ReturnType<AutoUpdaterLike["checkForUpdates"]>>> => ({
      isUpdateAvailable: false,
      updateInfo: { version: opts.version ?? "1.0.0" },
    })),
    downloadUpdate: vi.fn(async () => undefined as unknown),
    quitAndInstall: vi.fn((_isSilent?: boolean, _isForceRunAfter?: boolean) => undefined),
    on: vi.fn((event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return au;
    }),
    emit: (event: string, arg?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(arg);
    },
  };
  const loadAutoUpdater = vi.fn(() => {
    if (opts.loaderError) throw new Error(opts.loaderError);
    return au as unknown as AutoUpdaterLike;
  });

  const sent: UpdaterEvent[] = [];
  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    webContents: { send: vi.fn((_channel: string, payload: UpdaterEvent) => void sent.push(payload)) },
  };
  let apiBase = opts.apiBase ?? "https://api.example.com/";
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onAutoUpdateChange = vi.fn((_enabled: boolean) => undefined);
  const onQuitForUpdate = vi.fn((): void | Promise<void> => undefined);

  const fetchAnswer = { value: opts.fetchAnswer ?? ({ ok: true, json: async () => ({ mandatory: false }) } as FetchAnswer) };
  const fetchSpy = vi.fn(async (_url: string) => {
    const answer = fetchAnswer.value;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", fetchSpy);

  const options: DesktopUpdaterOptions = {
    app: appId,
    electron: { app: electronApp, ipcMain },
    loadAutoUpdater,
    getApiBaseUrl: () => apiBase,
    getPlatformId: () => opts.platform ?? "linux",
    logger,
    onAutoUpdateChange,
    onQuitForUpdate,
    linuxPackageName: "spacebadger",
    // Default: a Linux copy without SpaceFleet's update helper (unpacked folder, package built elsewhere).
    systemProbe: opts.probe ?? fakeProbe().probe,
  };
  const updater = createDesktopUpdater(options);

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}; registered: ${[...handlers.keys()].join(",")}`);
    return handler({}, ...args);
  };

  const dump = (label: string) => {
    console.log(
      `[updater-main:dump] ${label}`,
      JSON.stringify(
        {
          app: appId,
          packaged: electronApp.isPackaged,
          version: electronApp.getVersion.getMockImplementation()?.(),
          testMode: process.env.SF_UPDATER_TEST_MODE ?? null,
          appImage: process.env.APPIMAGE ?? null,
          flatpakId: process.env.FLATPAK_ID ?? null,
          handlers: handleCalls,
          loaderCalls: loadAutoUpdater.mock.calls.length,
          autoUpdater: {
            autoDownload: au.autoDownload,
            autoInstallOnAppQuit: au.autoInstallOnAppQuit,
            forceDevUpdateConfig: au.forceDevUpdateConfig,
            disableDifferentialDownload: au.disableDifferentialDownload,
            setFeedURL: au.setFeedURL.mock.calls.map(([o]) => o.url),
            checkForUpdates: au.checkForUpdates.mock.calls.length,
            downloadUpdate: au.downloadUpdate.mock.calls.length,
            quitAndInstall: au.quitAndInstall.mock.calls,
            listeners: [...listeners.keys()],
          },
          sent,
          fetch: fetchSpy.mock.calls.map(([url]) => url),
          onAutoUpdateChange: onAutoUpdateChange.mock.calls,
          onQuitForUpdate: onQuitForUpdate.mock.calls.length,
          logger: {
            info: logger.info.mock.calls.map(([, m]) => m),
            warn: logger.warn.mock.calls.map(([f, m]) => [m, f]),
            error: logger.error.mock.calls.map(([f, m]) => [m, f]),
          },
        },
        null,
        2,
      ),
    );
  };

  const register = () => updater.register(() => (opts.withWindow === false ? null : (win as UpdaterWindow)));

  return {
    updater,
    register,
    au,
    electronApp,
    handlers,
    handleCalls,
    invoke,
    win,
    sent,
    logger,
    onAutoUpdateChange,
    onQuitForUpdate,
    fetchSpy,
    fetchAnswer,
    loadAutoUpdater,
    setApiBase: (value: string) => {
      apiBase = value;
    },
    dump,
  };
};

type Harness = ReturnType<typeof makeHarness>;

/** Run `assertions`; on failure dump the harness under `label` and rethrow. */
const checked = async (h: Harness, label: string, assertions: () => void | Promise<void>) => {
  try {
    await assertions();
  } catch (err) {
    h.dump(`${label}:fail`);
    throw err;
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("SF_UPDATER_TEST_MODE", "");
  // The Linux cases below model the AppImage, the one Linux copy that updates itself (REL-DIST-10).
  vi.stubEnv("APPIMAGE", "/home/user/Applications/Badger-1.0.0.AppImage");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const HELPER = "/usr/lib/spacebadger/system-update";
const LATEST_0_1_9 = { ok: true, json: async () => ({ latestVersion: "0.1.9", minClientVersion: "0.0.1", mandatory: false }) };
/** A pacman install of Badger 0.1.5 on a desktop with pkexec. */
const pacmanInstall = (pkexec?: { code: number | null; stdout?: string; stderr?: string }) =>
  fakeProbe({ env: { DISPLAY: ":0" }, files: [HELPER], path: ["pacman", "pkexec"], owners: { pacman: "spacebadger\n" }, pkexec });

/** Detection runs a few awaits deep (the package-manager queries); let it settle under fake timers. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await flush();
};

describe("createDesktopUpdater — Linux copies the package manager installed (REL-DIST-10, REL-UPD-07)", () => {
  // @req REL-DIST-10 @regression-proof
  it("a Linux copy without SpaceFleet's update helper: never builds electron-updater, never checks, answers unsupported", async () => {
    vi.stubEnv("APPIMAGE", "");
    const h = makeHarness({ platform: "linux" });
    h.updater.setAutoUpdate(true);
    h.register();
    vi.advanceTimersByTime(AUTO_UPDATE_INTERVAL_MS * 2);
    await settle();
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const download = await h.invoke(UPDATER_CHANNELS.download);
    const install = await h.invoke(UPDATER_CHANNELS.install);
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    await checked(h, "linux-other", () => {
      expect(h.loadAutoUpdater).not.toHaveBeenCalled();
      expect(h.fetchSpy).not.toHaveBeenCalled();
      expect(h.sent).toEqual([]);
      expect(check).toEqual({ status: "unsupported" });
      expect(download).toEqual({ ok: false, message: "unsupported" });
      expect(install).toEqual({ ok: false });
      expect(state.phase).toBe("unsupported");
      expect(state.currentVersion).toBe("1.0.0");
      expect(h.logger.info.mock.calls.map(([, message]) => message)).toContain(
        "in-app updates off — this Linux copy is not from SpaceFleet's packages",
      );
    });
  });

  // @req REL-UPD-07[badger-desktop,parrot] a package-manager copy checks the feed, asks, and updates through pkexec
  it("pacman copy, automatic updates on: checks release-status at once and every 6 h, never builds electron-updater", async () => {
    vi.stubEnv("APPIMAGE", "");
    const { probe } = pacmanInstall();
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe, fetchAnswer: LATEST_0_1_9 });
    h.updater.setAutoUpdate(true);
    h.register();
    await settle();
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    await checked(h, "pacman-auto", () => {
      expect(h.loadAutoUpdater).not.toHaveBeenCalled();
      expect(h.fetchSpy).toHaveBeenCalledTimes(1);
      expect(h.fetchSpy.mock.calls[0]?.[0]).toBe("https://api.example.com/desktop/badger/release-status?currentVersion=0.1.5&platform=linux");
      expect(h.sent.map((e) => e.kind)).toEqual(["checking", "update-available"]);
      expect(state).toMatchObject({
        phase: "available",
        version: "0.1.9",
        channel: "system",
        canInstall: true,
        manualCommand: `sudo ${HELPER}`,
      });
    });
    vi.advanceTimersByTime(AUTO_UPDATE_INTERVAL_MS);
    await settle();
    expect(h.fetchSpy).toHaveBeenCalledTimes(2);
  });

  // @req REL-UPD-07[badger-desktop,parrot] automatic updates off: no check and no prompt
  it("automatic updates off: no background check; a check by hand still finds the version", async () => {
    vi.stubEnv("APPIMAGE", "");
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe: pacmanInstall().probe, fetchAnswer: LATEST_0_1_9 });
    h.updater.setAutoUpdate(false);
    h.register();
    vi.advanceTimersByTime(AUTO_UPDATE_INTERVAL_MS * 2);
    await settle();
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(await h.invoke(UPDATER_CHANNELS.check)).toEqual({ status: "available", version: "0.1.9" });
  });

  // @req REL-UPD-07[badger-desktop,parrot] Install runs pkexec on the fixed helper only; the app then relaunches itself
  it("Install: pkexec with the helper as its only argument, then the app quits and starts the new binary on its own", async () => {
    vi.stubEnv("APPIMAGE", "");
    const { probe, run, relaunchAfterExit } = pacmanInstall({ code: 0, stdout: "SF_SYSTEM_UPDATE=0 before=0.1.5-1 after=0.1.9-1\n" });
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe, fetchAnswer: LATEST_0_1_9 });
    h.register();
    await settle();
    await h.invoke(UPDATER_CHANNELS.check);
    const result = await h.invoke(UPDATER_CHANNELS.download);
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    await checked(h, "pacman-install", async () => {
      expect(result).toEqual({ ok: true });
      expect(run.mock.calls.filter(([command]) => command === "pkexec")).toEqual([["pkexec", [HELPER]]]);
      expect(h.sent.map((e) => e.kind)).toEqual(["checking", "update-available", "system-installing", "system-installed"]);
      expect(state.phase).toBe("installed");
      expect(state.version).toBe("0.1.9");
      // "Installed, restarting" shows first; a background check in that window never hides it.
      await h.invoke(UPDATER_CHANNELS.check);
      expect(((await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState).phase).toBe("installed");
      expect(h.electronApp.quit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SYSTEM_RELAUNCH_DELAY_MS);
      await settle();
      expect(h.onQuitForUpdate).toHaveBeenCalledTimes(1);
      // Never Electron's app.relaunch(): its helper is the replaced binary. The new one starts once this process exits.
      expect(relaunchAfterExit.mock.calls).toEqual([[process.execPath, process.argv.slice(1)]]);
      expect(h.onQuitForUpdate.mock.invocationCallOrder[0]).toBeLessThan(relaunchAfterExit.mock.invocationCallOrder[0]!);
      expect(relaunchAfterExit.mock.invocationCallOrder[0]).toBeLessThan(h.electronApp.quit.mock.invocationCallOrder[0]!);
      expect(h.electronApp.quit).toHaveBeenCalledTimes(1);
      // Settings' "Restart Badger" in the same moment never starts a second copy.
      expect(await h.invoke(UPDATER_CHANNELS.install)).toEqual({ ok: true });
      expect(relaunchAfterExit).toHaveBeenCalledTimes(1);
      expect(h.au.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  // @req REL-UPD-07[badger-desktop,parrot] closing the password dialog changes nothing
  it("password dialog closed (pkexec 126): back to available, no error", async () => {
    vi.stubEnv("APPIMAGE", "");
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe: pacmanInstall({ code: 126 }).probe, fetchAnswer: LATEST_0_1_9 });
    h.register();
    await settle();
    await h.invoke(UPDATER_CHANNELS.check);
    expect(await h.invoke(UPDATER_CHANNELS.download)).toEqual({ ok: false, message: "dismissed" });
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    expect(state.phase).toBe("available");
    expect(state.failure).toBeNull();
  });

  // @req REL-UPD-07[badger-desktop,parrot] a failure says why and gives the command to run by hand
  it.each([
    [12, "needsSystemUpdate", "sudo pacman -Syu"],
    [10, "notNewer", `sudo ${HELPER}`],
    [13, "packageManager", `sudo ${HELPER}`],
    [127, "notAuthorized", `sudo ${HELPER}`],
  ] as const)("helper or pkexec exit %i: failure %s, manual command %s", async (code, failure, command) => {
    vi.stubEnv("APPIMAGE", "");
    const probe = pacmanInstall({ code, stderr: "[system-update] updating spacebadger would also upgrade: glibc\n" }).probe;
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe, fetchAnswer: LATEST_0_1_9 });
    h.register();
    await settle();
    await h.invoke(UPDATER_CHANNELS.check);
    expect(await h.invoke(UPDATER_CHANNELS.download)).toEqual({ ok: false, message: failure });
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    await checked(h, `pacman-failure-${code}`, () => {
      expect(state).toMatchObject({ phase: "error", failure, manualCommand: command });
      expect(state.failureDetail).toContain("would also upgrade: glibc");
    });
  });

  // @req REL-UPD-07[badger-desktop,parrot] no pkexec or no display: the manual command only
  it("no pkexec on the system: Install never runs pkexec and shows the manual command", async () => {
    vi.stubEnv("APPIMAGE", "");
    const { probe, run } = fakeProbe({ env: { DISPLAY: ":0" }, files: [HELPER], path: ["dpkg-query"], owners: { "dpkg-query": `spacebadger: ${HELPER}\n` } });
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe, fetchAnswer: LATEST_0_1_9 });
    h.register();
    await settle();
    const before = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    expect(before).toMatchObject({ channel: "system", canInstall: false, manualCommand: `sudo ${HELPER}` });
    await h.invoke(UPDATER_CHANNELS.check);
    expect(await h.invoke(UPDATER_CHANNELS.download)).toEqual({ ok: false, message: "noPasswordDialog" });
    expect(run.mock.calls.some(([command]) => command === "pkexec")).toBe(false);
    expect(((await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState).failure).toBe("noPasswordDialog");
  });

  // @req REL-UPD-07[badger-desktop,parrot] a Flatpak is told the flatpak update command
  it("Flatpak: checks the feed and offers `flatpak update <id>`, never pkexec", async () => {
    vi.stubEnv("APPIMAGE", "");
    const { probe, run } = fakeProbe({ env: { FLATPAK_ID: "io.spacefleet.Badger", DISPLAY: ":0" }, path: ["pkexec"] });
    const h = makeHarness({ platform: "linux", version: "0.1.5", probe, fetchAnswer: LATEST_0_1_9 });
    h.updater.setAutoUpdate(true);
    h.register();
    await settle();
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    expect(state).toMatchObject({ phase: "available", version: "0.1.9", channel: "flatpak", canInstall: false, manualCommand: "flatpak update io.spacefleet.Badger" });
    expect(await h.invoke(UPDATER_CHANNELS.download)).toEqual({ ok: false, message: "manual" });
    expect(run).not.toHaveBeenCalled();
  });

  // @req REL-DIST-10
  it("AppImage (APPIMAGE set): builds the updater and checks at once with automatic updates on", async () => {
    const h = makeHarness({ platform: "linux" });
    console.log(`[updater-main:linux-appimage:start] APPIMAGE=${process.env.APPIMAGE}`);
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    h.dump("linux-appimage");
    expect(h.loadAutoUpdater).toHaveBeenCalledTimes(1);
    expect(h.au.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  // @req REL-DIST-10
  for (const platform of ["windows", "macos"]) {
    it(`${platform} without APPIMAGE: the updater still runs (the gate is Linux-only)`, async () => {
      vi.stubEnv("APPIMAGE", "");
      const h = makeHarness({ platform });
      console.log(`[updater-main:non-linux:start] platform=${platform}`);
      h.updater.setAutoUpdate(true);
      h.register();
      await flush();
      h.dump(`non-linux ${platform}`);
      expect(h.loadAutoUpdater).toHaveBeenCalledTimes(1);
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(1);
    });
  }
});

describe("createDesktopUpdater — registration", () => {
  // @req REL-UPD-01
  it("registers check / download / install / set-auto / state once; a second register is a no-op", async () => {
    const h = makeHarness();
    console.log("[updater-main:register:start] packaged=true version=1.0.0");
    h.register();
    h.register();
    h.dump("register:after");
    await checked(h, "register", () => {
      expect(h.handleCalls.sort()).toEqual(
        [UPDATER_CHANNELS.check, UPDATER_CHANNELS.download, UPDATER_CHANNELS.install, UPDATER_CHANNELS.setAuto, UPDATER_CHANNELS.state].sort(),
      );
      expect(h.loadAutoUpdater).toHaveBeenCalledTimes(1);
      expect(h.au.on.mock.calls.map(([event]) => event).sort()).toEqual(
        ["checking-for-update", "download-progress", "error", "update-available", "update-downloaded", "update-not-available"].sort(),
      );
      // Off until the app applies the user's setting.
      expect(h.au.autoDownload).toBe(false);
      expect(h.au.autoInstallOnAppQuit).toBe(false);
    });
  });

  it("the automatic-check cadence is 6 hours", () => {
    console.log(`[updater-main:interval] AUTO_UPDATE_INTERVAL_MS=${AUTO_UPDATE_INTERVAL_MS}`);
    expect(AUTO_UPDATE_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  // @req REL-UPD-02 @bugfix @regression-proof
  // `electron out/main/index.js` finds no package.json, so app.getVersion() is "0.0" and electron-updater's
  // constructor throws. That must never stop the window from opening.
  it("version '0.0': never builds the autoUpdater, logs a warning and answers 'unsupported'", async () => {
    const h = makeHarness({ version: "0.0", loaderError: 'App version is not a valid semver version: "0.0"' });
    console.log("[updater-main:invalid-version:start] version=0.0");
    expect(() => h.register()).not.toThrow();
    h.updater.setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS * 2);
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const download = await h.invoke(UPDATER_CHANNELS.download);
    const install = await h.invoke(UPDATER_CHANNELS.install);
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("invalid-version:after");
    console.log(`[updater-main:invalid-version:results] ${JSON.stringify({ check, download, install, state })}`);
    await checked(h, "invalid-version", () => {
      expect(h.loadAutoUpdater).not.toHaveBeenCalled();
      expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ version: "0.0" }), expect.stringContaining("in-app updater skipped"));
      expect(check).toEqual({ status: "unsupported" });
      expect(download).toEqual({ ok: false, message: "unsupported" });
      expect(install).toEqual({ ok: false });
      expect(state.phase).toBe("unsupported");
      // REL-UPD-05: Settings still shows the version the app runs, even with the updater off.
      expect(state.currentVersion).toBe("0.0");
      expect(h.handlers.has(UPDATER_CHANNELS.setAuto)).toBe(true);
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });
  });

  // @req REL-UPD-02
  it("autoUpdater loader throws on a valid version: logged with the version, never rethrown, 'unsupported'", async () => {
    const h = makeHarness({ loaderError: "platform updater exploded" });
    console.log("[updater-main:loader-throws:start] version=1.0.0");
    expect(() => h.register()).not.toThrow();
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("loader-throws:after");
    await checked(h, "loader-throws", () => {
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ version: "1.0.0", message: "platform updater exploded" }),
        expect.stringContaining("in-app updater registration failed"),
      );
      expect(check).toEqual({ status: "unsupported" });
      expect(state.phase).toBe("unsupported");
    });
  });
});

describe("createDesktopUpdater — check / download / install IPC", () => {
  // @req REL-UPD-01
  it("sets the feed URL <api>/desktop/<app> (trailing slash stripped) before every check, following the live host", async () => {
    const h = makeHarness({ app: "parrot", apiBase: "https://api.example.com///" });
    console.log("[updater-main:feed-url:start] app=parrot api=https://api.example.com///");
    h.register();
    await h.invoke(UPDATER_CHANNELS.check);
    h.setApiBase("https://other.example.org/");
    await h.invoke(UPDATER_CHANNELS.check);
    h.dump("feed-url:after");
    await checked(h, "feed-url", () => {
      expect(h.au.setFeedURL.mock.calls.map(([o]) => o)).toEqual([
        { provider: "generic", url: "https://api.example.com/desktop/parrot" },
        { provider: "generic", url: "https://other.example.org/desktop/parrot" },
      ]);
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 2; i += 1) {
        expect(h.au.setFeedURL.mock.invocationCallOrder[i]).toBeLessThan(h.au.checkForUpdates.mock.invocationCallOrder[i]!);
      }
    });
  });

  it("check answers available / up-to-date / error from autoUpdater.checkForUpdates", async () => {
    const h = makeHarness();
    h.register();
    h.au.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } });
    const available = await h.invoke(UPDATER_CHANNELS.check);
    h.au.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: "1.0.0" } });
    const upToDate = await h.invoke(UPDATER_CHANNELS.check);
    h.au.checkForUpdates.mockResolvedValueOnce(null);
    const noResult = await h.invoke(UPDATER_CHANNELS.check);
    h.au.checkForUpdates.mockRejectedValueOnce(new Error("ENOTFOUND api.example.com"));
    const failed = await h.invoke(UPDATER_CHANNELS.check);
    console.log(`[updater-main:check-results] ${JSON.stringify({ available, upToDate, noResult, failed })}`);
    await checked(h, "check-results", () => {
      expect(available).toEqual({ status: "available", version: "2.0.0" });
      expect(upToDate).toEqual({ status: "up-to-date" });
      expect(noResult).toEqual({ status: "up-to-date" });
      expect(failed).toEqual({ status: "error", message: "ENOTFOUND api.example.com" });
    });
  });

  it("download sets the feed then downloads; a failure answers ok:false with the message", async () => {
    const h = makeHarness();
    h.register();
    const ok = await h.invoke(UPDATER_CHANNELS.download);
    h.au.downloadUpdate.mockRejectedValueOnce(new Error("disk full"));
    const failed = await h.invoke(UPDATER_CHANNELS.download);
    console.log(`[updater-main:download] ${JSON.stringify({ ok, failed })}`);
    await checked(h, "download", () => {
      expect(ok).toEqual({ ok: true });
      expect(failed).toEqual({ ok: false, message: "disk full" });
      expect(h.au.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://api.example.com/desktop/badger" });
      expect(h.au.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(h.au.downloadUpdate.mock.invocationCallOrder[0]!);
    });
  });

  // @req REL-UPD-05 @bugfix @regression-proof
  it("a failed automatic download (startup, 6-hourly or button check) never escapes as an unhandled rejection", async () => {
    // Bugsink 2f521917: Badger 0.1.20 on macOS started from a read-only volume; Squirrel rejected the download promise
    // that checkForUpdates hands back, nobody caught it, and the error reporter got an unhandled rejection.
    const raw =
      "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = makeHarness({ platform: "macos" });
      const failingCheck = async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: "2.0.0" },
        downloadPromise: Promise.reject(new Error(raw)),
      });
      h.au.checkForUpdates.mockImplementationOnce(failingCheck).mockImplementationOnce(failingCheck).mockImplementationOnce(failingCheck);
      h.updater.setAutoUpdate(true);
      h.register(); // startup check
      await flush();
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS); // 6-hourly check
      const byButton = await h.invoke(UPDATER_CHANNELS.check);
      vi.useRealTimers();
      // Node reports unhandled rejections once the microtask queue drains: one real macrotask turn is enough.
      const { promise: turn, resolve: nextTurn } = Promise.withResolvers<void>();
      setImmediate(nextTurn);
      await turn;
      const warned = h.logger.warn.mock.calls.filter(([, m]) => m === "automatic update download failed — reported through the updater's error event");
      console.log(`[updater-main:auto-download-rejection] ${JSON.stringify({ byButton, warned: warned.length, unhandled: unhandled.map(String) })}`);
      await checked(h, "auto-download-rejection", () => {
        expect(h.au.checkForUpdates).toHaveBeenCalledTimes(3);
        expect(byButton).toEqual({ status: "available", version: "2.0.0" });
        expect(warned).toHaveLength(3);
        expect(warned[0]![0]).toEqual({ message: raw });
        expect(unhandled).toEqual([]);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // @req REL-UPD-01
  it("once an update is downloaded, check and download neither re-check nor re-download (macOS would re-stage the bundle)", async () => {
    const h = makeHarness();
    h.register();
    h.au.emit("update-downloaded", { version: "2.0.0" });
    const sentBefore = h.sent.length;
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const download = await h.invoke(UPDATER_CHANNELS.download);
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("downloaded-guard:after");
    await checked(h, "downloaded-guard", () => {
      expect(check).toEqual({ status: "available", version: "2.0.0" });
      expect(download).toEqual({ ok: true });
      expect(h.au.checkForUpdates).not.toHaveBeenCalled();
      expect(h.au.downloadUpdate).not.toHaveBeenCalled();
      expect(h.fetchSpy).not.toHaveBeenCalled();
      expect(h.sent.slice(sentBefore)).toEqual([{ kind: "update-downloaded", version: "2.0.0" }]);
      expect(state.phase).toBe("downloaded");
      expect(state.version).toBe("2.0.0");
    });
  });

  // @req REL-UPD-01
  it("install marks the app as quitting (onQuitForUpdate) then calls quitAndInstall(true, true)", async () => {
    const h = makeHarness();
    h.register();
    h.au.emit("update-downloaded", { version: "2.0.0" });
    const result = await h.invoke(UPDATER_CHANNELS.install);
    h.dump("install:after");
    await checked(h, "install", () => {
      expect(result).toEqual({ ok: true });
      expect(h.onQuitForUpdate).toHaveBeenCalledTimes(1);
      expect(h.au.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(h.onQuitForUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.au.quitAndInstall.mock.invocationCallOrder[0]!);
    });
  });

  // @req PAR-PL-05[parrot]
  // @req REL-UPD-01
  it("install waits for an async onQuitForUpdate (Parrot saving its queued edits) before quitAndInstall", async () => {
    const h = makeHarness();
    h.register();
    h.au.emit("update-downloaded", { version: "2.0.0" });
    const { promise: saved, resolve: finishSaving } = Promise.withResolvers<void>();
    h.onQuitForUpdate.mockImplementationOnce(() => saved);
    const install = h.invoke(UPDATER_CHANNELS.install);
    // Let the handler run up to its await: the edits are still being saved, so nothing quits yet.
    await flush();
    h.dump("install:while-saving");
    await checked(h, "install-while-saving", () => {
      expect(h.onQuitForUpdate).toHaveBeenCalledTimes(1);
      expect(h.au.quitAndInstall).not.toHaveBeenCalled();
    });
    finishSaving();
    const result = await install;
    h.dump("install:after-saving");
    await checked(h, "install-after-saving", () => {
      expect(result).toEqual({ ok: true });
      expect(h.au.quitAndInstall).toHaveBeenCalledWith(true, true);
    });
  });

  // @req REL-UPD-02
  it("unpackaged build: check / download / install answer unsupported and never touch the autoUpdater", async () => {
    const h = makeHarness({ packaged: false });
    console.log("[updater-main:unpackaged:start] packaged=false");
    h.register();
    h.updater.setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS * 2);
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const download = await h.invoke(UPDATER_CHANNELS.download);
    const install = await h.invoke(UPDATER_CHANNELS.install);
    h.dump("unpackaged:after");
    await checked(h, "unpackaged", () => {
      expect(check).toEqual({ status: "unsupported" });
      expect(download).toEqual({ ok: false, message: "unsupported" });
      expect(install).toEqual({ ok: false });
      expect(h.au.checkForUpdates).not.toHaveBeenCalled();
      expect(h.au.setFeedURL).not.toHaveBeenCalled();
      expect(h.au.downloadUpdate).not.toHaveBeenCalled();
      expect(h.au.quitAndInstall).not.toHaveBeenCalled();
      expect(h.onQuitForUpdate).not.toHaveBeenCalled();
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });
  });

  // E2E escape hatch: an unpackaged build runs against a mock feed and install only reports restart-requested.
  it("SF_UPDATER_TEST_MODE=1: runs unpackaged with forceDevUpdateConfig, install emits restart-requested instead of quitting", async () => {
    vi.stubEnv("SF_UPDATER_TEST_MODE", "1");
    const h = makeHarness({ packaged: false });
    console.log("[updater-main:test-mode:start] packaged=false SF_UPDATER_TEST_MODE=1");
    h.register();
    const check = await h.invoke(UPDATER_CHANNELS.check);
    const install = await h.invoke(UPDATER_CHANNELS.install);
    h.dump("test-mode:after");
    await checked(h, "test-mode", () => {
      expect(h.au.forceDevUpdateConfig).toBe(true);
      expect(h.au.disableDifferentialDownload).toBe(true);
      expect(check).toEqual({ status: "up-to-date" });
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(install).toEqual({ ok: true });
      expect(h.sent).toContainEqual({ kind: "restart-requested" });
      expect(h.au.quitAndInstall).not.toHaveBeenCalled();
      expect(h.onQuitForUpdate).not.toHaveBeenCalled();
    });
  });
});

describe("createDesktopUpdater — events and state", () => {
  it("forwards autoUpdater events to the window and folds them into the state IPC", async () => {
    const h = makeHarness();
    h.register();
    h.au.emit("checking-for-update");
    h.au.emit("update-available", { version: "2.0.0", releaseNotes: [{ note: "Faster" }, { note: null }, { note: "Fixes" }] });
    h.au.emit("download-progress", { percent: 41.6 });
    const midState = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.au.emit("update-downloaded", { version: "2.0.0" });
    h.au.emit("error", new Error("late background failure"));
    const endState = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("events:after");
    console.log(`[updater-main:events:states] mid=${JSON.stringify(midState)} end=${JSON.stringify(endState)}`);
    await checked(h, "events", () => {
      expect(h.sent).toEqual([
        { kind: "checking" },
        { kind: "update-available", version: "2.0.0", releaseNotes: "Faster\n\nFixes", checkedAt: expect.any(Number) },
        { kind: "download-progress", percent: 42 },
        { kind: "update-downloaded", version: "2.0.0" },
        { kind: "error", message: "late background failure" },
      ]);
      expect(h.win.webContents.send.mock.calls.every(([channel]) => channel === UPDATER_CHANNELS.event)).toBe(true);
      expect(midState).toMatchObject({ phase: "downloading", progress: 42, version: "2.0.0", lastCheckedAt: expect.any(Number) });
      // A failed check after a finished download keeps the download installable.
      expect(endState).toMatchObject({ phase: "downloaded", version: "2.0.0", progress: 100 });
    });
  });

  // @req REL-UPD-05
  it("reports the installed version and when the last check finished, also when nothing new was found", async () => {
    const h = makeHarness({ version: "0.1.7" });
    h.register();
    const before = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.au.emit("checking-for-update");
    h.au.emit("update-not-available", { version: "0.1.7" });
    const after = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("version-checked-at:after");
    console.log(`[updater-main:version-checked-at:states] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await checked(h, "version-checked-at", () => {
      expect(before).toMatchObject({ currentVersion: "0.1.7", lastCheckedAt: null });
      expect(h.sent).toEqual([{ kind: "checking" }, { kind: "update-not-available", checkedAt: expect.any(Number) }]);
      expect(after).toMatchObject({ phase: "idle", currentVersion: "0.1.7", lastCheckedAt: expect.any(Number) });
    });
  });

  it("a destroyed or missing window does not receive events (and does not throw)", async () => {
    const h = makeHarness();
    h.register();
    h.win.destroyed = true;
    h.au.emit("checking-for-update");
    const noWin = makeHarness({ withWindow: false });
    noWin.register();
    expect(() => noWin.au.emit("checking-for-update")).not.toThrow();
    const state = (await noWin.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    console.log(`[updater-main:no-window] sent=${JSON.stringify(h.sent)} state=${JSON.stringify(state)}`);
    await checked(h, "no-window", () => {
      expect(h.win.webContents.send).not.toHaveBeenCalled();
      expect(state.phase).toBe("checking");
    });
  });
});

describe("createDesktopUpdater — automatic updates (REL-UPD-01)", () => {
  // @req REL-UPD-01
  it("setAutoUpdate(true) before register: register checks at once, then every AUTO_UPDATE_INTERVAL_MS, auto download/install on", async () => {
    const h = makeHarness();
    console.log("[updater-main:auto-arm:start] setAutoUpdate(true) then register");
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    const afterRegister = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS - 1);
    const beforeTick = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const afterOneTick = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS);
    const afterTwoTicks = h.au.checkForUpdates.mock.calls.length;
    console.log(`[updater-main:auto-arm:counts] ${JSON.stringify({ afterRegister, beforeTick, afterOneTick, afterTwoTicks })}`);
    h.dump("auto-arm:after");
    await checked(h, "auto-arm", () => {
      expect(afterRegister).toBe(1);
      expect(beforeTick).toBe(1);
      expect(afterOneTick).toBe(2);
      expect(afterTwoTicks).toBe(3);
      expect(h.au.autoDownload).toBe(true);
      expect(h.au.autoInstallOnAppQuit).toBe(true);
      // Feed set before every background check; release-status asked each time.
      expect(h.au.setFeedURL).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i += 1) {
        expect(h.au.setFeedURL.mock.invocationCallOrder[i]).toBeLessThan(h.au.checkForUpdates.mock.invocationCallOrder[i]!);
      }
      expect(h.fetchSpy).toHaveBeenCalledTimes(3);
      // A check never installs during the session: only quitAndInstall does, on the user's restart.
      expect(h.au.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  // @req REL-UPD-01
  it("setAutoUpdate(true) after register arms at once; setAutoUpdate(false) disarms and turns auto download/install off", async () => {
    const h = makeHarness();
    h.register();
    await flush();
    const beforeArm = h.au.checkForUpdates.mock.calls.length;
    h.updater.setAutoUpdate(true);
    await flush();
    const afterArm = h.au.checkForUpdates.mock.calls.length;
    // Applying the same setting again neither re-checks nor stacks a second timer.
    h.updater.setAutoUpdate(true);
    await flush();
    const afterRepeat = h.au.checkForUpdates.mock.calls.length;
    h.updater.setAutoUpdate(false);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS * 3);
    const afterDisarm = h.au.checkForUpdates.mock.calls.length;
    console.log(`[updater-main:auto-disarm:counts] ${JSON.stringify({ beforeArm, afterArm, afterRepeat, afterDisarm })}`);
    h.dump("auto-disarm:after");
    await checked(h, "auto-disarm", () => {
      expect(beforeArm).toBe(0);
      expect(afterArm).toBe(1);
      expect(afterRepeat).toBe(1);
      expect(afterDisarm).toBe(1);
      expect(h.au.autoDownload).toBe(false);
      expect(h.au.autoInstallOnAppQuit).toBe(false);
    });
  });

  // @req REL-UPD-01
  it.each([
    ["downloading", (h: Harness) => h.au.emit("download-progress", { percent: 10 })],
    ["downloaded", (h: Harness) => h.au.emit("update-downloaded", { version: "2.0.0" })],
  ] as const)("the background check is skipped while an update is %s", async (phase, drive) => {
    const h = makeHarness();
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    drive(h);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS * 2);
    h.dump(`auto-skip-${phase}:after`);
    await checked(h, `auto-skip-${phase}`, () => {
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ phase }), expect.stringContaining("scheduled update check skipped"));
    });
  });

  it("a failing background check is logged and does not stop the next one", async () => {
    const h = makeHarness();
    h.au.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS);
    h.dump("auto-failure:after");
    await checked(h, "auto-failure", () => {
      expect(h.logger.warn).toHaveBeenCalledWith({ message: "offline" }, "scheduled update check failed");
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(2);
    });
  });

  // @req REL-UPD-01
  it("SF_UPDATER_CHECK_INTERVAL_MS (e2e hook) runs the same background check on a shorter cadence", async () => {
    vi.stubEnv("SF_UPDATER_CHECK_INTERVAL_MS", "5000");
    const h = makeHarness();
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    const afterRegister = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    const beforeTick = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const afterOneTick = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    const afterThreeTicks = h.au.checkForUpdates.mock.calls.length;
    console.log(`[updater-main:interval-hook:counts] ${JSON.stringify({ afterRegister, beforeTick, afterOneTick, afterThreeTicks })}`);
    h.dump("interval-hook:after");
    await checked(h, "interval-hook", () => {
      expect([afterRegister, beforeTick, afterOneTick, afterThreeTicks]).toEqual([1, 1, 2, 4]);
      expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 5000 }), "automatic update checks armed");
    });
  });

  it.each(["", "abc", "0", "-5", "999", "1.5e3x"])("SF_UPDATER_CHECK_INTERVAL_MS=%j keeps the 6-hour cadence", async (value) => {
    vi.stubEnv("SF_UPDATER_CHECK_INTERVAL_MS", value);
    const h = makeHarness();
    h.updater.setAutoUpdate(true);
    h.register();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS - 1);
    const beforeTick = h.au.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const afterTick = h.au.checkForUpdates.mock.calls.length;
    console.log(`[updater-main:interval-hook-invalid:${JSON.stringify(value)}] ${JSON.stringify({ beforeTick, afterTick })}`);
    await checked(h, `interval-hook-invalid:${value}`, () => {
      expect([beforeTick, afterTick]).toEqual([1, 2]);
      expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: AUTO_UPDATE_INTERVAL_MS }), "automatic update checks armed");
      if (value !== "") {
        expect(h.logger.warn).toHaveBeenCalledWith({ value }, expect.stringContaining("SF_UPDATER_CHECK_INTERVAL_MS ignored"));
      }
    });
  });

  // @req REL-UPD-01
  it("set-auto IPC applies the setting and reports it through onAutoUpdateChange; state IPC returns autoUpdate", async () => {
    const h = makeHarness();
    h.register();
    const initial = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    const on = await h.invoke(UPDATER_CHANNELS.setAuto, true);
    await flush();
    const armed = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    const checksWhenOn = h.au.checkForUpdates.mock.calls.length;
    const off = await h.invoke(UPDATER_CHANNELS.setAuto, 0);
    const disarmed = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS);
    console.log(`[updater-main:set-auto-ipc] ${JSON.stringify({ initial, on, armed, checksWhenOn, off, disarmed })}`);
    h.dump("set-auto-ipc:after");
    await checked(h, "set-auto-ipc", () => {
      expect(initial.autoUpdate).toBe(false);
      expect(on).toEqual({ ok: true });
      expect(armed.autoUpdate).toBe(true);
      expect(checksWhenOn).toBe(1);
      expect(off).toEqual({ ok: true });
      expect(disarmed.autoUpdate).toBe(false);
      expect(h.onAutoUpdateChange.mock.calls).toEqual([[true], [false]]);
      expect(h.au.checkForUpdates).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createDesktopUpdater — release-status (mandatory update)", () => {
  const sentMandatory = (h: Harness) => h.sent.filter((event) => event.kind === "mandatory-update");

  // @req REL-UPD-01
  it("asks <api>/desktop/<app>/release-status with the version and platform; a mandatory answer emits mandatory-update", async () => {
    const h = makeHarness({
      platform: "windows",
      fetchAnswer: { ok: true, json: async () => ({ mandatory: true, latestVersion: "2.0.0", minClientVersion: "1.5.0" }) },
    });
    h.register();
    await h.invoke(UPDATER_CHANNELS.check);
    await flush();
    const state = (await h.invoke(UPDATER_CHANNELS.state)) as UpdaterState;
    h.dump("release-status-mandatory:after");
    await checked(h, "release-status-mandatory", () => {
      const url = new URL(String(h.fetchSpy.mock.calls[0]?.[0]));
      expect(url.origin + url.pathname).toBe("https://api.example.com/desktop/badger/release-status");
      expect(url.searchParams.get("currentVersion")).toBe("1.0.0");
      expect(url.searchParams.get("platform")).toBe("windows");
      expect(sentMandatory(h)).toEqual([{ kind: "mandatory-update", latestVersion: "2.0.0", minClientVersion: "1.5.0" }]);
      expect(state).toMatchObject({ mandatory: true, phase: "available", version: "2.0.0" });
    });
  });

  it.each<[string, FetchAnswer]>([
    ["mandatory:false", { ok: true, json: async () => ({ mandatory: false, latestVersion: "2.0.0", minClientVersion: "0.1.0" }) }],
    ["non-ok response", { ok: false }],
    ["malformed body", { ok: true, json: async () => ({ mandatory: true, latestVersion: 2, minClientVersion: null }) }],
    ["null body", { ok: true, json: async () => null }],
    ["fetch throws", new Error("ECONNREFUSED")],
  ])("%s: no mandatory-update, the check still answers", async (label, answer) => {
    const h = makeHarness({ fetchAnswer: answer });
    h.register();
    const result = await h.invoke(UPDATER_CHANNELS.check);
    await flush();
    h.dump(`release-status-${label}:after`);
    await checked(h, `release-status-${label}`, () => {
      expect(result).toEqual({ status: "up-to-date" });
      expect(sentMandatory(h)).toEqual([]);
      if (answer instanceof Error) {
        expect(h.logger.warn).toHaveBeenCalledWith({ message: "ECONNREFUSED" }, "release-status check failed");
      }
    });
  });
});
