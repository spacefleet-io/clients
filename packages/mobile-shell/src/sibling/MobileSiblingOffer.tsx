import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { PairingClientCore, PairingPoll } from "@space/pairing-crypto";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import type { PairingCompletion } from "../pairing/completion";
import { abortableSleep } from "../pairing/sleep";
import { createSiblingSignInController, type SiblingSignInController, type SiblingSignInState } from "./controller";
import { SIBLING_APP_ICONS, SIBLING_APP_NAMES } from "./icons";
import { getSiblingStatus, requestSiblingApproval, type SiblingStatus } from "./native";

type SiblingApp = "badger" | "parrot";

export type MobileSiblingOfferViewProps = {
  /** The sister app that signs this one in. */
  other: SiblingApp;
  email: string;
  state: SiblingSignInState;
  onContinue: () => void;
  onCancel: () => void;
  onOtherAccount: () => void;
};

/**
 * ACCT-PAIR-07, the asking phone app's sign-in screen, above the form: "Continue with your {Other} account" with the
 * sister's real icon, styled like the "Sign in with another device" card (MobilePhoneSignInCard). While the sister app
 * asks, the same card waits with Cancel; a failure leaves only "{Other} could not sign you in. Sign in another way."
 */
export const MobileSiblingOfferView = ({ other, email, state, onContinue, onCancel, onOtherAccount }: MobileSiblingOfferViewProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const name = SIBLING_APP_NAMES[other];
  if (state.phase === "done") return null;
  if (state.phase === "failed") {
    return (
      <Text testID="sibling-failure" style={[styles.failure, { color: theme.colors.danger }]}>
        {t("sibling.failure", { other: name })}
      </Text>
    );
  }
  const waiting = state.phase !== "idle";
  return (
    <View
      testID={waiting ? "sibling-waiting" : "sibling-offer"}
      style={[styles.card, { borderColor: `${theme.colors.accent}99`, backgroundColor: `${theme.colors.accent}17` }]}
    >
      <View style={styles.head}>
        <Image source={SIBLING_APP_ICONS[other]} style={styles.icon} accessibilityIgnoresInvertColors />
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {waiting ? t("sibling.waiting", { other: name }) : t("sibling.title", { other: name })}
          </Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>
            {waiting ? t("sibling.waitingNote", { other: name }) : t("sibling.body", { other: name })}
          </Text>
        </View>
      </View>
      {state.phase === "waiting" ? (
        <Pressable testID="sibling-cancel" onPress={onCancel} accessibilityRole="button" style={[styles.secondary, { borderColor: `${theme.colors.accent}66` }]}>
          <Text style={[styles.secondaryLabel, { color: theme.colors.text }]}>{t("sibling.cancel")}</Text>
        </Pressable>
      ) : null}
      {waiting ? null : (
        <>
          <Pressable testID="sibling-continue" onPress={onContinue} accessibilityRole="button" style={[styles.primary, { backgroundColor: theme.colors.accent }]}>
            <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.primaryLabel, { color: theme.accentTextHex }]}>
              {t("sibling.button", { email })}
            </Text>
          </Pressable>
          <Pressable testID="sibling-other-account" onPress={onOtherAccount} accessibilityRole="button" style={styles.link}>
            <Text style={[styles.linkLabel, { color: theme.colors.textMuted }]}>{t("sibling.otherAccount")}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
};

export type MobileSiblingOfferProps = {
  /** This app: the offer names and shows its sister. */
  app: SiblingApp;
  /** Off on a TV, or while another sign-in is running. */
  enabled?: boolean;
  /** The app's new-device pairing client, the one its "Sign in with another device" screen uses. */
  createClient: () => PairingClientCore;
  /** The app's paired sign-in completion (`completePairing`); the latest one is used. */
  complete: (approved: Extract<PairingPoll, { status: "approved" }>) => Promise<PairingCompletion>;
  logTag?: string;
};

/**
 * The offer, live: reads the sister app's status when the screen shows and each time the app comes back to the
 * front (the sister may have just signed in), runs the sign-in on "Continue as …", hides on "Use another account".
 * Nothing shows when the sister app is not installed, not signed in, or this build has no native module.
 */
export const MobileSiblingOffer = ({ app, enabled = true, createClient, complete, logTag = "sibling" }: MobileSiblingOfferProps) => {
  const other: SiblingApp = app === "badger" ? "parrot" : "badger";
  const [status, setStatus] = useState<SiblingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<SiblingSignInState>({ phase: "idle" });
  const completeRef = useRef(complete);
  completeRef.current = complete;
  const controllerRef = useRef<SiblingSignInController | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const refresh = () =>
      void getSiblingStatus().then((next) => {
        if (!live) return;
        console.info(`[${logTag}] status`, { signedIn: next !== null });
        setStatus(next);
      });
    refresh();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [enabled, logTag]);

  useEffect(() => () => controllerRef.current?.stop(), []);

  const start = useCallback(() => {
    controllerRef.current?.stop();
    const controller = createSiblingSignInController({
      client: createClient(),
      approve: requestSiblingApproval,
      complete: (approved) => completeRef.current(approved),
      onState: setState,
      now: () => Date.now(),
      sleep: abortableSleep,
      logTag,
    });
    controllerRef.current = controller;
    controller.start();
  }, [createClient, logTag]);

  if (!enabled || dismissed) return null;
  if (!status && state.phase !== "failed") return null;
  return (
    <MobileSiblingOfferView
      other={other}
      email={status?.email ?? ""}
      state={state}
      onContinue={start}
      onCancel={() => controllerRef.current?.cancel()}
      onOtherAccount={() => setDismissed(true)}
    />
  );
};

const styles = StyleSheet.create({
  card: { gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1.5 },
  head: { flexDirection: "row", alignItems: "center", gap: 14 },
  icon: { width: 44, height: 44, borderRadius: 12 },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: "700" },
  body: { fontSize: 13, lineHeight: 19, marginTop: 2 },
  primary: { height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  primaryLabel: { fontSize: 15, fontWeight: "700" },
  secondary: { height: 44, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  secondaryLabel: { fontSize: 15, fontWeight: "600" },
  link: { alignSelf: "center", paddingVertical: 4, paddingHorizontal: 8 },
  linkLabel: { fontSize: 13, fontWeight: "600" },
  failure: { fontSize: 14, lineHeight: 20, textAlign: "center" },
});
