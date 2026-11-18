/**
 * "Even out volume" on the desktop (PAR-PLAY-03 item 2): off by default, kept on this computer per account. The player
 * and Settings read it through `useEvenVolume`, so a change in Settings applies to the playing song at once.
 */
import { useSyncExternalStore } from "react";
import { parrotEvenVolumeStorageKey, parseParrotEvenVolume, type ParrotEvenVolume } from "@space/parrot-core";

const listeners = new Set<() => void>();
// One parsed value per stored string, so the store hands React the same object until the setting changes.
let cached: { raw: string | null; value: ParrotEvenVolume } | null = null;

const read = (userId: string): ParrotEvenVolume => {
  const raw = globalThis.localStorage?.getItem(parrotEvenVolumeStorageKey(userId)) ?? null;
  if (!cached || cached.raw !== raw) cached = { raw, value: parseParrotEvenVolume(raw) };
  return cached.value;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const setEvenVolume = (userId: string, setting: ParrotEvenVolume) => {
  globalThis.localStorage?.setItem(parrotEvenVolumeStorageKey(userId), JSON.stringify(setting));
  console.info(`[even-volume] ${setting.on ? `on, ${setting.level}` : "off"}`);
  for (const listener of listeners) listener();
};

export const useEvenVolume = (userId: string): ParrotEvenVolume => useSyncExternalStore(subscribe, () => read(userId));
