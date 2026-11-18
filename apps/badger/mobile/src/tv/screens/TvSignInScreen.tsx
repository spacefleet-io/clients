import React, { useEffect, useRef, useState } from "react";
import { BackHandler, Image, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Globe, Mail } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { RATE_LIMIT_DEFAULT_MINUTES, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import { LoginScreen } from "../../screens/LoginScreen";
import { QrCode } from "@space/mobile-shell/pairing-qr";
import { formatCountdown, type PairingState } from "@space/mobile-shell/pairing";
import { useTvPairing } from "../lib/useTvPairing";
import { useTvMenuKeyHold } from "../lib/useTvMenuKey";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { getTvSetup, saveTvSetup } from "../lib/tvSetupStore";
// From the files, not the `../ui` index, which also pulls in the sky and the poster cards.
import { TV_COLOR, TV_FONT, TV_TYPE, tvCardStyle } from "../ui/tokens";
import { TvBody, TvTitle } from "../ui/TvText";
import { TvIconButton, TvPillButton } from "../ui/TvPillButton";

const log = scopeLogger("tv.signin");
const MASCOT = require("../../assets/mascot.webp");

/** Side of the QR code in design dp (mockup 300 px at 1920x1080), drawn at the TV's scale (UX-TV-13). */
export const TV_SIGN_IN_QR = 150;

/** Milliseconds left, refreshed once a second while a code is on screen. */
const useRemainingMs = (expiresAtMs: number | null): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);
  return expiresAtMs === null || !Number.isFinite(expiresAtMs) ? null : expiresAtMs - now;
};

/** How much of the code's life is left (1 when it appears, 0 when it renews): the time left over the time it had when it appeared. */
const useLifeLeft = (requestId: string | null, remainingMs: number | null): number => {
  const first = useRef<{ requestId: string; ms: number } | null>(null);
  if (requestId === null || remainingMs === null) return 0;
  if (first.current?.requestId !== requestId) first.current = { requestId, ms: Math.max(1, remainingMs) };
  return Math.min(1, Math.max(0, remainingMs / first.current.ms));
};

