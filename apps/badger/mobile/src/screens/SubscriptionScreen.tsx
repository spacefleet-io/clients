import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import {
  getAccountStorage,
  getSubscription,
  type AccountStorageSummary,
} from "@space/shared/api";
import type { AccountAccess } from "@space/shared/accountAccess";
import { getCurrentLanguage, translate, useTranslation } from "@space/mobile-shell/i18n";
import { MobileFounderBadge } from "@space/mobile-shell/components";
import { formatLocalizedStorage, formatLocalizedStorageUsage, storageUsedPercent } from "@space/shared/format";
import { useAuth } from "../store/auth";
import { IconButton } from "../components/IconButton";
import { RIPPLE } from "../components/PosterCard";
import { SkeletonBlock, SkeletonPulse } from "../components/Skeleton";
import { SettingsGroup } from "../components/SettingsRows";
import { theme } from "../theme/theme";

type SubscriptionState = {
  plan: string;
  /** `null` = unlimited (admin, ACCT-PLAN-14). */
  storageLimitGb: number | null;
  paidUntil?: string | null;
  access?: AccountAccess;
};

/** Evaluated at render (not module load) so the unit, the decimal mark and the date format follow the UI language. */
const BOUNDS = { minUnit: "MB", maxUnit: "GB" } as const;
const formatBytes = (bytes: number) => formatLocalizedStorage(bytes, getCurrentLanguage(), BOUNDS);

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(getCurrentLanguage()) : null;

const accessLabel = (state: string | undefined) => {
  if (state === "paid") return translate("subscription.status.active");
  if (state === "unpaid") return translate("subscription.status.expired");
  return translate("subscription.status.free");
};

const warningColor = (level: AccountStorageSummary["warningLevel"]) => {
  if (level === "blocked") return theme.colors.danger;
  if (level === "warning") return theme.colors.warning;
  return theme.colors.accent;
};

