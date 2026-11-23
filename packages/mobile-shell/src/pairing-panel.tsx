// A phone's "sign in by pairing" panel (ACCT-PAIR-01, REL-FAM-02): the phone shows a QR code and a short code that a
// signed-in app approves. One look for Badger and Parrot (UX-PHONE-05): each app passes only its name, its pairing
// client and its completion; the accent comes from the app's theme. The phones' "Sign in with another device" page is
// `MobilePairSignIn` (./pair-sign-in, UX-PHONE-10); this panel serves the key screens.
import React, { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PairingClientCore } from "@space/pairing-crypto";
import { RATE_LIMIT_DEFAULT_MINUTES, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { MobileAuthButton } from "./components/mobile-auth-form";
import { useTranslation } from "./i18n";
import { formatCountdown } from "./pairing/countdown";
import { PairingCheckCode } from "./pairing/check-code";
import type { PairingState } from "./pairing/controller";
import { usePairing, type UsePairingOptions } from "./pairing-hook";
import { QrCode } from "./pairing-qr";
import { ShortCodeTiles } from "./short-code";
import { useMobileShellTheme } from "./theme";

/** How a line of the panel reads: `muted` for the steps and hints, `code` for the short code, `error` for a failure. */
export type MobilePairingTextTone = "body" | "muted" | "code" | "error";

/** One line of the panel, centred like its QR tile; the short code is large, spaced and selectable. */
export const MobilePairingText = ({ tone, testID, children }: { tone: MobilePairingTextTone; testID?: string; children: ReactNode }) => {
  const theme = useMobileShellTheme();
  const color = tone === "error" ? theme.colors.danger : tone === "muted" ? theme.colors.textMuted : theme.colors.text;
  return (
    <Text
      style={[tone === "code" ? styles.code : styles.body, { color }]}
      testID={testID}
      selectable={tone === "code"}
      accessibilityRole={tone === "error" ? "alert" : undefined}
    >
      {children}
    </Text>
  );
};

/** "Get a new code": the app's accent button. */
export const MobilePairingButton = ({ label, onPress }: { label: string; onPress: () => void }) => <MobileAuthButton label={label} onPress={onPress} />;

/** The apps whose phone shows this panel. */
export type MobilePairingApp = "badger" | "parrot";

export type MobilePairingPanelViewProps = {
  state: PairingState;
  restart: () => void;
  /** The current time in ms, ticked each second while a code is shown. */
  now: number;
  /** The name the approving app shows for this phone. */
  deviceName: string;
  /** An optional first line (the key screens head the panel with one). */
  heading?: ReactNode;
  /**
   * The app showing the code: its first step names the apps that can approve it. Only Badger has a TV app, so only
   * Badger's text names the TV.
   */
  app: MobilePairingApp;
  /** testID prefix: `<prefix>-qr` and `<prefix>-code` mark the QR tile and the short code. */
  testIDPrefix?: string;
  /** `key`: the device is signed in and asks only for the library key (its key screen, ACCT-PAIR-01). */
  purpose?: "sign_in" | "key";
};

/** The panel for a given pairing state; stateless so it can be checked phase by phase. */
export const MobilePairingPanelView = ({ state, restart, now, deviceName, heading, app, testIDPrefix, purpose }: MobilePairingPanelViewProps) => {
  const { t } = useTranslation();
  const id = (suffix: string) => (testIDPrefix ? `${testIDPrefix}-${suffix}` : undefined);
  // A 429 says "Too many attempts. Try again in N minutes." with the API's wait (ACCT-AUTH-11).
  const rateLimitMinutes = (state.phase === "error" ? state.retryAfterMinutes : undefined) ?? RATE_LIMIT_DEFAULT_MINUTES;
  return (
    <View style={styles.panel}>
      {heading}
      <MobilePairingText tone="muted">{t(`phonePairing.step1.${app}`)}</MobilePairingText>
      <MobilePairingText tone="muted">{t("phonePairing.step2")}</MobilePairingText>
      <MobilePairingText tone="muted">{t("phonePairing.step3")}</MobilePairingText>
      {state.phase === "waiting" ? (
        <View style={styles.codeBlock}>
          <View style={styles.qrTile} testID={id("qr")}>
            <QrCode payload={state.request.qrPayload} size={200} label={t("phonePairing.qrAccessibility")} />
          </View>
          <MobilePairingText tone="muted">{t("phonePairing.codeLabel")}</MobilePairingText>
          {/* ACCT-PAIR-01: two groups of 4 boxes, never a dash (Chris 2026-11-18). */}
          <ShortCodeTiles code={state.request.shortCode} testID={id("code")} />
          {state.checkCode ? <PairingCheckCode checkCode={state.checkCode} testID={id("check-code") ?? "pairing-check-code"} /> : null}
          <MobilePairingText tone="muted">
            {t("phonePairing.expiresIn", { time: formatCountdown(Math.max(0, state.expiresAtMs - now)) })}
          </MobilePairingText>
          <MobilePairingText tone="muted">{t("phonePairing.deviceName", { name: deviceName })}</MobilePairingText>
        </View>
      ) : null}
      {state.phase === "idle" || state.phase === "starting" ? <MobilePairingText tone="muted">{t("phonePairing.starting")}</MobilePairingText> : null}
      {state.phase === "completing" || state.phase === "done" ? (
        <MobilePairingText tone="muted">{t(purpose === "key" ? "phonePairing.completingKey" : "phonePairing.completing")}</MobilePairingText>
      ) : null}
      {state.phase === "denied" || state.phase === "error" ? (
        <>
          <MobilePairingText tone="error">
            {state.phase === "denied"
              ? t("phonePairing.denied")
              : state.reason === "rate_limited"
                ? t(TOO_MANY_ATTEMPTS_KEY, { count: rateLimitMinutes, minutes: rateLimitMinutes })
                : t(`phonePairing.errors.${state.reason}`)}
          </MobilePairingText>
          <MobilePairingButton label={t("phonePairing.tryAgain")} onPress={restart} />
        </>
      ) : null}
    </View>
  );
};

export type MobilePairingPanelProps = Pick<MobilePairingPanelViewProps, "deviceName" | "heading" | "app" | "testIDPrefix" | "purpose"> & {
  /** Builds the app's pairing client; called once, on the first render. */
  createClient: () => PairingClientCore;
  complete: UsePairingOptions["complete"];
  logTag: string;
};

export type UsePairingPanelOptions = Pick<MobilePairingPanelProps, "createClient" | "complete" | "logTag">;

/**
 * Requests a code on mount, renews it and drops it on unmount, and ticks `now` each second while a code is shown.
 * `lifetimeMs` is how long the shown code lives from the moment it arrived (the sign-in page's countdown bar).
 */
export const usePairingPanel = ({ createClient, complete, logTag }: UsePairingPanelOptions) => {
  const [client] = useState(createClient);
  const { state, restart } = usePairing({ client, complete, logTag });
  const expiresAtMs = state.phase === "waiting" ? state.expiresAtMs : null;
  const [now, setNow] = useState(() => Date.now());
  const [lifetimeMs, setLifetimeMs] = useState<number | null>(null);
  useEffect(() => {
    if (expiresAtMs === null) return undefined;
    const arrived = Date.now();
    setNow(arrived);
    setLifetimeMs(Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - arrived) : null);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);
  return { state, restart, now, lifetimeMs };
};

/** Requests a code when it mounts, renews it, counts down its expiry and drops it when it unmounts. */
export const MobilePairingPanel = ({ createClient, complete, logTag, ...view }: MobilePairingPanelProps) => {
  const { state, restart, now } = usePairingPanel({ createClient, complete, logTag });
  return <MobilePairingPanelView state={state} restart={restart} now={now} {...view} />;
};

const styles = StyleSheet.create({
  panel: { gap: 10, alignSelf: "stretch" },
  codeBlock: { alignItems: "center", gap: 8 },
  qrTile: { backgroundColor: "#ffffff", padding: 12, borderRadius: 12 },
  body: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  code: { fontSize: 24, fontWeight: "800", letterSpacing: 3, textAlign: "center" },
});
