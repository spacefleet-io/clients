import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getAccountStorage, getSubscription, type AccountStorageSummary, type SubscriptionSummary } from "@space/shared/api";
import { formatLocalizedStorage, formatLocalizedStorageUsage, storageUsedPercent } from "@space/shared/format";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { useMobileShellTheme, type MobileShellTheme } from "../theme";
import { MobileFounderBadge } from "./mobile-founder";

/** How the app draws a titled group of rows: Badger's `SettingsGroup`, Parrot's Settings section. */
export type MobileAccountPlanGroup = React.ComponentType<{ title: string; children: React.ReactNode }>;

export type MobileAccountPlanPanelProps = {
  token: string;
  Group: MobileAccountPlanGroup;
  /** Shown while the first load runs (Badger's skeleton); nothing by default. */
  placeholder?: React.ReactNode;
};

/** Evaluated at render (not module load) so the unit, the decimal mark and the date format follow the UI language. */
const BOUNDS = { minUnit: "MB", maxUnit: "GB" } as const;
const formatBytes = (bytes: number) => formatLocalizedStorage(bytes, getCurrentLanguage(), BOUNDS);
const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(getCurrentLanguage()) : null);

const warningColor = (colors: MobileShellTheme["colors"], level: AccountStorageSummary["warningLevel"]) => {
  if (level === "blocked") return colors.danger;
  if (level === "warning") return colors.warning;
  return colors.accent;
};

const Line = ({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) => {
  const { colors } = useMobileShellTheme();
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.lineValue, { color: valueColor ?? colors.text }]}>{value}</Text>
    </View>
  );
};

/**
 * The account's plan, its access state and its storage, read only: it never takes payment or points to it
 * (ACCT-PAY-02). An admin has no plan and unlimited storage (ACCT-PLAN-14); storage is one total and one line per app
 * (STOR-USE-01). Badger's Subscription screen and Parrot's Settings show this same panel (REL-FAM-03).
 */
