/**
 * The phone approver screen (ACCT-PAIR-01, ACCT-PAIR-02), shared by Badger and Parrot: scan the QR code or type the
 * short code another device shows, see who is asking with the warning, unlock the phone, approve. Each app injects
 * what differs: its session token, the pairing side effects (key store, push device id), what to do after an approval
 * and how to leave. Buttons use the shared face without the reanimated spring, since Parrot ships no reanimated.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SHORT_CODE_LENGTH } from "@space/pairing-crypto";
import { ShortCodeInput } from "../short-code";
import { Camera, CameraType, qrScannerAvailable } from "./qrScanner";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { scopeLogger } from "../logger";
import { MobileScreen } from "../components/mobile-screen";
import { MobileCard } from "../components/mobile-card";
import { MobileButtonFace } from "../components/mobile-button-face";
import {
  PairingFlowError,
  approvalQuestion,
  approveDevice,
  denyDevice,
  deviceTypeLabel,
  lookupDevice,
  pairingErrorMessage,
  type PairingDeps,
  type PairingRequestInfo,
} from "./pairingFlow";

const log = scopeLogger("pairing.screen");

/** testIDs, so an emulator run or a test can drive the screen whatever the UI language. */
export const PAIR_DEVICE_TEST_IDS = {
  typeToggle: "pair-device-type-toggle",
  codeInput: "pair-device-code-input",
  continue: "pair-device-continue",
  approve: "pair-device-approve",
  deny: "pair-device-deny",
  retry: "pair-device-retry",
  tryAnother: "pair-device-try-another",
  done: "pair-device-done",
  back: "pair-device-back",
} as const;

export type PairDeviceScreenProps = {
  /** The signed-in session's token; nothing is looked up or sent without one. */
  token: string | null;
  /** The real side effects: API calls, the library key, the phone unlock. */
  deps: PairingDeps;
  /** A code that arrived by deep link: looked up at once. */
  initialCode?: string;
  /** Runs after an approval the API accepted, with the new session (Badger remembers it for its device list). */
  onApproved?: (sessionId: string) => Promise<void>;
  /** Leaves the screen. */
  onClose: () => void;
  /**
   * true (default): the screen draws its own safe-area frame (a route without a header, Badger). false: a plain
   * scroll view under the app's own navigation header (Parrot).
   */
  framed?: boolean;
};

type Stage =
  | { kind: "scan" }
  | { kind: "looking" }
  | { kind: "confirm"; request: PairingRequestInfo }
  | { kind: "approving"; request: PairingRequestInfo }
  | { kind: "done"; request: PairingRequestInfo; approved: boolean }
  | { kind: "error"; error: PairingFlowError; request: PairingRequestInfo | null };

type CameraState = "checking" | "granted" | "denied";

const toFlowError = (error: unknown): PairingFlowError =>
  error instanceof PairingFlowError ? error : new PairingFlowError("unknown");

