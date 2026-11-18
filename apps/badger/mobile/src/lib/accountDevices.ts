/**
 * The account's signed-in devices (ACCT-DEV-01), shared by the phone's Settings sheet (`DevicesSection`) and the TV's
 * devices dialog (`TvSettingsScreen`): the list from `GET /devices`, sign-out through `POST /devices/revoke`, and the
 * labels each device shows (name, type, last seen).
 */
import { useCallback, useEffect, useState } from "react";
import { listDevices, revokeDevice, type Session } from "@space/shared/api";
import { getCurrentLanguage, translate } from "@space/mobile-shell/i18n";
import { subscribeDevicesChanged, subscribeNewDevice } from "./pairing/newDevice";
import { deviceTypeLabel, sessionDeviceType } from "@space/mobile-shell/pairing-approve";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("devices");

/** "Last seen: <date>" in the app's language, or "Last seen: unknown". */
export const formatLastSeen = (value: string | undefined): string => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return translate("account.devices.lastSeenUnknown");
  return translate("account.devices.lastSeen", { date: date.toLocaleString(getCurrentLanguage()) });
};

/** Name shown for a signed-in device: the name it gave itself, else its type. */
export const sessionDisplayName = (session: Session): string =>
  session.deviceName?.trim() || deviceTypeLabel(sessionDeviceType(session) ?? session.clientType ?? null);

/** "Phone · Last seen: …": the device's type and when it was last seen. */
export const sessionDetail = (session: Session): string => `${deviceTypeLabel(sessionDeviceType(session))} · ${formatLastSeen(session.lastSeen)}`;

export type AccountDevicesError = "load" | "revoke";

export type AccountDevices = {
  sessions: Session[];
  loading: boolean;
  error: AccountDevicesError | null;
  load: () => Promise<void>;
  /** Signs another device out; true when the API confirmed it (the row is then gone from `sessions`). */
  signOut: (session: Session) => Promise<boolean>;
};

/** Loads the list on mount and again when a new device joins the account. */
export const useAccountDevices = (token: string): AccountDevices => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AccountDevicesError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listDevices(token);
      log.info("list.ok", { count: result.sessions.length, current: result.sessions.filter((session) => session.current).length });
      setSessions(result.sessions);
    } catch (err) {
      log.warn("list.failed", { error: err instanceof Error ? err.message : String(err) });
      setError("load");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // A device that was just added, here or elsewhere, shows up without a manual refresh.
  useEffect(() => subscribeNewDevice(() => void load()), [load]);
  useEffect(() => subscribeDevicesChanged(() => void load()), [load]);

  const signOut = useCallback(
    async (session: Session) => {
      try {
        await revokeDevice(token, session.id);
        log.warn("sign_out.ok", { sessionId: session.id });
        setSessions((prev) => prev.filter((item) => item.id !== session.id));
        return true;
      } catch (err) {
        log.warn("sign_out.failed", { sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
        setError("revoke");
        return false;
      }
    },
    [token],
  );

  return { sessions, loading, error, load, signOut };
};
