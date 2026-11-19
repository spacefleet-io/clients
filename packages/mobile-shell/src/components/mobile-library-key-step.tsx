/**
 * The library key step of the phone and TV apps (UX-KEY-01, UX-SETUP-08), one screen for Badger phone, Badger TV and
 * Parrot phone (Chris 2026-11-12 (chat): "the setup step to enter/save the key should be the same shared one between
 * the 2 apps"). It is a setup step: header with Back and the language button top-right, the card, and the main button
 * pinned bottom-right, in view without scrolling on a 360x640dp phone. On a TV the step is one card with "STEP N OF M",
 * the words and Back and the main button at its bottom (UX-TV-33).
 *
 * - `mode="show"`: a new key's 12 words read-only (2 columns on a phone, 4 on a TV). A phone adds Copy and an optional
 *   "Generate a new key"; a TV shows neither (its clipboard reaches nothing, and the words are to be written down,
 *   UX-TV-33). The main button is the app's "I've written it down", where the TV's remote starts.
 * - `mode="enter"`: the 12 empty boxes (the TV's remote starts on box 1), the error sentence, then an "or" line and the
 *   "Get the key from another device" card when the app has that flow (`renderOtherDevice`, whose panel replaces the
 *   boxes until the user goes back).
 *
 * Under the card: "Without the key, nobody can open this library, not even us." (not on a TV's shown key, whose card
 * already says to keep the words safe, UX-TV-33). Where a key is typed and the
 * app can erase (`onErase`), "Lost your key? Erase this library and start over" above it opens the erase dialog.
 * What differs per app (key check, erase call, other-device panel) comes in as props. The erase is account-wide
 * (Badger and Parrot), the same on phone and TV (Main 2026-11-12).
 *
 * On TV (960x540dp) the mascot floats over the card's top border, as on every setup step (UX-SETUP-08).
 */
