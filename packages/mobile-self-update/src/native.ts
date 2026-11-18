import { NativeEventEmitter, NativeModules, type EmitterSubscription } from "react-native";
import type { InstallSource } from "./installSource";

export type InstalledApp = { packageName: string; versionName: string; versionCode: number; signers: string[] };
export type InstallStatus = { status: "confirm" | "success" | "failure" | "aborted"; message: string | null };

type SelfUpdateNative = {
  getInstallSource: () => Promise<InstallSource>;
  getInstalledApp: () => Promise<InstalledApp>;
  fetchRepoEntry: (repoUrl: string, fingerprint: string) => Promise<string>;
  fetchVerifiedText: (url: string, sha256: string, size: number) => Promise<string>;
  downloadApk: (url: string, sha256: string, size: number) => Promise<string>;
  cancelDownload: () => void;
  canRequestPackageInstalls: () => Promise<boolean>;
  openInstallPermission: () => Promise<boolean>;
  install: (path: string) => Promise<void>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

/** The native module (SelfUpdateModule.kt); undefined where it is not linked (iOS, a JS test). */
export const selfUpdateNative = NativeModules.SelfUpdate as SelfUpdateNative | undefined;

type SelfUpdateEvents = {
  selfUpdateProgress: [{ received: number; total: number }];
  selfUpdateStatus: [InstallStatus];
};

const emitter = selfUpdateNative ? new NativeEventEmitter<SelfUpdateEvents>(selfUpdateNative as never) : null;

export const onDownloadProgress = (listener: (progress: { received: number; total: number }) => void): EmitterSubscription | null =>
  emitter?.addListener("selfUpdateProgress", listener) ?? null;

export const onInstallStatus = (listener: (status: InstallStatus) => void): EmitterSubscription | null =>
  emitter?.addListener("selfUpdateStatus", listener) ?? null;
