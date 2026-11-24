// The sign-in, FIRST, before and outside the setup (UX-SETUP-06): the approved phone design — the language menu top
// right, the floating mascot, "SIGN IN WITH YOUR ACCOUNT", Email and Password, the green "Sign in →" and
// "FORGOT PASSWORD?" — over the starry sky (UX-SKY-01). It opens on that form (ACCT-SIGNIN-04); the shared highlighted
// "Sign in with another device" card under it swaps the form for the pairing code any signed-in Badger or Parrot app
// approves (ACCT-PAIR-01), and "Sign in with email and password" comes back. "Don't have an account? Create account"
// opens the shared sign-up (a free account, then the emailed code; no price, no payment: ACCT-AUTH-10, ACCT-PAY-02).
// The Google, Apple and Microsoft rows the server offers sit above an "or" line over the form (ACCT-SIGNIN-05).
// A session the server rejected comes back here with a short explanation.
import React, { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MobileAuthBrand,
  MobileAuthLink,
  MobileAuthSettingsBar,
  MobileLanguageMenu,
  MobileOrDivider,
  MobilePasswordReset,
  MobilePasswordSignInForm,
  MobilePhoneSignInCard,
  MobileProviderSignInRows,
  MobileSignUp,
  MobileSignUpTermsNotice,
  MobileStartupPage,
  useMobilePasswordSignIn,
} from "@space/mobile-shell/components";
import type { MobileSignInProviderId } from "@space/mobile-shell/components";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { MobileSetupBackFooter } from "@space/mobile-shell/setup-step";
import { useMobileProviderSignIn } from "@space/mobile-shell/provider-sign-in";
import type { ProviderSignInNotice } from "@space/mobile-shell/provider-sign-in";
import { login } from "@space/shared/api";
import type { User } from "@space/shared/api";
import { useSession } from "../state/session";
import { setParrotLanguage } from "../lib/i18n";
import { PARROT_LINK_SCHEME } from "../lib/linkScheme";
import { PARROT_MASCOT } from "../brand";
import { createParrotCompletionDeps, createParrotPairingClient, PARROT_PAIRING_LOG_TAG } from "../setup/pairing";
import { completePairing } from "@space/mobile-shell/pairing";
import { SiblingOffer } from "./SiblingOffer";
import { currentPhoneDeviceName } from "@space/mobile-shell/pairing-device";
import { MobilePairSignIn } from "@space/mobile-shell/pair-sign-in";

const PROVIDER_NAMES: Record<MobileSignInProviderId, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

/** Why the sign-in shows again, when the app knows (the server rejected the saved session). */
const SignInNoticeText = () => {
  const { signInNotice } = useSession();
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  return signInNotice === "sessionRejected" ? <Text style={[styles.notice, { color: theme.colors.danger }]}>{t("setup.signIn.sessionRejected")}</Text> : null;
};