const Line = ({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) => (
  <View style={styles.line}>
    <Text style={styles.lineLabel}>{label}</Text>
    <Text style={[styles.lineValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
  </View>
);

/** Read-only account status: plan, access state and storage. Never takes payment or links to it (ACCT-PAY-02). */
export const SubscriptionScreen = () => {
  const { t } = useTranslation();
  const { token } = useAuth();
  const navigation = useNavigation();
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [storage, setStorage] = useState<AccountStorageSummary | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
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

  const goBack = useCallback(() => navigation.goBack(), [navigation]);
  // ACCT-PLAN-14: an admin account has no plan, no billing state and unlimited storage.
  const unlimited = subscription?.storageLimitGb === null || storage?.limitBytes === null;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("subscription.back")} onPress={goBack}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <Text style={styles.title} accessibilityRole="header">
          {t("subscription.title")}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loading && !subscription ? (
          <SkeletonPulse style={styles.skeleton}>
            <SkeletonBlock width="100%" height={110} radius={16} />
            <SkeletonBlock width="100%" height={130} radius={16} />
          </SkeletonPulse>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{t("subscription.loadError")}</Text>
            <Pressable
              style={styles.retry}
              onPress={() => void load()}
              android_ripple={RIPPLE}
              accessibilityRole="button"
              accessibilityLabel={t("subscription.retry")}
            >
              <Text style={styles.retryText}>{t("subscription.retry")}</Text>
            </Pressable>
          </View>
        ) : null}

        {subscription && unlimited ? (
          <SettingsGroup title={t("subscription.plan.group")}>
            <View style={styles.card}>
              <Line label={t("subscription.plan.plan")} value={t("subscription.plan.adminUnlimited")} />
            </View>
          </SettingsGroup>
        ) : subscription ? (
          <SettingsGroup title={t("subscription.plan.group")}>
            <View style={styles.card}>
              {/* The plan's name ("Free", "Standard"…), never its id; an id this build does not know shows as is. */}
              <Line
                label={t("subscription.plan.plan")}
                value={t(`subscription.planName.${subscription.plan}`, { defaultValue: subscription.plan })}
              />
              {/* WAIT-FOUND-04: a founder's plan says the discount is on it (no price here: ACCT-PAY-02). */}
              <MobileFounderBadge showPriceLabel />
              <Line
                label={t("subscription.plan.status")}
                value={accessLabel(subscription.access?.state)}
                valueColor={subscription.access?.state === "unpaid" ? theme.colors.danger : undefined}
              />
              {subscription.paidUntil ? (
                <Line
                  label={
                    subscription.access?.state === "unpaid"
                      ? t("subscription.plan.endedOn")
                      : t("subscription.plan.renewsOn")
                  }
                  value={formatDate(subscription.paidUntil) ?? ""}
                />
              ) : null}
              {subscription.access?.state === "unpaid" && subscription.access.wipeAt ? (
                <Text style={styles.warning}>
                  {t("subscription.plan.wipeWarning", { date: formatDate(subscription.access.wipeAt) })}
                </Text>
              ) : null}
              {storage && storage.storageAddonCount > 0 ? (
                <Line label={t("subscription.plan.storageAddons")} value={`+${storage.storageAddonCount}`} />
              ) : null}
            </View>
          </SettingsGroup>
        ) : null}

        {storage && storage.limitBytes === null ? (
          <SettingsGroup title={t("subscription.storage.group")}>
            <View style={styles.card}>
              <Line label={t("subscription.storage.used")} value={formatBytes(storage.usedBytes)} />
              {storage.reservedBytes > 0 ? (
                <Text style={styles.hint}>
                  {t("subscription.storage.reserved", { size: formatBytes(storage.reservedBytes) })}
                </Text>
              ) : null}
              {storage.apps.map((app) => (
                <Line key={app.appId} label={app.label} value={formatBytes(app.usedBytes)} />
              ))}
            </View>
          </SettingsGroup>
        ) : storage && storage.limitBytes !== null ? (
          <SettingsGroup title={t("subscription.storage.group")}>
            <View style={styles.card}>
              <Line
                label={t("subscription.storage.used")}
                // Used against the limit: never reads equal (or reversed) when the bytes differ, e.g. 1 MB short of the limit (STOR-UNIT-01).
                value={t("subscription.storage.usedOf", formatLocalizedStorageUsage(storage.usedBytes, storage.limitBytes, getCurrentLanguage(), BOUNDS))}
              />
              <View
                style={styles.track}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: storage.limitBytes === null ? 0 : storageUsedPercent(storage.usedBytes, storage.limitBytes) }}
              >
                <View
                  style={[
                    styles.fill,
                    { width: `${Math.min(100, storage.usageRatio * 100)}%`, backgroundColor: warningColor(storage.warningLevel) },
                  ]}
                />
              </View>
              {storage.warningLevel === "warning" ? (
                <Text style={styles.warning}>{t("subscription.storage.gettingFull")}</Text>
              ) : null}
              {storage.warningLevel === "blocked" ? (
                <Text style={[styles.warning, { color: theme.colors.danger }]}>
                  {t("subscription.storage.full")}
                </Text>
              ) : null}
              {storage.reservedBytes > 0 ? (
                <Text style={styles.hint}>
                  {t("subscription.storage.reserved", { size: formatBytes(storage.reservedBytes) })}
                </Text>
              ) : null}
              {storage.apps.map((app) => (
                <Line key={app.appId} label={app.label} value={formatBytes(app.usedBytes)} />
              ))}
            </View>
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  content: { paddingTop: 8, paddingBottom: 24, gap: 20 },
  skeleton: { gap: 16 },
  card: { padding: 16, gap: 10 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 24, gap: 12 },
  lineLabel: { fontSize: 13, color: theme.colors.textMuted },
  lineValue: { fontSize: 14, fontWeight: "700", color: theme.colors.text, flexShrink: 1, textAlign: "right" },
  track: { height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised },
  fill: { height: "100%" },
  warning: { fontSize: 12, lineHeight: 16, color: theme.colors.warning },
  hint: { fontSize: 12, lineHeight: 16, color: theme.colors.textDim },
  errorBox: {
    padding: 16,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.surface,
  },
  errorText: { fontSize: 14, color: theme.colors.text },
  retry: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceRaised,
    overflow: "hidden",
  },
  retryText: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
});
