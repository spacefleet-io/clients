// "Sign in with another device" (UX-PHONE-10, ACCT-SIGNIN-04): the one page Badger's and Parrot's phones show to sign
// in by pairing (ACCT-PAIR-01). Each app passes only its name, its pairing client, its completion and where Back goes;
// the mascot and the accent come from the app's theme. Built to the mockup Chris approved on 2026-11-18.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, RefreshCw } from "lucide-react-native";
import { RATE_LIMIT_DEFAULT_MINUTES, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { MobileAuthButton } from "./components/mobile-auth-form";
import MobileAppBackdrop from "./components/mobile-app-backdrop";
import { MobileBottomSheet, useMobileSheetClose } from "./components/mobile-bottom-sheet";
import { useTranslation } from "./i18n";
import { scopeLogger } from "./logger";
import { formatCountdown } from "./pairing/countdown";
import { PairingCheckCode } from "./pairing/check-code";
import type { PairingState } from "./pairing/controller";
import { usePairingPanel, type MobilePairingApp, type MobilePairingPanelProps } from "./pairing-panel";
import { QrCode } from "./pairing-qr";
import { SHORT_CODE_PAGE_PADDING, ShortCodeTiles } from "./short-code";
import { useMobileShellTheme } from "./theme";

const log = scopeLogger("pair-sign-in");

const QR_TILE = 232;
const QR_PADDING = 18;

/** `#rrggbb` at `opacity` (0..1) as `#rrggbbaa`. */
const withAlpha = (hex: string, opacity: number) =>
  `${hex.slice(0, 7)}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** A translated line whose `**…**` parts are bold and white (the help sheet's app and menu names). */
const Marked = ({ text, style, strongColor }: { text: string; style: object; strongColor: string }) => (
  <Text style={style}>
    {text.split("**").map((part, index) =>
      index % 2 === 1 ? (
        <Text key={index} style={{ fontWeight: "600", color: strongColor }}>
          {part}
        </Text>
      ) : (
        part
      ),
    )}
  </Text>
);

/** The waiting dot: the accent dot with a ring that keeps pulsing out while the code waits for its approval. */
const PulsingDot = ({ color }: { color: string }) => {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.ease) }), -1, false);
  }, [pulse]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - pulse.value), transform: [{ scale: 1 + pulse.value * 0.6 }] }));
  return (
    <View style={styles.dotBox} testID="pair-sign-in-dot">
      <Animated.View style={[styles.dotRing, { borderColor: color }, ring]} />
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
};

/** The help sheet's body: the three steps, this phone's name and how often the code changes, and "Got it". */
const HelpSheetBody = ({ app, deviceName, lifetimeMs }: { app: MobilePairingApp; deviceName: string; lifetimeMs: number | null }) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const close = useMobileSheetClose();
  const steps = [t(`phonePairing.signIn.step1.${app}`), t("phonePairing.signIn.step2"), t("phonePairing.signIn.step3")];
  const minutes = lifetimeMs === null ? null : Math.max(1, Math.round(lifetimeMs / 60_000));
  const sans = theme.font.family.sans;
  return (
    <View testID="pair-sign-in-help-sheet">
      <Text style={[styles.sheetTitle, { color: theme.colors.text, fontFamily: theme.font.family.display }]} accessibilityRole="header">
        {t("phonePairing.signIn.help")}
      </Text>
      <View style={styles.steps}>
        {steps.map((step, index) => (
          <View key={index} style={styles.step}>
            <View style={[styles.stepNumber, { backgroundColor: theme.colors.accentSoft }]}>
              <Text style={[styles.stepNumberText, { color: theme.colors.accent, fontFamily: sans }]}>{index + 1}</Text>
            </View>
            <Marked text={step} style={[styles.stepText, { color: theme.colors.text, fontFamily: sans }]} strongColor="#ffffff" />
          </View>
        ))}
      </View>
      <View style={[styles.note, { backgroundColor: withAlpha(theme.colors.bg, 0.6) }]} testID="pair-sign-in-note">
        <Marked
          // The name never breaks across lines (no-break spaces), so it stays with its quotes, e.g. French « Badger (LE2123) ».
          text={[t("phonePairing.signIn.deviceName", { name: deviceName.replace(/ /g, "\u00A0") }), minutes === null ? "" : t("phonePairing.signIn.renews", { count: minutes })]
            .filter(Boolean)
            .join(" ")}
          style={[styles.noteText, { color: theme.colors.textMuted, fontFamily: sans }]}
          strongColor="#ffffff"
        />
      </View>
      <Pressable
        testID="pair-sign-in-help-ok"
        accessibilityRole="button"
        onPress={() => close()}
        style={[styles.ok, { backgroundColor: theme.colors.accent }]}
      >
        <Text style={[styles.okText, { color: theme.accentTextHex, fontFamily: sans }]}>{t("phonePairing.signIn.gotIt")}</Text>
      </Pressable>
    </View>
  );
};

export type MobilePairSignInViewProps = {
  app: MobilePairingApp;
  state: PairingState;
  restart: () => void;
  /** The current time in ms, ticked each second while a code is shown. */
  now: number;
  /** How long the shown code lives from its arrival; null when it does not expire. Drives the countdown bar. */
  lifetimeMs: number | null;
  /** The name the approving app shows for this phone. */
  deviceName: string;
  /** Back (the top row and Android's Back): to the email and password form, or the setup step before. */
  onBack: () => void;
};

/** The page for a given pairing state; stateless so it can be checked phase by phase. */
export const MobilePairSignInView = ({ app, state, restart, now, lifetimeMs, deviceName, onBack }: MobilePairSignInViewProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      log.info("back", { app, via: "hardware" });
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, app]);
  const { colors } = theme;
  const sans = theme.font.family.sans;
  const waiting = state.phase === "waiting" ? state : null;
  const remainingMs = waiting ? Math.max(0, waiting.expiresAtMs - now) : 0;
  const fraction = waiting && lifetimeMs !== null ? Math.min(1, remainingMs / lifetimeMs) : null;
  // ACCT-PAIR-01: the code in two groups of 4 boxes, never a dash (Chris 2026-11-18).
  const code = waiting?.request.shortCode ?? "";
  const failed = state.phase === "denied" || state.phase === "error";
  // A 429 says "Too many attempts. Try again in N minutes." with the API's wait (ACCT-AUTH-11).
  const rateLimitMinutes = (state.phase === "error" ? state.retryAfterMinutes : undefined) ?? RATE_LIMIT_DEFAULT_MINUTES;
  const status =
    state.phase === "waiting"
      ? t("phonePairing.signIn.waiting")
      : state.phase === "completing" || state.phase === "done"
        ? t("phonePairing.completing")
        : t("phonePairing.starting");
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: colors.bg }]} edges={["top", "left", "right"]} testID="pair-sign-in">
      <MobileAppBackdrop />
      <View style={styles.top}>
        <Pressable
          testID="pair-sign-in-back"
          accessibilityRole="button"
          accessibilityLabel={t("setup.back")}
          onPress={() => {
            log.info("back", { app, via: "button" });
            onBack();
          }}
          hitSlop={12}
          style={styles.back}
        >
          <ChevronLeft size={20} strokeWidth={2.6} color={colors.accent} />
          <Text style={[styles.backText, { color: colors.accent, fontFamily: sans }]}>{t("setup.back")}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={[styles.main, { paddingBottom: Math.max(insets.bottom, 34) + 72 }]}>
        <Image source={theme.mascotSource} style={styles.mascot} resizeMode="contain" accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { color: colors.text, fontFamily: theme.font.family.display }]} accessibilityRole="header">
          {t("login.pairing.title")}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textMuted, fontFamily: sans }]}>{t("phonePairing.signIn.subtitle")}</Text>
        {failed ? (
          <View style={styles.failure}>
            <Text style={[styles.error, { color: colors.danger, fontFamily: sans }]} accessibilityRole="alert" testID="pair-sign-in-error">
              {state.phase === "denied"
                ? t("phonePairing.denied")
                : state.reason === "rate_limited"
                  ? t(TOO_MANY_ATTEMPTS_KEY, { count: rateLimitMinutes, minutes: rateLimitMinutes })
                  : t(`phonePairing.errors.${state.reason}`)}
            </Text>
            <MobileAuthButton label={t("phonePairing.tryAgain")} onPress={restart} testID="pair-sign-in-retry" />
          </View>
        ) : (
          <>
            <View
              style={[
                styles.qrRing,
                { backgroundColor: withAlpha(colors.accent, 0.55), shadowColor: colors.accent },
              ]}
            >
              <View style={styles.qrTile} testID="pair-sign-in-qr">
                {waiting ? (
                  <QrCode payload={waiting.request.qrPayload} size={QR_TILE - QR_PADDING * 2} label={t("phonePairing.qrAccessibility")} />
                ) : (
                  <ActivityIndicator color={colors.bg} />
                )}
              </View>
            </View>
            <View style={styles.or} accessibilityElementsHidden={!waiting}>
              <View style={[styles.orLine, { backgroundColor: colors.border }]} />
              <Text style={[styles.orText, { color: colors.textDim, fontFamily: sans }]}>{t("phonePairing.signIn.orTypeCode").toUpperCase()}</Text>
              <View style={[styles.orLine, { backgroundColor: colors.border }]} />
            </View>
            <ShortCodeTiles code={code} testID="pair-sign-in-code" style={styles.code} />
            {waiting?.checkCode ? <PairingCheckCode checkCode={waiting.checkCode} testID="pair-sign-in-check-code" /> : null}
            <View style={styles.wait}>
              {waiting ? <PulsingDot color={colors.accent} /> : null}
              <Text style={[styles.waitText, { color: colors.text, fontFamily: sans }]} testID="pair-sign-in-status">
                {status}
              </Text>
            </View>
            {waiting && fraction !== null ? (
              <View style={styles.expiry} testID="pair-sign-in-expiry">
                <View style={[styles.bar, { backgroundColor: colors.surface }]}>
                  <View testID="pair-sign-in-bar" style={[styles.barFill, { backgroundColor: colors.accent, width: `${fraction * 100}%` }]} />
                </View>
                <View style={styles.expiryRow}>
                  <RefreshCw size={14} strokeWidth={2.2} color={colors.textDim} />
                  <Text style={[styles.expiryText, { color: colors.textDim, fontFamily: sans }]}>
                    {t("phonePairing.signIn.newCodeIn", { time: formatCountdown(remainingMs) })}
                  </Text>
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      <View style={[styles.helpRow, { bottom: Math.max(insets.bottom, 34) }]} pointerEvents="box-none">
        <Pressable
          testID="pair-sign-in-help"
          accessibilityRole="button"
          onPress={() => {
            log.info("help", { app });
            setHelpOpen(true);
          }}
          style={[styles.help, { borderColor: colors.border, backgroundColor: withAlpha(colors.surface, 0.7) }]}
        >
          <View style={[styles.helpMark, { backgroundColor: colors.accent }]}>
            <Text style={[styles.helpMarkText, { color: colors.bg, fontFamily: sans }]}>?</Text>
          </View>
          <Text style={[styles.helpText, { color: colors.text, fontFamily: sans }]}>{t("phonePairing.signIn.help")}</Text>
        </Pressable>
      </View>
      <MobileBottomSheet visible={helpOpen} onClose={() => setHelpOpen(false)} testID="pair-sign-in-help-modal">
        <HelpSheetBody app={app} deviceName={deviceName} lifetimeMs={lifetimeMs} />
      </MobileBottomSheet>
    </SafeAreaView>
  );
};

export type MobilePairSignInProps = Pick<MobilePairingPanelProps, "app" | "createClient" | "complete" | "logTag" | "deviceName"> & {
  onBack: () => void;
};

/** The page with its live pairing: requests a code on mount, renews it, counts it down and drops it on unmount. */
export const MobilePairSignIn = ({ createClient, complete, logTag, ...view }: MobilePairSignInProps) => {
  const { state, restart, now, lifetimeMs } = usePairingPanel({ createClient, complete, logTag });
  return <MobilePairSignInView state={state} restart={restart} now={now} lifetimeMs={lifetimeMs} {...view} />;
};

const styles = StyleSheet.create({
  page: { flex: 1 },
  top: { height: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 20 },
  back: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontSize: 17, fontWeight: "600" },
  main: { alignItems: "center", paddingHorizontal: SHORT_CODE_PAGE_PADDING, paddingTop: 6 },
  mascot: { width: 52, height: 52 },
  title: { marginTop: 10, fontSize: 24, lineHeight: 29, fontWeight: "600", letterSpacing: -0.2, textAlign: "center" },
  subtitle: { marginTop: 8, fontSize: 15, lineHeight: 21, maxWidth: 300, textAlign: "center" },
  qrRing: {
    marginTop: 24 - 4,
    padding: 4,
    borderRadius: 30,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.45,
    shadowRadius: 25,
  },
  qrTile: {
    width: QR_TILE,
    height: QR_TILE,
    padding: QR_PADDING,
    borderRadius: 26,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  or: { marginTop: 22 - 4, flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch" },
  orLine: { flex: 1, height: 1 },
  orText: { fontSize: 12, fontWeight: "600", letterSpacing: 1.6 },
  code: { marginTop: 12 },
  wait: { marginTop: 22, flexDirection: "row", alignItems: "center", gap: 10 },
  waitText: { fontSize: 15, fontWeight: "500" },
  dotBox: { width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotRing: { position: "absolute", width: 22, height: 22, borderRadius: 11, borderWidth: 2 },
  expiry: { marginTop: 14, width: QR_TILE },
  bar: { height: 4, borderRadius: 4, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  expiryRow: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  expiryText: { fontSize: 13 },
  failure: { marginTop: 24, alignSelf: "stretch", gap: 16 },
  error: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  helpRow: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  help: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, borderWidth: 1 },
  helpMark: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  helpMarkText: { fontSize: 14, fontWeight: "700" },
  helpText: { fontSize: 15, fontWeight: "500" },
  sheetTitle: { fontSize: 22, fontWeight: "600" },
  steps: { marginTop: 20, gap: 18 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  stepNumber: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  stepNumberText: { fontSize: 15, fontWeight: "700" },
  stepText: { flex: 1, fontSize: 16, lineHeight: 23 },
  note: { marginTop: 22, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14 },
  noteText: { fontSize: 14, lineHeight: 20 },
  ok: { marginTop: 22, height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  okText: { fontSize: 17, fontWeight: "600" },
});