/** `onPaired`: a pairing brought the library key too, so the setup skips the key screen. */
/** `onBack`: while the setup is open, Back to its language step, before the sign-in (UX-SETUP-08). */
export const LoginScreen = ({ onPaired, onBack }: { onPaired?: () => Promise<void>; onBack?: () => void }) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { signIn } = useSession();
  const [mode, setMode] = useState<"password" | "phone" | "signup" | "verify">("password");
  const showForm = useCallback(() => setMode("password"), []);
  const [resetOpen, setResetOpen] = useState(false);
  // The line over the form: the password sign-in's, a provider's answer, the password reset's "done" (i18n keys).
  const [notice, setNotice] = useState<ProviderSignInNotice | null>(null);
  const [lang, setLang] = useState(() => getCurrentLanguage());

  // Google, Apple, Microsoft (ACCT-SIGNIN-05): the browser comes back through parrot://auth/provider (App.tsx hands the
  // link over, even while the pairing panel shows); a new email gets a free account, as on the website (ACCT-AUTH-10).
  const startProviderSession = useCallback(
    (token: string, user: User) => signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } }),
    [signIn]
  );
  const showProviderNotice = useCallback((next: ProviderSignInNotice | null) => {
    setNotice(next);
    if (next) setMode("password");
  }, []);
  const providerSignIn = useMobileProviderSignIn({
    scheme: PARROT_LINK_SCHEME,
    enabled: true,
    storage: AsyncStorage,
    device: { deviceType: "mobile", deviceName: currentPhoneDeviceName("Parrot") },
    uiLanguage: isMobileUiLanguage(lang) ? lang : undefined,
    setSession: startProviderSession,
    onNotice: showProviderNotice,
  });
  // Email and password: the shared form. "Parrot (Pixel 8)": the name this phone's session carries in the account's
  // device list (ACCT-PAIR-05). After a provider return that asks for the second step, the code field alone finishes it.
  const form = useMobilePasswordSignIn({
    login: async (email, password, code) => {
      const result = await login(email, password, code, undefined, { deviceType: "mobile", deviceName: currentPhoneDeviceName("Parrot") });
      await startProviderSession(result.token, result.user);
    },
    providerStep: {
      method: providerSignIn.secondStep?.method ?? null,
      finishing: providerSignIn.finishing,
      submit: providerSignIn.submitSecondStep,
    },
    // ACCT-AUTH-10: the account's email was never verified: the sign-up's code step, as on the desktop.
    onUnverified: () => setMode("verify"),
    notice,
    setNotice,
  });

  const controls = (
    <MobileAuthSettingsBar
      languageMenu={
        <MobileLanguageMenu
          current={lang}
          languages={MOBILE_UI_LANGUAGES}
          onSelect={(code) => {
            setLang(code);
            void setParrotLanguage(code);
          }}
        />
      }
    />
  );

  // "Sign in with another device": the page both phones share (UX-PHONE-10); its Back returns to this form.
  if (mode === "phone") {
    return (
      <MobilePairSignIn
        app="parrot"
        createClient={createParrotPairingClient}
        complete={(approved) =>
          completePairing(
            createParrotCompletionDeps(async (token, user) => {
              // The key is already stored: mark it so the key step is skipped, then sign in.
              await onPaired?.();
              await signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } });
            }),
            approved
          )
        }
        logTag={PARROT_PAIRING_LOG_TAG}
        deviceName={currentPhoneDeviceName("Parrot")}
        onBack={showForm}
      />
    );
  }

  const providerRows = (labelKey: "login.provider.signInWith" | "login.provider.signUpWith") =>
    providerSignIn.providers.length > 0 ? (
      <>
        <MobileOrDivider label={t("login.provider.or")} testID="provider-sign-in-divider" />
        <MobileProviderSignInRows
          providers={providerSignIn.providers}
          busy={providerSignIn.busy}
          label={(provider) => t(labelKey, { provider: PROVIDER_NAMES[provider] })}
          onSelect={(provider) => void providerSignIn.start(provider)}
        />
      </>
    ) : null;

  if (mode === "signup" || mode === "verify") {
    return (
      <View style={{ flex: 1 }} testID="sign-in">
        <MobileStartupPage controls={controls} footer={onBack ? <MobileSetupBackFooter onBack={onBack} /> : undefined}>
          <MobileAuthBrand iconSource={PARROT_MASCOT} />
          <MobileSignUp
            key={mode}
            initialEmail={form.email.trim()}
            initialStep={mode === "verify" ? "verify" : "form"}
            language={lang}
            uiLanguage={isMobileUiLanguage(lang) ? lang : undefined}
            device={{ deviceType: "mobile", deviceName: currentPhoneDeviceName("Parrot") }}
            onSignedIn={startProviderSession}
            onSignIn={(typed) => {
              if (typed) form.setEmail(typed);
              setNotice(null);
              setMode("password");
            }}
            providerRows={providerRows("login.provider.signUpWith")}
          />
        </MobileStartupPage>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }} testID="sign-in">
      <MobileStartupPage controls={controls} footer={onBack ? <MobileSetupBackFooter onBack={onBack} /> : undefined}>
        <MobileAuthBrand iconSource={PARROT_MASCOT} subtitle={t("login.withAccount").toUpperCase()} />
        <SignInNoticeText />
        {/* ACCT-PAIR-07: Badger signed in on this phone offers its account above the form; nothing when it is not. */}
        <SiblingOffer onPaired={onPaired ?? (async () => undefined)} />
        <MobilePasswordSignInForm form={form} onForgot={() => setResetOpen(true)} />
        {providerRows("login.provider.signInWith")}
        {/* A new email gets a free account through these rows, so the sign-up line sits under them (ACCT-AUTH-10). */}
        {providerSignIn.providers.length > 0 ? <MobileSignUpTermsNotice language={lang} testID="provider-terms-notice" /> : null}
        <MobileAuthLink
          label={`${t("login.noAccountPrompt")} ${t("login.createAccount")}`.toUpperCase()}
          color={theme.colors.accent}
          style={styles.link}
          onPress={() => {
            setNotice(null);
            setMode("signup");
          }}
          testID="login-create-account"
        />
        <MobilePhoneSignInCard onPress={() => setMode("phone")} />
      </MobileStartupPage>
      {resetOpen ? (
        <MobilePasswordReset
          initialEmail={form.email}
          onDone={(done) => {
            setResetOpen(false);
            if (done) setNotice({ kind: "info", key: done });
          }}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  notice: { fontSize: 13, textAlign: "center" },
  link: { fontSize: 12, fontWeight: "700", letterSpacing: 1.5, textAlign: "center" },
});
