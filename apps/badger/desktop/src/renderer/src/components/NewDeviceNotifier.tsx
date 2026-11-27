import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "@space/ui";
import { getMe, listDevices } from "@/api";
import { useAuth } from "@/auth";
import { shouldClearSessionFromAuthError } from "@/authSession";
import { shouldLogoutAfterAuthProbe } from "@/lib/authGuards";
import { isAppWindowHidden, subscribeAppWindowVisibility } from "@/lib/appWindowVisibility";
import { announceNewDevices, DEVICES_CHANGED_EVENT, deviceKind, forgetKnownDeviceIds } from "@/lib/devices";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "new-device-notifier" });

export const NEW_DEVICE_POLL_INTERVAL_MS = 60_000;
/** UX-NOTICE-01: same fixed time as the phone and TV notice (`NOTICE_DURATION_MS` in @space/mobile-shell/notice-queue). */
export const NEW_DEVICE_NOTICE_DURATION_MS = 8_000;
/** Where the notice's action leads: Settings, "Your devices" (ACCT-DEV-01). */
export const DEVICES_SETTINGS_PATH = "/settings?section=devices";

/**
 * ACCT-PAIR-03: while signed in, checks the account's devices every minute and toasts each newly added one. UX-NOTICE-01:
 * the toast floats over the top-right corner (the shared `Notifications` Toaster), never in the page; it leaves after a
 * fixed time, on its close cross, or when its action opens the device list. The device is recorded as seen when announced.
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
          const id = `new-device-${device.id}`;
          showing.add(device.id);
          const ended = () => showing.delete(device.id);
          toast(t("account.devices.newDevice", { name, type }), {
            id,
            duration: NEW_DEVICE_NOTICE_DURATION_MS,
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
          });
        });
        if (fresh.length > 0) window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      } catch (error) {
        log.warn({ err: error }, "device check failed");
        if (!shouldClearSessionFromAuthError(error) || signingOut) return;
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
      for (const sessionId of unseen) toast.dismiss(`new-device-${sessionId}`);
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