export const PairDeviceScreen = ({ token, deps, initialCode, onApproved, onClose, framed = true }: PairDeviceScreenProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();

  const [stage, setStage] = useState<Stage>({ kind: "scan" });
  // Without a scanner (the Google-free Android build) the screen opens on the typed code and stays there.
  const [typing, setTyping] = useState(!qrScannerAvailable);
  const [typedCode, setTypedCode] = useState("");
  const [cameraState, setCameraState] = useState<CameraState>("checking");
  const busyRef = useRef(false);

  useEffect(() => {
    if (!qrScannerAvailable) return;
    let cancelled = false;
    const ask = async () => {
      if (Platform.OS === "android") {
        const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
        log.warn("camera.permission", { result });
        if (!cancelled) setCameraState(result === PermissionsAndroid.RESULTS.GRANTED ? "granted" : "denied");
      } else if (!cancelled) {
        // iOS asks by itself the first time the camera view starts.
        setCameraState("granted");
      }
    };
    void ask().catch((error: unknown) => {
      log.warn("camera.permission_failed", { error: error instanceof Error ? error.message : String(error) });
      if (!cancelled) setCameraState("denied");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const lookup = useCallback(
    async (input: string) => {
      if (!token || busyRef.current) return;
      busyRef.current = true;
      setStage({ kind: "looking" });
      try {
        const request = await lookupDevice(deps, token, input);
        setStage({ kind: "confirm", request });
      } catch (error) {
        setStage({ kind: "error", error: toFlowError(error), request: null });
      } finally {
        busyRef.current = false;
      }
    },
    [token, deps],
  );

  // A pairing link (https://spacefleet.io/pair/<app>?code=..., ACCT-PAIR-06) lands here with the code already filled in.
  useEffect(() => {
    if (initialCode) {
      log.warn("deep_link.received", { length: initialCode.length });
      void lookup(initialCode);
    }
  }, [initialCode, lookup]);

  const approve = useCallback(
    async (request: PairingRequestInfo) => {
      if (!token || busyRef.current) return;
      busyRef.current = true;
      setStage({ kind: "approving", request });
      try {
        const { sessionId } = await approveDevice(deps, token, request);
        if (sessionId && onApproved) await onApproved(sessionId);
        setStage({ kind: "done", request, approved: true });
      } catch (error) {
        const flowError = toFlowError(error);
        // Cancelling the unlock prompt leaves the question open so the user can try again or deny.
        if (flowError.kind === "unlock_cancelled" || flowError.kind === "unlock_failed") {
          setStage({ kind: "error", error: flowError, request });
        } else {
          setStage({ kind: "error", error: flowError, request: null });
        }
      } finally {
        busyRef.current = false;
      }
    },
    [token, deps, onApproved],
  );

  const deny = useCallback(
    async (request: PairingRequestInfo) => {
      if (!token) return;
      try {
        await denyDevice(deps, token, request);
      } catch {
        // The code expires on its own within minutes; leaving is never blocked by a failed deny.
      }
      setStage({ kind: "done", request, approved: false });
    },
    [token, deps],
  );

  const reset = useCallback(() => {
    busyRef.current = false;
    setTypedCode("");
    setTyping(!qrScannerAvailable);
    setStage({ kind: "scan" });
  }, []);

  const onScan = useCallback(
    (event: { nativeEvent: { codeStringValue: string } }) => {
      if (busyRef.current) return;
      void lookup(event.nativeEvent.codeStringValue);
    },
    [lookup],
  );

  const text = { color: theme.colors.text };
  const muted = { color: theme.colors.textMuted };

  const renderBody = () => {
    switch (stage.kind) {
      case "scan":
        return (
          <>
            {!typing ? (
              <MobileCard>
                {cameraState === "granted" ? (
                  <View style={styles.cameraBox}>
                    <Camera
                      style={styles.camera}
                      cameraType={CameraType.Back}
                      scanBarcode
                      showFrame
                      allowedBarcodeTypes={["qr"]}
                      scanThrottleDelay={1000}
                      onReadCode={onScan}
                      frameColor={theme.colors.accent}
                      laserColor={theme.colors.accent}
                    />
                  </View>
                ) : cameraState === "checking" ? (
                  <Text style={[styles.body, muted]}>{t("pairing.scan.cameraStarting")}</Text>
                ) : (
                  <Text style={[styles.body, muted]}>{t("pairing.scan.cameraDenied")}</Text>
                )}
                <Text style={[styles.body, muted]}>{t("pairing.scan.pointCamera")}</Text>
              </MobileCard>
            ) : null}
            {typing ? (
              <MobileCard>
                <Text style={[styles.label, muted]}>{t("pairing.scan.codeLabel")}</Text>
                {/* ACCT-PAIR-01: 8 boxes in two groups of 4; typed or pasted with or without a dash or spaces, in any case. */}
                <ShortCodeInput
                  testID={PAIR_DEVICE_TEST_IDS.codeInput}
                  value={typedCode}
                  onChange={setTypedCode}
                  onSubmit={() => {
                    if (typedCode.length === SHORT_CODE_LENGTH) void lookup(typedCode);
                  }}
                  autoFocus
                  accessibilityLabel={t("pairing.scan.codeAccessibility")}
                  style={styles.codeInput}
                />
                <MobileButtonFace
                  testID={PAIR_DEVICE_TEST_IDS.continue}
                  label={t("pairing.scan.continue")}
                  onPress={() => void lookup(typedCode)}
                  disabled={typedCode.length !== SHORT_CODE_LENGTH}
                />
              </MobileCard>
            ) : null}
            {qrScannerAvailable ? (
              <MobileButtonFace
                testID={PAIR_DEVICE_TEST_IDS.typeToggle}
                label={typing ? t("pairing.scan.scanInstead") : t("pairing.scan.typeInstead")}
                variant="secondary"
                onPress={() => setTyping((value) => !value)}
              />
            ) : null}
          </>
        );
      case "looking":
        return (
          <MobileCard>
            <Text style={[styles.body, muted]}>{t("pairing.looking")}</Text>
          </MobileCard>
        );
      case "confirm":
        return (
          <>
            <MobileCard>
              <Text style={[styles.question, text]}>{approvalQuestion(stage.request)}</Text>
              <Text style={[styles.body, muted]}>
                {t("pairing.confirm.asked", {
                  type: deviceTypeLabel(stage.request.deviceType),
                  name: stage.request.deviceName,
                })}
              </Text>
              <View style={[styles.warning, { borderColor: theme.colors.warning }]}>
                <Text style={[styles.body, { color: theme.colors.warning }]}>{t("pairing.warning")}</Text>
              </View>
              <Text style={[styles.body, muted]}>{t("pairing.confirm.unlockNotice")}</Text>
            </MobileCard>
            <MobileButtonFace
              testID={PAIR_DEVICE_TEST_IDS.approve}
              label={t("pairing.confirm.approve")}
              onPress={() => void approve(stage.request)}
            />
            <MobileButtonFace
              testID={PAIR_DEVICE_TEST_IDS.deny}
              label={t("pairing.confirm.deny")}
              variant="secondary"
              onPress={() => void deny(stage.request)}
            />
          </>
        );
      case "approving":
        return (
          <MobileCard>
            <Text style={[styles.question, text]}>{approvalQuestion(stage.request)}</Text>
            <Text style={[styles.body, muted]}>{t("pairing.approving")}</Text>
          </MobileCard>
        );
      case "done":
        return (
          <>
            <MobileCard>
              <Text style={[styles.question, text]}>
                {t(stage.approved ? "pairing.done.added" : "pairing.done.notAdded", { name: stage.request.deviceName })}
              </Text>
              <Text style={[styles.body, muted]}>
                {stage.approved
                  ? t("pairing.done.addedDetail", { type: deviceTypeLabel(stage.request.deviceType) })
                  : t("pairing.done.notAddedDetail")}
              </Text>
            </MobileCard>
            <MobileButtonFace testID={PAIR_DEVICE_TEST_IDS.done} label={t("pairing.done.done")} onPress={onClose} />
          </>
        );
      case "error": {
        const failedRequest = stage.request;
        return (
          <>
            <MobileCard>
              <Text style={[styles.question, { color: theme.colors.danger }]}>
                {failedRequest ? t("pairing.failed.notAddedYet") : t("pairing.failed.didntWork")}
              </Text>
              <Text style={[styles.body, text]}>{pairingErrorMessage(stage.error.kind, stage.error.retryAfterMinutes)}</Text>
            </MobileCard>
            {failedRequest ? (
              <>
                <MobileButtonFace
                  testID={PAIR_DEVICE_TEST_IDS.retry}
                  label={t("pairing.failed.tryAgain")}
                  onPress={() => void approve(failedRequest)}
                />
                <MobileButtonFace
                  testID={PAIR_DEVICE_TEST_IDS.deny}
                  label={t("pairing.confirm.deny")}
                  variant="secondary"
                  onPress={() => void deny(failedRequest)}
                />
              </>
            ) : (
              <MobileButtonFace testID={PAIR_DEVICE_TEST_IDS.tryAnother} label={t("pairing.failed.tryAnother")} onPress={reset} />
            )}
          </>
        );
      }
    }
  };

  const content = (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display }]}>{t("pairing.title")}</Text>
        <Text style={[styles.subtitle, muted]}>{t("pairing.subtitle")}</Text>
      </View>
      {renderBody()}
      {stage.kind !== "done" ? (
        <MobileButtonFace testID={PAIR_DEVICE_TEST_IDS.back} label={t("pairing.back")} variant="ghost" onPress={onClose} />
      ) : null}
    </ScrollView>
  );

  return framed ? (
    <MobileScreen>{content}</MobileScreen>
  ) : (
    <View style={[styles.plain, { padding: theme.spacing.lg }]}>{content}</View>
  );
};

const styles = StyleSheet.create({
  plain: { flex: 1 },
  scroll: { gap: 14, paddingBottom: 32 },
  header: { gap: 6, marginBottom: 16 },
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.4 },
  subtitle: { fontSize: 14 },
  cameraBox: { height: 320, borderRadius: 18, overflow: "hidden" },
  camera: { flex: 1 },
  body: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 14 },
  question: { fontSize: 20, fontWeight: "800" },
  warning: { borderWidth: 1, borderRadius: 14, padding: 12 },
  codeInput: { marginVertical: 4 },
});
