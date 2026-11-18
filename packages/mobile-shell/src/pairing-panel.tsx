// A phone's "sign in by pairing" panel (ACCT-PAIR-01, REL-FAM-02): the phone shows a QR code and a short code that a
// signed-in app approves. Badger's QR sign-in page and Parrot's setup sign-in step both use it; each app only passes
// its pairing client, its completion and how its text and buttons look.
import React, { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import type { PairingClientCore } from "@space/pairing-crypto";
import { RATE_LIMIT_DEFAULT_MINUTES, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { useTranslation } from "./i18n";
import { formatCountdown } from "./pairing/countdown";
import type { PairingState } from "./pairing/controller";
import { usePairing, type UsePairingOptions } from "./pairing-hook";
import { QrCode } from "./pairing-qr";

/** How a line of the panel reads: `muted` for the steps and hints, `code` for the short code, `error` for a failure. */
export type MobilePairingTextTone = "body" | "muted" | "code" | "error";

export type MobilePairingPanelLook = {
  /** Draws one line of text in the app's own style. */
  Text: ComponentType<{ tone: MobilePairingTextTone; testID?: string; children: ReactNode }>;
  /** Draws the "Get a new code" button in the app's own style. */
  Button: ComponentType<{ label: string; onPress: () => void }>;
  /** Space between the panel's lines. */
  gap: number;
  /** Space between the lines of the code block (QR tile, short code, expiry, device name). */
  codeGap: number;
  /** White margin around the QR code. */
  qrPadding: number;
};

/** The apps whose phone shows this panel. */
export type MobilePairingApp = "badger" | "parrot";

export type MobilePairingPanelViewProps = MobilePairingPanelLook & {
  state: PairingState;
  restart: () => void;
  /** The current time in ms, ticked each second while a code is shown. */
  now: number;
  /** The name the approving app shows for this phone. */
  deviceName: string;
  /** An optional first line (Parrot's setup step heads the panel with one). */
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
export const MobilePairingPanelView = ({
  state,
  restart,
  now,
  deviceName,
  heading,
  app,
  testIDPrefix,
  purpose,
  Text,
  Button,
  gap,
  codeGap,
  qrPadding,
}: MobilePairingPanelViewProps) => {
  const { t } = useTranslation();
  const id = (suffix: string) => (testIDPrefix ? `${testIDPrefix}-${suffix}` : undefined);
  // A 429 says "Too many attempts. Try again in N minutes." with the API's wait (ACCT-AUTH-11).
  const rateLimitMinutes = (state.phase === "error" ? state.retryAfterMinutes : undefined) ?? RATE_LIMIT_DEFAULT_MINUTES;
  return (
    <View style={{ gap }}>
      {heading}
      <Text tone="muted">{t(`phonePairing.step1.${app}`)}</Text>
      <Text tone="muted">{t("phonePairing.step2")}</Text>
      <Text tone="muted">{t("phonePairing.step3")}</Text>
      {state.phase === "waiting" ? (
        <View style={{ alignItems: "center", gap: codeGap }}>
          <View style={{ backgroundColor: "#ffffff", padding: qrPadding, borderRadius: 12 }} testID={id("qr")}>
            <QrCode payload={state.request.qrPayload} size={200} label={t("phonePairing.qrAccessibility")} />
          </View>
          <Text tone="muted">{t("phonePairing.codeLabel")}</Text>
          <Text tone="code" testID={id("code")}>
            {state.request.shortCode}
          </Text>
          <Text tone="muted">{t("phonePairing.expiresIn", { time: formatCountdown(Math.max(0, state.expiresAtMs - now)) })}</Text>
          <Text tone="muted">{t("phonePairing.deviceName", { name: deviceName })}</Text>
        </View>
      ) : null}
      {state.phase === "idle" || state.phase === "starting" ? <Text tone="muted">{t("phonePairing.starting")}</Text> : null}
      {state.phase === "completing" || state.phase === "done" ? (
        <Text tone="muted">{t(purpose === "key" ? "phonePairing.completingKey" : "phonePairing.completing")}</Text>
      ) : null}
      {state.phase === "denied" || state.phase === "error" ? (
        <>
          <Text tone="error">
            {state.phase === "denied"
              ? t("phonePairing.denied")
              : state.reason === "rate_limited"
                ? t(TOO_MANY_ATTEMPTS_KEY, { count: rateLimitMinutes, minutes: rateLimitMinutes })
                : t(`phonePairing.errors.${state.reason}`)}
          </Text>
          <Button label={t("phonePairing.tryAgain")} onPress={restart} />
        </>
      ) : null}
    </View>
  );
};

export type MobilePairingPanelProps = MobilePairingPanelLook &
  Pick<MobilePairingPanelViewProps, "deviceName" | "heading" | "app" | "testIDPrefix" | "purpose"> & {
    /** Builds the app's pairing client; called once, on the first render. */
    createClient: () => PairingClientCore;
    complete: UsePairingOptions["complete"];
    logTag: string;
  };

/** Requests a code when it mounts, renews it, counts down its expiry and drops it when it unmounts. */
export const MobilePairingPanel = ({ createClient, complete, logTag, ...view }: MobilePairingPanelProps) => {
  const [client] = useState(createClient);
  const { state, restart } = usePairing({ client, complete, logTag });
  const expiresAtMs = state.phase === "waiting" ? state.expiresAtMs : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAtMs === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);
  return <MobilePairingPanelView state={state} restart={restart} now={now} {...view} />;
};
