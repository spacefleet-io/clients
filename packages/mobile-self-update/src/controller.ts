import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, type EmitterSubscription } from "react-native";
import { useSyncExternalStore } from "react";
import {
  ANDROID_PACKAGE_NAMES,
  ANDROID_REPO_FINGERPRINT,
  FDROID_REPO_URL,
  indexFromEntry,
  newestApkFromIndex,
  type AndroidApp,
  type RepoApk,
} from "@space/shared/androidRepo";
import { checkDue, DAY_MS, offerFor, type Offer } from "./decide";
import { classifyInstallSource, type InstallManager } from "./installSource";
import { onDownloadProgress, onInstallStatus, selfUpdateNative, type InstalledApp } from "./native";

/** Where the update stands. `permission` explains the "install unknown apps" screen before Android shows it. */
export type SelfUpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "permission" }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "installing" }
  | { kind: "error"; error: "network" | "integrity" | "install" };

export type SelfUpdateState = {
  app: AndroidApp | null;
  installed: InstalledApp | null;
  manager: InstallManager | null;
  newest: RepoApk | null;
  offer: Offer;
  /** Settings › "Update automatically": the answer to the consent step, then the switch. */
  autoUpdate: boolean;
  /**
   * A hand-installed app whose user has not answered the consent step yet (F-Droid Inclusion Policy §5): the step is
   * shown and nothing reaches the network until it is answered.
   */
  consentPending: boolean;
  /** When the last check finished (ms), 0 before the first. */
  lastCheck: number;
  /** The update dialog (prompt, permission, progress, error) is open. */
  open: boolean;
  phase: SelfUpdatePhase;
};

/** Native rejection codes of a check that failed (UpdateChecks.kt, SelfUpdateModule.kt), shown as the safety-check error. */
const INTEGRITY_ERRORS: Record<string, true> = {
  bad_signature: true,
  size_mismatch: true,
  hash_mismatch: true,
  not_an_apk: true,
  wrong_app: true,
  not_newer: true,
  wrong_signer: true,
};

let state: SelfUpdateState = {
  app: null,
  installed: null,
  manager: null,
  newest: null,
  offer: "none",
  autoUpdate: true,
  consentPending: false,
  lastCheck: 0,
  open: false,
  phase: { kind: "idle" },
};
let snoozedUntil = 0;
const listeners = new Set<() => void>();
let subscriptions: (EmitterSubscription | { remove: () => void } | null)[] = [];

