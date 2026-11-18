/**
 * "Even out volume" on the phone (PAR-PLAY-03 item 2): off by default, kept on this phone per account (AsyncStorage
 * `parrot.evenVolume.<userId>`, never synced). The session loads the signed-in account's answer; Settings changes it
 * and the playing queue follows at once (`./playback`).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parrotEvenVolumeStorageKey, parseParrotEvenVolume, PARROT_EVEN_VOLUME_DEFAULT, type ParrotEvenVolume } from "@space/parrot-core";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("even-volume");

let userId: string | null = null;
let setting: ParrotEvenVolume = PARROT_EVEN_VOLUME_DEFAULT;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** The signed-in account's setting as last read or set; off while nobody is signed in. */
export const getEvenVolume = (): ParrotEvenVolume => setting;

export const subscribeEvenVolume = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reads `account`'s setting (null: signed out, back to the default). */
export const loadEvenVolume = async (account: string | null): Promise<ParrotEvenVolume> => {
  userId = account;
  const next = account ? parseParrotEvenVolume(await AsyncStorage.getItem(parrotEvenVolumeStorageKey(account))) : PARROT_EVEN_VOLUME_DEFAULT;
  // A later sign-in may have replaced the account while this one was being read.
  if (userId !== account) return setting;
  setting = next;
  log.info("loaded", { on: setting.on, level: setting.level });
  notify();
  return setting;
};

/** Stores the signed-in account's choice; the playing queue's gains follow at once. */
export const setEvenVolume = async (next: ParrotEvenVolume): Promise<void> => {
  setting = next;
  notify();
  log.info("changed", { on: next.on, level: next.level });
  if (userId) await AsyncStorage.setItem(parrotEvenVolumeStorageKey(userId), JSON.stringify(next));
};
