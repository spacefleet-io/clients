import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "@space/ui";
import { notify } from "@/lib/notify";
import { getMe, listDevices } from "@/api";
import { useAuth } from "@/auth";
import { isSessionRejected } from "@space/shared/api";
import { shouldLogoutAfterAuthProbe } from "@/lib/authGuards";
import { isAppWindowHidden, subscribeAppWindowVisibility } from "@/lib/appWindowVisibility";
import { announceNewDevices, DEVICES_CHANGED_EVENT, deviceKind, forgetKnownDeviceIds } from "@/lib/devices";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "new-device-notifier" });

export const NEW_DEVICE_POLL_INTERVAL_MS = 60_000;
/** The notice's key: one per device, so a second announcement of it replaces the first (UX-NOTICE-11). */
export const newDeviceNoticeKey = (sessionId: string) => `new-device-${sessionId}`;
/** Where the notice's action leads: Settings, "Your devices" (ACCT-DEV-01). */
export const DEVICES_SETTINGS_PATH = "/settings?section=devices";

/**
 * ACCT-PAIR-03: while signed in, checks the account's devices every minute and announces each newly added one. UX-NOTICE-01:
 * the toast floats over the top-right corner (the shared `Notifications` Toaster), never in the page; it leaves after the
 * shared heads-up time (UX-NOTICE-03), on its close cross, or when its action opens the device list, and stays in the bell
 * as an account notice (UX-NOTICE-04). The device is recorded as seen when announced.
 * While the app window is hidden (the player plays in external mpv, or the app sits in the tray) nobody can see a toast:
 * the check waits and runs when the window shows again, and a toast still up when the window hides is taken back and
 * the device forgotten, so it is announced again once the window is back.
 */
export default function NewDeviceNotifier() {
  const { t } = useTranslation();
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();
  // Stable across renders, like `logout` below, so the check effect does not restart.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const userId = user?.id;
  // `logout` is a new function every render; a ref keeps the check effect from restarting each time.
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  useEffect(() => {
    if (!token || !userId) return;
    let cancelled = false;
    let signingOut = false;
    // Toasts on screen now, by session id; they leave this set however they end.
    const showing = new Set<string>();
    const check = async () => {
      if (isAppWindowHidden()) {
        log.info({}, "device check skipped: app window hidden");
        return;
      }
      try {
        const { sessions } = await listDevices(token);
        if (cancelled || isAppWindowHidden()) return;
        const fresh = announceNewDevices(userId, sessions, (device) => {
          const name = device.deviceName?.trim() || t("account.devices.unnamed");
          const type = t(`account.devices.type.${deviceKind(device)}`);
          log.info({ sessionId: device.id, type }, "new device added to the account");
          const id = newDeviceNoticeKey(device.id);
          showing.add(device.id);
          const ended = () => showing.delete(device.id);
          notify({
            key: id,
            kind: "headsUp",
            scope: "account",
            title: { key: "notify.account.newDevice" },
            message: { key: "account.devices.newDevice", vars: { name, type } },
            // The bell entry's button leads to the device list too (UX-NOTICE-11).
            action: { label: { key: "account.devices.newDeviceOpen" }, target: DEVICES_SETTINGS_PATH },
            toastOptions: {
              onAutoClose: ended,
              onDismiss: ended,
              action: {
                label: t("account.devices.newDeviceOpen"),
                onClick: () => {
                  log.info({ sessionId: device.id }, "new device notice opened");
                  ended();
                  toast.dismiss(id);
                  navigateRef.current(DEVICES_SETTINGS_PATH);
                },
              },
            },
          });
        });
        if (fresh.length > 0) window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      } catch (error) {
        log.warn({ err: error }, "device check failed");
        if (!isSessionRejected(error) || signingOut) return;
        // Refused: this computer's session was probably signed out from another device. Confirm with the same
        // probe the rest of the app uses, then take the same sign-out path. Any other failure is retried next tick.
        signingOut = true;
        try {
          if (await shouldLogoutAfterAuthProbe({ probe: () => getMe(token), attempts: 2, delayMs: 300 })) {
            log.warn({}, "this computer was signed out from another device");
            await logoutRef.current("sessionRejected");
          }
        } finally {
          signingOut = false;
        }
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), NEW_DEVICE_POLL_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const stopWatchingWindow = subscribeAppWindowVisibility(({ hidden, reason }) => {
      if (!hidden) {
        void check();
        return;
      }
      if (showing.size === 0) return;
      const unseen = [...showing];
      showing.clear();
      log.info({ sessionIds: unseen, reason }, "app window hidden over new device notices: taken back unseen");
      forgetKnownDeviceIds(userId, unseen);
      for (const sessionId of unseen) toast.dismiss(newDeviceNoticeKey(sessionId));
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      stopWatchingWindow();
    };
  }, [token, userId, t]);

  return null;
}