const set = (next: Partial<SelfUpdateState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const autoUpdateKey = (app: AndroidApp) => `${app}.autoUpdate`;
const snoozeKey = (app: AndroidApp) => `${app}.selfUpdate.snoozedUntil`;
const consentKey = (app: AndroidApp) => `${app}.selfUpdate.consented`;

const recompute = () => {
  const { manager, installed, newest, autoUpdate } = state;
  if (!manager || !installed) return set({ offer: "none" });
  const offer = offerFor({
    manager,
    autoUpdate,
    installedVersionCode: installed.versionCode,
    installedSigners: installed.signers,
    newest,
    snoozedUntil,
    now: Date.now(),
  });
  set({ offer });
};

/** The newest APK in our signed repository: `entry.jar` checked against the pinned key, then the index it names. */
const fetchNewest = async (app: AndroidApp): Promise<RepoApk | null> => {
  const native = selfUpdateNative!;
  const index = indexFromEntry(await native.fetchRepoEntry(FDROID_REPO_URL, ANDROID_REPO_FINGERPRINT));
  if (!index) throw Object.assign(new Error("entry.json names no index"), { code: "bad_signature" });
  return newestApkFromIndex(JSON.parse(await native.fetchVerifiedText(index.url, index.sha256, index.size)), app);
};

/**
 * Checks for an update now. A store-managed install never reaches the network, nor any install before its user
 * answered the consent step. A check that finds a version to prompt for opens the dialog unless `quiet` (the Settings
 * button shows the result in place).
 */
export const checkForUpdate = async ({ quiet = false }: { quiet?: boolean } = {}) => {
  const { app, manager } = state;
  if (!app || !selfUpdateNative || manager === "managed" || state.consentPending || state.phase.kind === "checking") return;
  if (state.phase.kind === "downloading" || state.phase.kind === "installing" || state.phase.kind === "permission") return;
  set({ phase: { kind: "checking" } });
  try {
    const newest = await fetchNewest(app);
    set({ newest, lastCheck: Date.now(), phase: { kind: "idle" } });
    recompute();
    if (state.offer === "prompt" && !quiet) set({ open: true });
  } catch (error) {
    console.warn("[self-update] check failed", error);
    set({ lastCheck: Date.now(), phase: quiet ? { kind: "error", error: "network" } : { kind: "idle" } });
  }
};

/** Automatic checks: a hand install whose user said yes. An installer we don't know is checked only from Settings. */
const autoChecks = () => state.manager === "unmanaged" && state.autoUpdate && !state.consentPending;

/**
 * Called once from each app's root on Android: reads who installed the app and the saved settings, then (once the
 * consent step is answered yes) checks on launch and again whenever the app comes back to the foreground a day or
 * more after the last check. Never rejects: a native failure only leaves the update off.
 */
export const startSelfUpdate = async (app: AndroidApp) => {
  if (state.app || !selfUpdateNative) return;
  try {
    await start(app, selfUpdateNative);
  } catch (error) {
    console.warn("[self-update] start failed", error);
  }
};

const start = async (app: AndroidApp, native: NonNullable<typeof selfUpdateNative>) => {
  const [source, installed, savedAuto, savedSnooze, consented] = await Promise.all([
    native.getInstallSource(),
    native.getInstalledApp(),
    AsyncStorage.getItem(autoUpdateKey(app)),
    AsyncStorage.getItem(snoozeKey(app)),
    AsyncStorage.getItem(consentKey(app)),
  ]);
  const manager = classifyInstallSource(source, ANDROID_PACKAGE_NAMES[app]);
  console.info(`[self-update] installer=${source.installing} initiator=${source.initiating} -> ${manager}`);
  snoozedUntil = Number(savedSnooze) || 0;
  set({ app, installed, manager, autoUpdate: savedAuto !== "false", consentPending: manager === "unmanaged" && consented !== "1" });
  if (manager === "managed") return;
  subscriptions = [
    onDownloadProgress(({ received, total }) => {
      if (state.phase.kind === "downloading") set({ phase: { kind: "downloading", received, total } });
    }),
    onInstallStatus(({ status }) => {
      if (status === "confirm") set({ phase: { kind: "installing" } });
      // Cancelled in Android's own dialog: back to the offer, nothing to explain.
      else if (status === "aborted") set({ open: false, phase: { kind: "idle" } });
      else if (status === "failure") set({ phase: { kind: "error", error: "install" } });
    }),
    AppState.addEventListener("change", (appState) => {
      if (appState !== "active") return;
      if (state.phase.kind === "permission") void resumeAfterPermission();
      else if (autoChecks() && checkDue(state.lastCheck, Date.now())) void checkForUpdate();
    }),
  ];
  if (autoChecks()) await checkForUpdate();
};

/** Back from the system "install unknown apps" screen: go on when allowed, else keep explaining. */
const resumeAfterPermission = async () => {
  if (await selfUpdateNative?.canRequestPackageInstalls()) await download();
};

const download = async () => {
  const { newest } = state;
  const native = selfUpdateNative;
  if (!newest || !native) return;
  set({ open: true, phase: { kind: "downloading", received: 0, total: newest.size } });
  try {
    const path = await native.downloadApk(`${FDROID_REPO_URL}/${newest.apkName}`, newest.sha256, newest.size);
    set({ phase: { kind: "installing" } });
    await native.install(path);
  } catch (error) {
    // React Native rejects with an Error carrying the native code.
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
    console.warn("[self-update] update failed", code, error);
    if (code === "cancelled") set({ open: false, phase: { kind: "idle" } });
    else set({ phase: { kind: "error", error: INTEGRITY_ERRORS[code] === true ? "integrity" : code === "install_failed" ? "install" : "network" } });
  }
};

/** "Update": the permission explanation the first time, else straight to the download. */
export const startUpdate = async () => {
  const native = selfUpdateNative;
  if (!native || !state.newest || state.manager !== "unmanaged") return;
  if (await native.canRequestPackageInstalls()) return download();
  set({ open: true, phase: { kind: "permission" } });
};

/** "Continue" under the explanation: Android's own screen, or the installer asks itself where there is none (some TVs). */
export const openInstallPermission = async () => {
  if (!(await selfUpdateNative?.openInstallPermission())) await download();
};

/** "Later": no prompt for a day; Settings › About still offers the update. */
export const snoozeUpdate = async () => {
  snoozedUntil = Date.now() + DAY_MS;
  set({ open: false });
  recompute();
  if (state.app) await AsyncStorage.setItem(snoozeKey(state.app), String(snoozedUntil));
};

/** Closes the dialog (cancelling a download in progress). */
export const closeUpdateDialog = () => {
  if (state.phase.kind === "downloading") selfUpdateNative?.cancelDownload();
  set({ open: false, phase: { kind: "idle" } });
};

export const setAutoUpdate = async (autoUpdate: boolean) => {
  set({ autoUpdate });
  recompute();
  if (state.app) await AsyncStorage.setItem(autoUpdateKey(state.app), String(autoUpdate));
};

/** The consent step's answer (kept, so it is asked once): yes checks at once, no leaves the update to Settings. */
export const answerConsent = async (autoUpdate: boolean) => {
  if (!state.app) return;
  await AsyncStorage.setItem(consentKey(state.app), "1");
  set({ consentPending: false });
  await setAutoUpdate(autoUpdate);
  if (autoChecks()) await checkForUpdate();
};

/** For tests: forget everything. */
export const resetSelfUpdate = () => {
  for (const subscription of subscriptions) subscription?.remove();
  subscriptions = [];
  snoozedUntil = 0;
  state = { ...state, app: null, installed: null, manager: null, newest: null, offer: "none", autoUpdate: true, consentPending: false, lastCheck: 0, open: false, phase: { kind: "idle" } };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The update state, shared by the dialog and the Settings rows. */
export const useSelfUpdate = () => useSyncExternalStore(subscribe, () => state);
