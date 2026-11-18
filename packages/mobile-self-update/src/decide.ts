import type { RepoApk } from "@space/shared/androidRepo";
import type { InstallManager } from "./installSource";

/** REL-UPD-06: one day between checks while the app stays open, and the "Later" snooze. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the app does with the newest APK in our repository:
 * - `prompt`: ask "Badger 0.1.10 is available. Update?" (Update / Later);
 * - `offer`: no prompt, but Settings › About shows the new version with an Update button;
 * - `info`: Settings › About only says a new version exists (an installer we don't know may update the app);
 * - `none`: nothing to show (managed by a store, already current, or an APK this install cannot take).
 */
export type Offer = "prompt" | "offer" | "info" | "none";

export type OfferInput = {
  manager: InstallManager;
  /** The Settings switch "Update automatically" (on by default). */
  autoUpdate: boolean;
  installedVersionCode: number;
  /** Certificate SHA-256s of the installed app. */
  installedSigners: readonly string[];
  newest: RepoApk | null;
  /** Until when "Later" holds the prompt back (ms since epoch), 0 for never. */
  snoozedUntil: number;
  now: number;
};

/** Same certificates, as sets (Android installs an update only over the same signers). Empty never matches. */
export const sameSigners = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a.map((hex) => hex.toLowerCase()));
  const right = new Set(b.map((hex) => hex.toLowerCase()));
  return left.size > 0 && left.size === right.size && [...left].every((hex) => right.has(hex));
};

export const offerFor = ({ manager, autoUpdate, installedVersionCode, installedSigners, newest, snoozedUntil, now }: OfferInput): Offer => {
  // A store or updater app keeps the app current: never compete with it.
  if (manager === "managed" || !newest || newest.versionCode <= installedVersionCode) return "none";
  // A build signed with another key (a developer build) could never take the update.
  if (!sameSigners(newest.signers, installedSigners)) return "none";
  if (manager === "unknown") return "info";
  return autoUpdate && now >= snoozedUntil ? "prompt" : "offer";
};

/** A check is due on each launch (`lastCheck` 0) and then once a day. */
export const checkDue = (lastCheck: number, now: number) => lastCheck === 0 || now - lastCheck >= DAY_MS;
