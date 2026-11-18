import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "@space/shared/api";
import { bucketRelativeTime } from "@space/shared/format";
import { Button } from "@space/ui";
import { listDevices, revokeDevice } from "@/api";
import { useAuth } from "@/auth";
import { DEVICES_CHANGED_EVENT, deviceKind, sortDevices } from "@/lib/devices";
import { useSignOutWithKeyCheck } from "@/components/SignOutKeyCheck";
import { rendererLogger } from "@/logger";
import SettingListDialog from "../SettingListDialog";
import PairDeviceDialog from "../PairDeviceDialog";
import { SettingHint, SettingPanel, SettingRow } from "../kit";

const RELATIVE_KEY: Record<"seconds" | "minutes" | "hours" | "days", string> = {
  seconds: "account.storage.relativeSeconds",
  minutes: "account.storage.relativeMinutes",
  hours: "account.storage.relativeHours",
  days: "account.storage.relativeDays",
};

const log = rendererLogger.child({ scope: "devices-section" });

/**
 * ACCT-DEV-01: every device signed in to the account, with its type, name, last seen, and a sign-out button.
 * UX-LIST-01: the page shows one row (how many devices + this computer's name); the full list scrolls inside a dialog.
 */
export default function DevicesSection() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const { requestSignOut, dialog: signOutKeyCheckDialog } = useSignOutWithKeyCheck();
  const [devices, setDevices] = useState<Session[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [signingOutId, setSigningOutId] = useState<string | null>(null);
  const [signOutFailedId, setSignOutFailedId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadFailed(false);
    try {
      setDevices(sortDevices((await listDevices(token)).sessions));
    } catch (error) {
      log.warn({ err: error }, "could not load devices");
      setLoadFailed(true);
    }
  }, [token]);

  // Reload when the notifier sees a new device and whenever the window regains focus, so the list never goes stale.
  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(DEVICES_CHANGED_EVENT, reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener(DEVICES_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
    };
  }, [load]);

  const formatLastSeen = (iso: string | undefined): string => {
    const bucket = bucketRelativeTime(iso);
    if (!bucket) return t("account.devices.neverSeen");
    const when =
      bucket.unit === "just_now"
        ? t("account.storage.relativeJustNow")
        : t(RELATIVE_KEY[bucket.unit], { value: bucket.value });
    return t("account.devices.lastSeen", { when });
  };

  const signOut = async (device: Session) => {
    if (!token) return;
    setSigningOutId(device.id);
    setSignOutFailedId(null);
    try {
      if (device.current) {
        // Signing this computer out is the normal sign-out: it also forgets this device locally, so it asks first
        // whether the library key was saved when this computer holds it (ACCT-DEV-03).
        setListOpen(false);
        await requestSignOut();
        return;
      }
      await revokeDevice(token, device.id);
      log.info({ sessionId: device.id }, "device signed out");
      setDevices((current) => current?.filter((entry) => entry.id !== device.id) ?? current);
    } catch (error) {
      log.warn({ err: error, sessionId: device.id }, "could not sign device out");
      setSignOutFailedId(device.id);
    } finally {
      setSigningOutId(null);
    }
  };

  const thisDevice = devices?.find((device) => device.current);
  const thisDeviceName = thisDevice ? thisDevice.deviceName?.trim() || t("account.devices.unnamed") : null;

  return (
    <SettingPanel>
      <div className="grid gap-3" data-testid="devices-section">
        {devices === null && !loadFailed ? <SettingHint>{t("account.devices.loading")}</SettingHint> : null}

        {loadFailed ? (
          <div className="flex items-center gap-3">
            <SettingHint>{t("account.devices.loadError")}</SettingHint>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              {t("account.devices.retry")}
            </Button>
          </div>
        ) : null}

        {devices?.length === 0 ? <SettingHint>{t("account.devices.empty")}</SettingHint> : null}

        {devices && devices.length > 0 ? (
          <SettingRow
            title={t("account.devices.summary", { count: devices.length })}
            description={thisDeviceName ? t("account.devices.summaryThisDevice", { name: thisDeviceName }) : undefined}
            control={
              <Button type="button" variant="secondary" size="sm" onClick={() => setListOpen(true)}>
                {t("account.devices.viewAll")}
              </Button>
            }
          />
        ) : null}

        <SettingRow
          title={t("pairApprove.rowTitle")}
          description={t("pairApprove.rowDescription")}
          control={
            <Button type="button" variant="secondary" size="sm" data-testid="pair-approve-open" onClick={() => setPairOpen(true)}>
              {t("pairApprove.open")}
            </Button>
          }
        />
      </div>

      <SettingListDialog
        open={listOpen && (devices?.length ?? 0) > 0}
        onOpenChange={setListOpen}
        title={t("account.devices.title")}
        description={t("account.devices.subtitle")}
        testId="devices-dialog"
      >
        {(devices ?? []).map((device) => {
          const name = device.deviceName?.trim() || t("account.devices.unnamed");
          const busy = signingOutId === device.id;
          return (
            <div
              key={device.id}
              className="flex items-center justify-between gap-4 border-t border-border pt-3 first:border-t-0 first:pt-0"
              data-testid="device-row"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{name}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {t(`account.devices.type.${deviceKind(device)}`)}
                  </span>
                  {device.current ? (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                      {t("account.devices.thisDevice")}
                    </span>
                  ) : null}
                </div>
                <SettingHint>{formatLastSeen(device.lastSeen)}</SettingHint>
                {signOutFailedId === device.id ? (
                  <p className="text-xs text-destructive">{t("account.devices.signOutError")}</p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                title={t("account.devices.signOutHint", { name })}
                aria-label={`${t("account.devices.signOut")} — ${name}`}
                onClick={() => void signOut(device)}
              >
                {busy ? t("account.devices.signingOut") : t("account.devices.signOut")}
              </Button>
            </div>
          );
        })}
      </SettingListDialog>

      {/* Mounted only while open, so every opening starts from an empty code and the password never outlives it. */}
      {pairOpen ? <PairDeviceDialog open onOpenChange={setPairOpen} token={token} onApproved={() => void load()} /> : null}
      {signOutKeyCheckDialog}
    </SettingPanel>
  );
}