export const MobileAccountPlanPanel = ({ token, Group, placeholder = null }: MobileAccountPlanPanelProps) => {
  const { t } = useTranslation();
  const { colors } = useMobileShellTheme();
  const [subscription, setSubscription] = useState<SubscriptionSummary | null>(null);
  const [storage, setStorage] = useState<AccountStorageSummary | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [sub, store] = await Promise.all([getSubscription(token), getAccountStorage(token)]);
      setSubscription(sub);
      setStorage(store);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // ACCT-PLAN-14: an admin account has no plan, no billing state and unlimited storage.
  const unlimited = subscription?.storageLimitGb === null || storage?.limitBytes === null;
  const state = subscription?.access?.state;
  const status =
    state === "paid"
      ? t("subscription.status.active")
      : state === "unpaid"
        ? t("subscription.status.expired")
        : t("subscription.status.free");
  const appLines = (summary: AccountStorageSummary) =>
    summary.apps.map((app) => <Line key={app.appId} label={app.label} value={formatBytes(app.usedBytes)} />);
  const reserved = (summary: AccountStorageSummary) =>
    summary.reservedBytes > 0 ? (
      <Text style={[styles.hint, { color: colors.textDim }]}>
        {t("subscription.storage.reserved", { size: formatBytes(summary.reservedBytes) })}
      </Text>
    ) : null;

  return (
    <>
      {loading && !subscription ? placeholder : null}

      {error ? (
        <View style={[styles.errorBox, { borderColor: colors.danger, backgroundColor: colors.surface }]}>
          <Text style={[styles.errorText, { color: colors.text }]}>{t("subscription.loadError")}</Text>
          <Pressable
            style={[styles.retry, { backgroundColor: colors.surfaceRaised }]}
            onPress={() => void load()}
            android_ripple={{ color: "rgba(219, 223, 240, 0.16)", foreground: true }}
            accessibilityRole="button"
            accessibilityLabel={t("subscription.retry")}
          >
            <Text style={[styles.retryText, { color: colors.text }]}>{t("subscription.retry")}</Text>
          </Pressable>
        </View>
      ) : null}

      {subscription ? (
        <Group title={t("subscription.plan.group")}>
          <View style={styles.body} testID="account-plan">
            {unlimited ? (
              <Line label={t("subscription.plan.plan")} value={t("subscription.plan.adminUnlimited")} />
            ) : (
              <>
                {/* The plan's name ("Free", "Standard"…), never its id; an id this build does not know shows as is. */}
                <Line
                  label={t("subscription.plan.plan")}
                  value={t(`subscription.planName.${subscription.plan}`, { defaultValue: subscription.plan })}
                />
                {/* WAIT-FOUND-04: a founder's plan says the discount is on it (no price here: ACCT-PAY-02). */}
                <MobileFounderBadge showPriceLabel />
                <Line
                  label={t("subscription.plan.status")}
                  value={status}
                  valueColor={state === "unpaid" ? colors.danger : undefined}
                />
                {subscription.paidUntil ? (
                  <Line
                    label={state === "unpaid" ? t("subscription.plan.endedOn") : t("subscription.plan.renewsOn")}
                    value={formatDate(subscription.paidUntil) ?? ""}
                  />
                ) : null}
                {state === "unpaid" && subscription.access?.wipeAt ? (
                  <Text style={[styles.warning, { color: colors.warning }]}>
                    {t("subscription.plan.wipeWarning", { date: formatDate(subscription.access.wipeAt) })}
                  </Text>
                ) : null}
                {storage && storage.storageAddonCount > 0 ? (
                  <Line label={t("subscription.plan.storageAddons")} value={`+${storage.storageAddonCount}`} />
                ) : null}
              </>
            )}
          </View>
        </Group>
      ) : null}

      {storage ? (
        <Group title={t("subscription.storage.group")}>
          {storage.limitBytes === null ? (
            <View style={styles.body} testID="account-storage">
              <Line label={t("subscription.storage.used")} value={formatBytes(storage.usedBytes)} />
              {reserved(storage)}
              {appLines(storage)}
            </View>
          ) : (
            <View style={styles.body} testID="account-storage">
              <Line
                label={t("subscription.storage.used")}
                // Used against the limit: never reads equal (or reversed) when the bytes differ, e.g. 1 MB short of the limit (STOR-UNIT-01).
                value={t(
                  "subscription.storage.usedOf",
                  formatLocalizedStorageUsage(storage.usedBytes, storage.limitBytes, getCurrentLanguage(), BOUNDS)
                )}
              />
              <View
                style={[styles.track, { backgroundColor: colors.surfaceRaised }]}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: storageUsedPercent(storage.usedBytes, storage.limitBytes) }}
              >
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${Math.min(100, storage.usageRatio * 100)}%`,
                      backgroundColor: warningColor(colors, storage.warningLevel),
                    },
                  ]}
                />
              </View>
              {storage.warningLevel === "warning" ? (
                <Text style={[styles.warning, { color: colors.warning }]}>{t("subscription.storage.gettingFull")}</Text>
              ) : null}
              {storage.warningLevel === "blocked" ? (
                <Text style={[styles.warning, { color: colors.danger }]}>{t("subscription.storage.full")}</Text>
              ) : null}
              {reserved(storage)}
              {appLines(storage)}
            </View>
          )}
        </Group>
      ) : null}
    </>
  );
};

const styles = StyleSheet.create({
  body: { gap: 10 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 24, gap: 12 },
  lineLabel: { fontSize: 13 },
  lineValue: { fontSize: 14, fontWeight: "700", flexShrink: 1, textAlign: "right" },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%" },
  warning: { fontSize: 12, lineHeight: 16 },
  hint: { fontSize: 12, lineHeight: 16 },
  errorBox: { padding: 16, gap: 12, borderRadius: 16, borderWidth: 1 },
  errorText: { fontSize: 14 },
  retry: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  retryText: { fontSize: 14, fontWeight: "700" },
});