/** A small amber ring that empties as the code ages (mockup `.ring`, 30 px). */
const CodeLifeRing = ({ left }: { left: number }) => {
  const scale = useTvScale();
  const size = 15 * scale;
  const stroke = 3 * scale;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  return (
    <Svg width={size} height={size} testID="tv-pairing-code-life" accessible={false}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={TV_COLOR.secondary} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={TV_COLOR.amber}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={`${length * left} ${length}`}
        // From twelve o'clock, emptying clockwise.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
};

/** The short code with an amber dash between its two halves (mockup `KQ7M-X2PD`). */
const ShortCode = ({ code }: { code: string }) => {
  const styles = useTvStyles(baseStyles);
  const dash = code.indexOf("-");
  return (
    <Text testID="tv-pairing-short-code" numberOfLines={1} adjustsFontSizeToFit style={styles.code}>
      {dash > 0 ? (
        <>
          {code.slice(0, dash)}
          <Text style={styles.codeDash}>-</Text>
          {code.slice(dash + 1)}
        </>
      ) : (
        code
      )}
    </Text>
  );
};

/** Back to "Choose your language" (UX-TV-31): the step's Next brings the sign-in back. */
const openLanguageStep = () => {
  const progress = getTvSetup();
  if (!progress) return;
  log.info("language.reopen");
  void saveTvSetup({ ...progress, step: "language" });
};

/**
 * The TV's sign-in (UX-TV-31, ACCT-PAIR-01): the badger, the title and one line, then one card with the QR code and,
 * past a divider, the short code, its renewal and the TV's name; "Use email and password instead" under the card,
 * where the remote starts. The language button alone at the top right reopens the language step. When a code is
 * being fetched, completes, was declined or failed, the card says so, with "Get a new code" next to the password.
 */
export const TvSignInView = ({
  state,
  onRetry,
  onUsePassword,
  onLanguage = openLanguageStep,
}: {
  state: PairingState;
  onRetry: () => void;
  onUsePassword: () => void;
  onLanguage?: () => void;
}) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const waiting = state.phase === "waiting" ? state : null;
  const remainingMs = useRemainingMs(waiting ? waiting.expiresAtMs : null);
  const lifeLeft = useLifeLeft(waiting ? waiting.request.requestId : null, remainingMs);
  const failed = state.phase === "denied" || state.phase === "error";

  let card: React.ReactNode;
  if (waiting) {
    card = (
      <View style={[tvCardStyle, styles.pair]} testID="tv-pairing-card">
        <View style={styles.qrSide}>
          <View style={styles.qrFrame}>
            <QrCode payload={waiting.request.qrPayload} size={TV_SIGN_IN_QR * scale} label={t("tvPairing.signIn.qrAccessibility")} />
          </View>
          <TvBody muted style={styles.label}>
            {t("tvPairing.signIn.scanWithPhone")}
          </TvBody>
        </View>
        <View style={styles.divider} />
        <View style={styles.codeSide}>
          <TvBody muted style={[styles.label, styles.codeLabel]}>
            {t("tvPairing.signIn.codeLabel")}
          </TvBody>
          <ShortCode code={waiting.request.shortCode} />
          <View style={styles.timer}>
            <CodeLifeRing left={lifeLeft} />
            <TvBody muted style={styles.timerText} testID="tv-pairing-countdown">
              {t("tvPairing.signIn.codeRenews", { time: remainingMs !== null ? formatCountdown(remainingMs) : "" })}
            </TvBody>
          </View>
          <TvBody muted style={styles.deviceName} testID="tv-pairing-device-name">
            {t("tvPairing.signIn.deviceName", { name: waiting.request.deviceName })}
          </TvBody>
        </View>
      </View>
    );
  } else if (failed) {
    // A 429 says "Too many attempts. Try again in N minutes." with the API's wait (ACCT-AUTH-11).
    const minutes = (state.phase === "error" ? state.retryAfterMinutes : undefined) ?? RATE_LIMIT_DEFAULT_MINUTES;
    const detail =
      state.phase === "denied"
        ? t("tvPairing.signIn.denied.detail")
        : state.reason === "rate_limited"
          ? t(TOO_MANY_ATTEMPTS_KEY, { count: minutes, minutes })
          : t(`tvPairing.signIn.errors.${state.reason}`);
    card = (
      <View style={[tvCardStyle, styles.message]} testID="tv-pairing-card">
        <TvTitle testID="tv-pairing-failure" style={styles.failTitle}>
          {state.phase === "denied" ? t("tvPairing.signIn.denied.title") : t("tvPairing.signIn.errors.title")}
        </TvTitle>
        <TvBody muted style={styles.messageText}>
          {detail}
        </TvBody>
      </View>
    );
  } else {
    card = (
      <View style={[tvCardStyle, styles.message]} testID="tv-pairing-card">
        <TvBody muted testID="tv-pairing-progress" style={styles.messageText}>
          {state.phase === "completing" || state.phase === "done" ? t("tvPairing.signIn.completing") : t("tvPairing.signIn.starting")}
        </TvBody>
      </View>
    );
  }

  return (
    <View style={styles.screen} testID="tv-signin">
      <View style={styles.column}>
        {/* The Badger floats free over the sky; no logo or name at the top left (Chris 2026-11-09). */}
        <Image source={MASCOT} style={styles.mascot} resizeMode="contain" accessible={false} testID="tv-pairing-mascot" />
        <TvTitle size="hero" style={styles.title}>
          {t("tvPairing.signIn.title")}
        </TvTitle>
        <TvBody muted style={styles.subtitle}>
          {t("tvPairing.signIn.subtitle")}
        </TvBody>
        {card}
        <View style={styles.actions}>
          {failed ? <TvPillButton testID="tv-pairing-retry" variant="primary" hasTVPreferredFocus label={t("tvPairing.signIn.tryAgain")} onPress={onRetry} /> : null}
          <TvPillButton
            testID="tv-pairing-use-password"
            hasTVPreferredFocus={!failed}
            icon={Mail}
            label={t("tvPairing.signIn.usePassword")}
            onPress={onUsePassword}
          />
        </View>
      </View>
      <TvIconButton testID="tv-pairing-language" icon={Globe} accessibilityLabel={t("shell.language")} onPress={onLanguage} style={styles.language} />
    </View>
  );
};

