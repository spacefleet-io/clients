/**
 * The phone's connectivity, read from the download engine's network state (`@space/mobile-media-proxy/downloads`, the
 * signal Parrot uses too):
 *   - `useNetworkOnline()` — React hook for connectivity state (OFFL-PLAY-03 greys what is not downloaded when false)
 *   - `onNetworkRecover(cb)` — subscribe to offline→online transitions only
 *
 * It replaced `@react-native-community/netinfo`, which the app never shipped: its require failed at runtime
 * ("networkListener.netinfo.unavailable"), so the phone always counted as online (phone test run, 2026-11-16).
 *
 * The recovery subscription fires *just once per transition* (so the consumer doesn't double-trigger reload), and only
 * after an offline state was seen — registering while already online does NOT fire on the next online notice.
 */
import { useSyncExternalStore } from "react";
import { getDeviceOnline, subscribeDeviceOnline } from "@space/mobile-media-proxy/downloads";

/** Watch `getNetworkOnline()`; the engine polls only while something subscribes. */
export const subscribeNetworkOnline = subscribeDeviceOnline;

export const getNetworkOnline = getDeviceOnline;

export const useNetworkOnline = (): boolean =>
  useSyncExternalStore(subscribeNetworkOnline, getNetworkOnline, getNetworkOnline);

type RecoverCallback = () => void;

/**
 * Fire `callback` exactly once when the network transitions from offline to online. Returns an unsubscribe function.
 * The listener does NOT fire on registration even if the device is already online — the caller must observe a real
 * offline→online transition. Without the native download engine the state stays online, so it never fires.
 */
export const onNetworkRecover = (callback: RecoverCallback): (() => void) => {
  let observedOffline = !getNetworkOnline();
  let done = false;
  const unsubscribe = subscribeNetworkOnline(() => {
    if (done) return;
    if (!getNetworkOnline()) {
      observedOffline = true;
      return;
    }
    if (observedOffline) {
      done = true;
      callback();
    }
  });
  return () => {
    done = true;
    unsubscribe();
  };
};
