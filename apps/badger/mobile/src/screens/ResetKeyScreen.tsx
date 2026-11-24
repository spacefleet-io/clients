import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Input, SectionHeader } from "../components/ui";
import { SwitchRow } from "../components/SettingsRows";
import { Screen } from "../components/Screen";
import { useAuth } from "../store/auth";
import { useLibrary } from "../store/library";
import { createBadgerPhoneKeyChange } from "../lib/keyChange";
import { createResealNetworkGate } from "../lib/resealNetwork";
import { setStoredLibraryKey } from "../lib/onboarding";
import {
  KEY_CHANGE_IDLE,
  KEY_CHANGE_WAIT_POLL_MS,
  switchNowOpen,
  type KeyChange,
  type KeyChangeOutcome,
  type KeyChangeState,
  type UnreadableFile,
} from "@space/media-reseal";
import { SPACE_APP_NAMES } from "@space/shared/appScope";
import { formatStorageBytes } from "@space/shared/format";
import { isClientUiLanguage } from "@space/shared/i18n";
import { keyChangeFailureOf, keyChangeFailureText } from "@space/shared/keyChangeFailure";
import { keyChangeCountText, keyChangeEtaText, keyChangeText } from "@space/shared/keyChangeText";
import { generateLibraryKeyWords, type NewLibraryKey } from "@space/shared/libraryKeyWords";
import { LibraryKeyWordsGrid } from "@space/mobile-shell/libraryKeyWords";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../theme/theme";

const APP = SPACE_APP_NAMES.badger;

/**
 * Replace the media library key on Badger's phone (ACCT-KEYCHG-01), the same steps as the computer's dialog: the new
 * key's words, the confirm, the password and code, then every media file copied under the new key (STOR-RESEAL-01) with
 * progress and a time estimate (ACCT-KEYCHG-09), the unreadable files (ACCT-KEYCHG-07), the wait on another device with
 * "Switch now" (ACCT-KEYCHG-06) and Stop under "More options" (ACCT-KEYCHG-08). On mobile data the copying waits unless
 * "Use mobile data" is on (ACCT-KEYCHG-05). Leaving the screen or the app pauses it; Finish carries on.
 */