/** Owns one pairing request: asks for the code on mount, cancels it on unmount (also when switching to password). */
const TvPairingPane = ({ onUsePassword }: { onUsePassword: () => void }) => {
  const { state, restart } = useTvPairing();
  return <TvSignInView state={state} onRetry={restart} onUsePassword={onUsePassword} />;
};

/**
 * Sign-in on a TV (ACCT-PAIR-01): a QR code and a short code that any signed-in SpaceBadger app approves; the
 * TV then holds the account session and library key without anyone typing on the remote. The password form
 * stays one focusable button away.
 */
export const TvSignInScreen = () => {
  const { t } = useTranslation();
  const [passwordMode, setPasswordMode] = useState(false);

  useEffect(() => {
    console.info("[tv-signin] mode", { passwordMode });
  }, [passwordMode]);

  // Back on the password form returns to the code (not out of the app); on the code screen it keeps its default.
  useEffect(() => {
    if (!passwordMode) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      console.info("[tv-signin] back from the password form: showing the code again");
      setPasswordMode(false);
      return true;
    });
    return () => sub.remove();
  }, [passwordMode]);
  // Apple TV: Menu reaches the handler above only while the key is held; on the code screen (first screen) the system keeps it.
  useTvMenuKeyHold("tv-signin-password", passwordMode);
  const styles = useTvStyles(baseStyles);

  if (passwordMode) {
    return (
      <View style={styles.flex}>
        <LoginScreen />
        <View style={styles.floating}>
          <TvPillButton testID="tv-pairing-use-code" label={t("tvPairing.signIn.useCode")} onPress={() => setPasswordMode(false)} />
        </View>
      </View>
    );
  }
  return (
    <TvPairingPane
      onUsePassword={() => {
        console.info("[tv-signin] password form requested");
        setPasswordMode(true);
      }}
    />
  );
};

/** Sizes in design dp: the approved mockup (`tv-signin.html`, 1920x1080 px) halved, scaled with the TV (UX-TV-13). */
const baseStyles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1 },
  column: { flex: 1, alignItems: "center", paddingTop: 30 },
  mascot: { width: 70, height: 70 },
  title: { marginTop: 8, fontSize: 32, lineHeight: 38 },
  subtitle: { marginTop: 6, maxWidth: 560, textAlign: "center", fontSize: 12.5, lineHeight: 17.5 },
  pair: { marginTop: 20, flexDirection: "row", alignItems: "stretch", overflow: "hidden" },
  qrSide: { paddingVertical: 20, paddingHorizontal: 28, alignItems: "center", justifyContent: "center" },
  qrFrame: { padding: 9, backgroundColor: "#ffffff", borderRadius: 9 },
  divider: { width: 0.75, backgroundColor: TV_COLOR.borderSoft },
  codeSide: { paddingVertical: 20, paddingHorizontal: 40, alignItems: "center", justifyContent: "center" },
  label: { marginTop: 11, fontSize: 11, lineHeight: 15 },
  codeLabel: { marginTop: 0, marginBottom: 10 },
  code: { fontFamily: TV_FONT.display, fontSize: 48, lineHeight: 52, fontWeight: "700", letterSpacing: 3.8, color: TV_COLOR.text },
  codeDash: { color: TV_COLOR.amber },
  timer: { marginTop: 13, flexDirection: "row", alignItems: "center", gap: 6 },
  timerText: { fontSize: 10.5, lineHeight: 14 },
  deviceName: { marginTop: 5, fontSize: 10, lineHeight: 14 },
  message: { marginTop: 20, width: 520, paddingVertical: 24, paddingHorizontal: 28, alignItems: "center", gap: 8 },
  failTitle: { color: TV_COLOR.danger, textAlign: "center" },
  messageText: { ...TV_TYPE.body, color: TV_COLOR.muted, textAlign: "center" },
  actions: { marginTop: 20, flexDirection: "row", gap: 12 },
  language: { position: "absolute", top: 28, right: 36 },
  // Top left, over the password form: at the top right it covered the language and settings buttons (UX-TV-16).
  floating: { position: "absolute", top: 32, left: 48 },
});