import React, { useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { LibraryKeyInput } from "@space/shared/libraryKeyWords";
import { useTranslation, type MobileUiLanguage } from "../i18n";
import { LibraryKeyWordsGrid, LibraryKeyWordsInput } from "../libraryKeyWords";
import { scopeLogger } from "../logger";
import { useMobileShellTheme } from "../theme";
import { MobileButtonFace } from "./mobile-button-face";
import { MobileEraseLibraryDialog } from "./mobile-erase-library-dialog";
import { MobilePhoneSignInCard } from "./mobile-phone-sign-in-card";
import { TV_FOCUS_RING_WIDTH } from "./tv-focus";
import { MobileSetupStep } from "./mobile-setup-step";

const log = scopeLogger("library-key-step");

export type MobileLibraryKeyStepProps = {
  mode: "show" | "enter";
  title: string;
  /** The one sentence under the title. */
  body: string;
  /** "STEP N OF M" of the default header; ignored when `header` is given. */
  step?: number;
  total?: number;
  /** Replaces the default header: the TV's own numbering, or `null` once the setup is over. */
  header?: ReactNode;
  /** Back (header and footer). The key's previous step is the sign-in, so the apps sign out here. */
  onBack?: () => void;
  /** The top-right language button (UX-SETUP-08). */
  onLanguage?: (code: MobileUiLanguage) => void;
  /** Show mode: the new key's words. */
  words?: readonly string[];
  /** Show mode: "Generate a new key", when the app offers it. */
  onRegenerate?: () => void;
  /** Enter mode: every change of the boxes (their text and how it reads). */
  onKeyChange?: (text: string, read: LibraryKeyInput) => void;
  /** Enter mode: the app's "Get the key from another device" panel; absent means no card. */
  renderOtherDevice?: () => ReactNode;
  /** The main button's words: "Continue" unless given (show mode passes "I've written it down"). */
  continueLabel?: string;
  canContinue: boolean;
  onContinue: () => void;
  busy?: boolean;
  /** One error sentence under the boxes. */
  error?: string | null;
  /**
   * Enter mode: erases the account's library (password, then the code when the server asks for one). Rejects with the
   * API error; the dialog says why and stays open.
   */
  onErase?: (password: string, twoFactorCode?: string) => Promise<void>;
  /** False for an account without a password: the erase asks a code instead (ACCT-AUTH-04). */
  hasPassword?: boolean;
  /** Modals the app adds (the "I've written it down" warning). */
  overlay?: ReactNode;
};

export const MobileLibraryKeyStep = ({
  mode,
  title,
  body,
  step = 0,
  total = 0,
  header,
  onBack,
  onLanguage,
  words,
  onRegenerate,
  onKeyChange,
  renderOtherDevice,
  continueLabel,
  canContinue,
  onContinue,
  busy,
  error,
  onErase,
  hasPassword = true,
  overlay,
}: MobileLibraryKeyStepProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const [otherDevice, setOtherDevice] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [lostFocused, setLostFocused] = useState(false);
  const tv = Platform.isTV === true;
  const enter = mode === "enter";
  const pairing = enter && otherDevice && Boolean(renderOtherDevice);

  // The boxes start empty again when the user comes back from the code panel (they remount), so the app's read too.
  const openOtherDevice = (open: boolean) => {
    log.info("other_device", { open });
    onKeyChange?.("", { status: "empty" });
    setOtherDevice(open);
  };

  // TV, shown key: nothing under the card (UX-TV-33).
  const afterCard = tv && !enter ? undefined : (
    <View style={styles.lost} testID="key-lost">
      {enter && onErase ? (
        <Pressable
          testID="key-lost-start-new-library"
          accessibilityRole="button"
          accessibilityLabel={t("libraryKeyStep.lostKeyLink")}
          onPress={() => {
            log.info("erase.open");
            setEraseOpen(true);
          }}
          onFocus={() => setLostFocused(true)}
          onBlur={() => setLostFocused(false)}
          // TV: the remote's ring around the link's words, laid out while idle so focusing never shifts it (UX-TV-17).
          style={tv ? [styles.lostRing, { borderColor: lostFocused ? theme.colors.text : "transparent" }] : undefined}
          hitSlop={8}
        >
          <Text style={[styles.lostLink, { color: theme.colors.textMuted }]}>{t("libraryKeyStep.lostKeyLink")}</Text>
        </Pressable>
      ) : null}
      <Text testID="key-lost-note" style={[styles.lostNote, { color: theme.colors.textMuted }]}>
        {t("libraryKeyStep.lostKeyNote")}
      </Text>
    </View>
  );

  return (
    <>
      <MobileSetupStep
        step={step}
        total={total}
        title={title}
        body={body}
        header={header}
        onBack={onBack}
        onLanguage={onLanguage}
        onNext={pairing ? undefined : onContinue}
        nextDisabled={!canContinue}
        nextLabel={continueLabel ?? t("libraryKeyStep.continue")}
        nextPreferredFocus={tv && !enter}
        busy={busy}
        afterCard={afterCard}
      >
        {enter ? (
          pairing ? (
            <View style={styles.block} testID="key-other-device-panel">
              {renderOtherDevice?.()}
              <MobileButtonFace label={t("phonePairing.typeKey")} variant="secondary" onPress={() => openOtherDevice(false)} testID="key-type-instead" />
            </View>
          ) : (
            <View style={[styles.block, tv && styles.blockTv]}>
              <LibraryKeyWordsInput
                autoFocus={tv}
                onChangeText={(text, read) => onKeyChange?.(text, read)}
                onSubmitEditing={() => {
                  if (canContinue && !busy) onContinue();
                }}
              />
              {error ? (
                <Text testID="key-error" accessibilityRole="alert" style={[styles.error, { color: theme.colors.danger }]}>
                  {error}
                </Text>
              ) : null}
              {renderOtherDevice ? (
                <MobilePhoneSignInCard
                  testID="key-from-another-device"
                  title={t("phonePairing.keyLink")}
                  body={t("phonePairing.keyCard")}
                  compact={tv}
                  onPress={() => openOtherDevice(true)}
                />
              ) : null}
            </View>
          )
        ) : (
          <View style={[styles.block, tv && styles.blockTv]}>
            <LibraryKeyWordsGrid
              words={words ?? []}
              action={
                onRegenerate && !tv ? (
                  <MobileButtonFace label={t("onboarding.generate")} variant="secondary" onPress={onRegenerate} testID="key-regenerate" />
                ) : undefined
              }
            />
            {error ? (
              <Text testID="key-error" accessibilityRole="alert" style={[styles.error, { color: theme.colors.danger }]}>
                {error}
              </Text>
            ) : null}
          </View>
        )}
      </MobileSetupStep>
      {onErase ? (
        <MobileEraseLibraryDialog
          visible={eraseOpen}
          hasPassword={hasPassword}
          onCancel={() => setEraseOpen(false)}
          // The erase is the last resort: a device still signed in can send the key (Chris 2026-11-12 (chat): "The
          // nuke is only needed when the user has access to no logged in session of any of the apps on any platform").
          onOtherDevice={
            renderOtherDevice
              ? () => {
                  log.info("erase.other_device");
                  setEraseOpen(false);
                  openOtherDevice(true);
                }
              : undefined
          }
          onConfirm={async (password, twoFactorCode) => {
            await onErase(password, twoFactorCode);
            log.info("erase.done");
            setEraseOpen(false);
          }}
        />
      ) : null}
      {overlay}
    </>
  );
};

const styles = StyleSheet.create({
  block: { gap: 14 },
  // TV: closer, so the 12 boxes, the other-device card and the buttons fit 540 dp under the mascot (UX-SETUP-08).
  blockTv: { gap: 10 },
  error: { fontSize: 14, lineHeight: 20 },
  lost: { alignItems: "center", gap: 4, paddingHorizontal: 12 },
  lostLink: { fontSize: 13, textAlign: "center", textDecorationLine: "underline" },
  lostRing: { borderWidth: TV_FOCUS_RING_WIDTH, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  lostNote: { fontSize: 12.5, textAlign: "center" },
});