export const ResetKeyScreen = () => {
  const { i18n } = useTranslation();
  const language = isClientUiLanguage(i18n?.language) ? i18n.language : "en";
  const kt = useMemo(() => keyChangeText(language), [language]);
  const { token, user, logout } = useAuth();
  // ACCT-AUTH-04: an account without a password is asked a code instead (the first try emails one).
  const hasPassword = user?.hasPassword !== false;
  const { sealForRotation } = useLibrary();
  const [fresh] = useState<NewLibraryKey>(() => generateLibraryKeyWords(i18n?.language));
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [method, setMethod] = useState<"email" | "totp" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<KeyChangeState>(KEY_CHANGE_IDLE);
  const [now, setNow] = useState(() => Date.now());
  const [moreOpen, setMoreOpen] = useState(false);
  const [unreadable, setUnreadable] = useState<UnreadableFile[] | null>(null);
  const [unreadableOpen, setUnreadableOpen] = useState(false);
  const [unreadableBusy, setUnreadableBusy] = useState(false);

  const network = useMemo(() => createResealNetworkGate(), []);
  const [useMobileData, setUseMobileData] = useState(false);
  const [networkPaused, setNetworkPaused] = useState(false);
  useEffect(() => network.subscribe(() => setNetworkPaused(network.paused())), [network]);

  const keyChangeRef = useRef<KeyChange | null>(null);
  const keyChangeFor = (signedIn: string): KeyChange => {
    keyChangeRef.current ??= createBadgerPhoneKeyChange({
      token: signedIn,
      newKeyBase64: fresh.keyBase64,
      sealForRotation,
      network,
      onState: (next) => {
        setState(next);
        if (next.phase === "waiting") setNow(Date.now());
        // The run opened: the code was spent on it (codes are single-use) and the switch asks nothing again.
        if (next.phase === "resealing") {
          setCode("");
          setNeedsCode(false);
        }
      },
    });
    return keyChangeRef.current;
  };

  // Leaving the screen or the app pauses the copying between files; the run keeps what was copied.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") keyChangeRef.current?.pause();
    });
    return () => {
      subscription.remove();
      keyChangeRef.current?.pause();
    };
  }, []);

  const showError = (err: unknown) => {
    const failure = keyChangeFailureOf(err);
    if (failure.status === "codeNeeded") {
      setNeedsCode(true);
      setMethod(failure.method);
      setNotice(kt("codeSent"));
    } else {
      // PRIV-KEY-06: Parrot's library is the one re-encrypted alongside.
      setError(keyChangeFailureText(language, failure, SPACE_APP_NAMES.parrot));
    }
  };

  const busyRef = useRef(false);
  const runBusy = async (step: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await step();
    } catch (err) {
      showError(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** After the switch: the new key is kept and this session ends (the rotation revoked every session). */
  const finish = async (outcome: KeyChangeOutcome | null) => {
    if (outcome !== "switched") return;
    keyChangeRef.current = null;
    await setStoredLibraryKey(fresh.keyBase64);
    await logout("sessionRejected");
  };

  /** Start (ACCT-KEYCHG-03), or Finish after a refused switch or interrupted copying: the same run carries on. */
  const submit = () =>
    runBusy(async () => {
      if (!token) return;
      const keyChange = keyChangeFor(token);
      await finish(
        keyChange.state().phase !== "form"
          ? await keyChange.resume()
          : await keyChange.start({ password: hasPassword ? password : "", ...(code ? { twoFactorCode: code } : {}) })
      );
    });

  /** "Switch now" (ACCT-KEYCHG-06): the other device's unfinished uploads are cancelled (STOR-RESEAL-10). */
  const switchNow = () => runBusy(async () => await finish((await keyChangeRef.current?.switchNow()) ?? null));

  // STOR-RESEAL-08: a waiting switch asks the run whether the other uploads ended, then switches.
  useEffect(() => {
    const keyChange = keyChangeRef.current;
    if (state.phase !== "waiting" || !keyChange) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (busyRef.current) return;
      void keyChange
        .poll()
        .then(finish)
        // A failed look at the run is tried again on the next tick; a refused switch left the wait and says why.
        .catch((err: unknown) => {
          if (keyChange.state().phase !== "waiting") showError(err);
        });
    }, KEY_CHANGE_WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [state.phase]);

  /** Stop (ACCT-KEYCHG-08, confirmed): the copies are deleted and the library stays as it was (STOR-RESEAL-07). */
  const confirmStop = () =>
    Alert.alert(kt("reseal.stopTitle"), kt("reseal.stopBody"), [
      { text: kt("reseal.keepGoing"), style: "cancel" },
      {
        text: kt("reseal.stopConfirm"),
        style: "destructive",
        onPress: () =>
          void runBusy(async () => {
            await keyChangeRef.current?.stop();
            keyChangeRef.current = null;
            setState(KEY_CHANGE_IDLE);
            setMoreOpen(false);
            setUnreadable(null);
            setUnreadableOpen(false);
            Alert.alert(kt("reseal.stoppedTitle"), kt("reseal.stoppedMessage"));
          }),
      },
    ]);

  /** "See the N files" (ACCT-KEYCHG-07): the files the old key could not open. */
  const showUnreadable = async () => {
    setUnreadableOpen(true);
    setUnreadable(null);
    const keyChange = keyChangeRef.current;
    setUnreadable(keyChange ? await keyChange.unreadableFiles().catch(() => []) : []);
  };

  /** Deletes the unreadable files; they were lost already (STOR-RESEAL-05). */
  const deleteUnreadable = async () => {
    const keyChange = keyChangeRef.current;
    if (!keyChange || !unreadable?.length) return;
    setUnreadableBusy(true);
    try {
      await keyChange.deleteUnreadableFiles(unreadable);
      Alert.alert(kt("reseal.unreadableDeletedTitle"), keyChangeCountText(language, "reseal.unreadableDeletedMessage", unreadable.length));
      setUnreadable([]);
    } catch {
      Alert.alert(kt("reseal.unreadableTitle"), kt("reseal.unreadableDeleteFailed"));
    } finally {
      setUnreadableBusy(false);
    }
  };

  const onForm = state.phase === "form";
  const progress = state.progress;
  const percent =
    progress && progress.transferBytes > 0
      ? Math.min(100, Math.floor((progress.transferredBytes / progress.transferBytes) * 100))
      : progress && progress.totalFiles > 0
        ? Math.floor((progress.doneFiles / progress.totalFiles) * 100)
        : 0;
  const kept = progress?.keptFiles ?? 0;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} testID="key-change-screen">
        <SectionHeader title={kt("dialogTitle")} />
        {onForm ? (
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{kt("keyLabel")}</Text>
              <LibraryKeyWordsGrid words={fresh.words} />
              <Text style={styles.muted}>{kt("keyHint")}</Text>
              <Text style={styles.muted}>{kt("resealHint", { app: APP })}</Text>
            </View>
            <SwitchRow title={kt("confirmLabel")} value={confirmed} onValueChange={setConfirmed} testID="key-change-confirm" />
            {hasPassword ? (
              <Input label={kt("passwordLabel")} value={password} onChangeText={setPassword} secureTextEntry />
            ) : (
              <Text testID="key-change-no-password" style={styles.muted}>
                {kt("noPasswordHint")}
              </Text>
            )}
          </>
        ) : state.phase === "waiting" ? (
          <View style={styles.card} testID="key-change-waiting">
            <Text style={styles.title}>{kt("reseal.waitingTitle")}</Text>
            <Text style={styles.muted}>{keyChangeCountText(language, "reseal.waitingBody", state.uploadsInFlight)}</Text>
            {switchNowOpen(state.switchNowAt, now) ? (
              <>
                <Text style={styles.muted}>{kt("reseal.switchNowBody")}</Text>
                <Button label={kt("reseal.switchNow")} variant="secondary" onPress={() => void switchNow()} loading={busy} />
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.card} testID="key-change-reseal">
            <Text style={styles.title}>{state.phase === "resealing" ? kt("reseal.title") : kt("reseal.readyTitle")}</Text>
            <View
              style={styles.track}
              accessibilityRole="progressbar"
              accessibilityLabel={kt("reseal.title")}
              accessibilityValue={{ min: 0, max: 100, now: percent }}
            >
              <View style={[styles.fill, { width: `${percent}%` }]} />
            </View>
            {progress ? (
              <View style={styles.progressRow}>
                <Text style={styles.muted}>
                  {kt("reseal.files", { done: progress.doneFiles, total: progress.totalFiles })}
                  {" · "}
                  {formatStorageBytes(progress.transferredBytes)} / {formatStorageBytes(progress.transferBytes)}
                </Text>
                {state.phase === "resealing" ? <Text style={styles.muted}>{keyChangeEtaText(language, state.etaSeconds)}</Text> : null}
              </View>
            ) : null}
            {state.phase === "resealing" ? (
              <Text style={styles.muted} testID="key-change-keep-open">
                {/* ACCT-KEYCHG-05: iOS stops an app that leaves the screen, and a long copy drains the battery. */}
                {kt(Platform.OS === "ios" ? "reseal.keepOpenPlugged" : "reseal.keepOpen", { app: APP })}
              </Text>
            ) : null}
          </View>
        )}

        {!onForm && networkPaused && !useMobileData ? (
          <View style={styles.banner} testID="key-change-mobile-data-paused">
            <Text style={styles.title}>{kt("reseal.mobileDataTitle")}</Text>
            <Text style={styles.muted}>{kt("reseal.mobileDataBody")}</Text>
          </View>
        ) : null}
        {!onForm && state.phase !== "waiting" ? (
          <SwitchRow
            title={kt("reseal.useMobileData")}
            description={kt("reseal.useMobileDataHint")}
            value={useMobileData}
            onValueChange={(allowed) => {
              setUseMobileData(allowed);
              network.setUseMobileData(allowed);
            }}
            testID="key-change-use-mobile-data"
          />
        ) : null}

        {needsCode ? (
          <View style={styles.field}>
            <Input label={kt("codeLabel")} value={code} onChangeText={setCode} placeholder="123456" />
            <Text style={styles.muted}>{method === "totp" ? kt("codeHintTotp") : kt("codeHintEmail")}</Text>
          </View>
        ) : null}

        {kept > 0 ? (
          <View style={styles.card} testID="key-change-unreadable">
            <Text style={styles.muted}>{keyChangeCountText(language, "reseal.unreadable", kept)}</Text>
            <Button label={keyChangeCountText(language, "reseal.seeFiles", kept)} variant="ghost" onPress={() => void showUnreadable()} />
            {unreadableOpen ? (
              <View style={styles.field}>
                <Text style={styles.title}>{kt("reseal.unreadableTitle")}</Text>
                <Text style={styles.muted}>{kt("reseal.unreadableBody")}</Text>
                {unreadable === null ? (
                  <Text style={styles.muted}>{kt("reseal.unreadableLoading")}</Text>
                ) : unreadable.length === 0 ? (
                  <Text style={styles.muted}>{kt("reseal.unreadableNone")}</Text>
                ) : (
                  unreadable.map((file) => (
                    <View key={file.key} style={styles.fileRow}>
                      <Text style={styles.fileKey} numberOfLines={1}>
                        {file.key}
                      </Text>
                      <Text style={styles.muted}>{formatStorageBytes(file.sizeBytes)}</Text>
                    </View>
                  ))
                )}
                <Button
                  label={keyChangeCountText(language, "reseal.unreadableDelete", unreadable?.length ?? 0)}
                  variant="danger"
                  disabled={!unreadable?.length}
                  loading={unreadableBusy}
                  onPress={() => void deleteUnreadable()}
                />
                <Button label={kt("reseal.close")} variant="ghost" onPress={() => setUnreadableOpen(false)} />
              </View>
            ) : null}
          </View>
        ) : null}

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {error ? (
          <Text style={styles.error} testID="key-change-error">
            {error}
          </Text>
        ) : null}

        {onForm || state.phase === "ready" ? (
          <Button
            label={busy ? kt("working") : state.phase === "ready" ? kt("reseal.finish") : kt("submit")}
            onPress={() => void submit()}
            disabled={!confirmed || (hasPassword && !password.trim())}
            loading={busy}
            testID="key-change-submit"
          />
        ) : null}

        {onForm ? null : (
          <View style={styles.field}>
            <Button label={kt("reseal.moreOptions")} variant="ghost" onPress={() => setMoreOpen((wasOpen) => !wasOpen)} />
            {moreOpen ? <Button label={kt("reseal.stop")} variant="danger" onPress={confirmStop} testID="key-change-stop" /> : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  scroll: {
    gap: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  banner: {
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    gap: theme.spacing.xs,
  },
  field: {
    gap: theme.spacing.sm,
  },
  title: {
    color: theme.colors.text,
    fontWeight: "600",
  },
  muted: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  track: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceRaised,
  },
  fill: {
    height: "100%",
    backgroundColor: theme.colors.accent,
  },
  progressRow: {
    gap: theme.spacing.xs,
  },
  fileRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  fileKey: {
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: theme.font.size.sm,
  },
  notice: {
    color: theme.colors.accent,
  },
  error: {
    color: theme.colors.danger,
  },
});
