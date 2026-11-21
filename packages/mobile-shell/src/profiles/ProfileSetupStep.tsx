/**
 * "Your profile" on the phones (UX-SETUP-10, `phone-step.png`): the profile's name in a field next to its avatar drawn
 * big, the 22 avatars round, five across, and Back / Next. During the first setup it is a numbered step ("step N of
 * M"); alone (a profile picked later, or "Choose my avatar" in the update window, UX-UPDATE-01) it has no count. Next
 * saves the name, the avatar and `features.avatars = "set"` in one PATCH (`saveProfileSetup`), even unchanged.
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { normalizeProfileName, PROFILE_NAME_MAX, type ApiProfile } from "@space/shared/profiles";
import { ProfileActionError, profileErrorKey } from "@space/shared/profileStore";
import { MobileSetupStep } from "../components/mobile-setup-step";
import { useTranslation, type MobileUiLanguage } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { phoneSetupPosition } from "../setup/phoneSetup";
import type { PhoneSetupStepProps } from "../setup/PhoneSetupFlow";
import { AvatarGrid } from "./AvatarGrid";
import { ProfileAvatarImage } from "./ProfileAvatarImage";
import { saveProfileSetup } from "./profileSetup";

const BIG_AVATAR = 64;

export type ProfileSetupStepProps = {
  profile: ApiProfile;
  /** "Step N of M" during the first setup; absent when the screen shows alone. */
  position?: { step: number; total: number };
  onBack?: () => void;
  /** Runs once the answer is saved. */
  onDone: () => void;
  /** The setup's top-right language button (UX-SETUP-08). */
  onLanguage?: (code: MobileUiLanguage) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
};

export const ProfileSetupStep = ({ profile, position, onBack, onDone, onLanguage, log }: ProfileSetupStepProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [name, setName] = useState(profile.name);
  const [avatarId, setAvatarId] = useState<ProfileAvatarId>(() => profileAvatarIdOf(profile));
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    log?.("profile_setup.shown", { profileId: profile.id, step: position?.step ?? 0, total: position?.total ?? 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per profile shown.
  }, [profile.id]);

  const valid = normalizeProfileName(name) !== null;
  const next = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      await saveProfileSetup(profile, { name, avatarId });
      onDone();
    } catch (error) {
      const code = error instanceof ProfileActionError ? error.code : "unknown";
      log?.("profile_setup.failed", { profileId: profile.id, code });
      setErrorKey(profileErrorKey(code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MobileSetupStep
      step={position?.step ?? 0}
      total={position?.total ?? 0}
      header={position ? undefined : null}
      title={t("profiles.setup.title")}
      body={t("profiles.setup.lead")}
      onBack={onBack}
      // Alone, a greyed Back leads nowhere: none at all, Next full width (UX-SETUP-10).
      noBack={!position}
      onNext={() => void next()}
      nextDisabled={!valid}
      busy={busy}
      onLanguage={onLanguage}
    >
      <View style={styles.row} testID="profile-setup">
        <ProfileAvatarImage avatarId={avatarId} size={BIG_AVATAR} style={styles.round} testID="profile-setup-avatar" />
        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.colors.textMuted }]}>{t("profiles.setup.name")}</Text>
          <TextInput
            testID="profile-setup-name"
            value={name}
            onChangeText={(value) => {
              setName(value);
              setErrorKey(null);
            }}
            maxLength={PROFILE_NAME_MAX}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel={t("profiles.setup.name")}
            style={[styles.input, { color: theme.colors.text }]}
          />
        </View>
      </View>
      {errorKey ? (
        <Text testID="profile-setup-error" style={{ color: theme.colors.danger, fontSize: 15 }}>
          {t(errorKey)}
        </Text>
      ) : null}
      <AvatarGrid variant="round" columns={5} value={avatarId} onChange={setAvatarId} />
    </MobileSetupStep>
  );
};

/**
 * The phone setup's numbered "Your profile" step (Badger and Parrot): the shared step for the profile picked, counted
 * in the setup. The sky alone until the profile picked is known: a profile already set up skips the step.
 */
export const PhoneSetupProfileStep = ({
  profile,
  progress,
  advance,
  back,
  onLanguage,
  log,
}: PhoneSetupStepProps & { profile: ApiProfile | null; log: NonNullable<ProfileSetupStepProps["log"]> }) => {
  if (!profile) return <View testID="setup-profile-wait" />;
  const { step, total } = phoneSetupPosition(progress);
  return (
    <ProfileSetupStep
      key={profile.id}
      profile={profile}
      position={{ step, total }}
      onBack={back}
      onLanguage={(code) => void onLanguage(code)}
      // Kept counted once answered here, so the steps after it keep their numbers.
      onDone={() => void advance({ profileSetupAnswered: true })}
      log={log}
    />
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  round: { borderRadius: BIG_AVATAR / 2, backgroundColor: "#2c2f45" },
  field: { flex: 1, gap: 4 },
  label: { fontSize: 12 },
  // `phone-step.png`: a dark field with the space palette's raised border.
  input: { borderWidth: 1, borderColor: "#4a4d66", backgroundColor: "#1b1d2c", borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, fontSize: 17 },
});
