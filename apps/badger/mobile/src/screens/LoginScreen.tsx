import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import {
  MobileStartupPage,
  MobileAuthBrand,
  MobileAuthLink,
  MobileApiHostModal,
  MobileLanguageMenu,
  MobileAuthSettingsBar,
  MobileOrDivider,
  MobilePasswordReset,
  MobilePasswordSignInForm,
  MobilePhoneSignInCard,
  MobileProviderSignInRows,
  MobileSignUp,
  MobileSignUpTermsNotice,
  useMobilePasswordSignIn,
  type MobileSignInProviderId,
} from "@space/mobile-shell/components";
import { useMobileProviderSignIn, type ProviderSignInNotice } from "@space/mobile-shell/provider-sign-in";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import type { LoginDevice, User } from "@space/shared/api";
import { getStoredApiHost, serverPickerAllowed, setStoredApiHost } from "../lib/apiConfig";
import { useAuth } from "../store/auth";
import { scopeLogger } from "@space/mobile-shell/logger";
import { chooseUiLanguage, ensureI18n } from "../lib/uiLanguage";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TV_PAIRING_DEVICE_TYPE } from "@space/mobile-shell/tv/pairingClient";
import { currentTvDeviceName } from "@space/mobile-shell/pairing-device";
import { createPhoneCompletionDeps, createPhonePairingClient, currentPhoneDeviceName } from "../lib/phonePairing";
import { completePairing } from "@space/mobile-shell/pairing";
import { MobileSiblingOffer } from "@space/mobile-shell/sibling-ui";
import { markPhoneSetupPaired } from "../setup/phoneSetupStore";
import { SignInSetupBack } from "../setup/BadgerSetupFlow";
import { BADGER_LINK_SCHEME } from "../lib/linkScheme";

const log = scopeLogger("login");
const MASCOT = require("../assets/mascot.webp");
/** The phone's sign-in mascot: about 59 % of the 80 dp shared one, which Chris found too big on a phone (UX-PHONE-05). */
export const PHONE_MASCOT_SIZE = 48;

const PROVIDER_NAMES: Record<MobileSignInProviderId, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

// Phones sign in and create free accounts; the TV only signs in (its "use password" path renders this screen without the
// create-account link). No price and no payment on either (ACCT-AUTH-10, ACCT-PAY-02).
export const LoginScreen = () => {
  const theme = useMobileShellTheme();
  const { login, setSession } = useAuth();
  const navigation = useNavigation();
  const [i18nReady, setI18nReady] = useState(false);

  useEffect(() => {
    const startedAt = Date.now();
    log.info("i18n.init.start");
    ensureI18n()
      .then(() => log.info("i18n.init.done", { ms: Date.now() - startedAt }))
      .catch((err) => log.error("i18n.init.failed", { message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setI18nReady(true));
  }, []);

  if (!i18nReady) return null;

  return (
    <AuthScreenInner theme={theme} login={login} setSession={setSession} onQrSignIn={() => navigation.navigate("PairSignIn" as never)} />
  );
};

const AuthScreenInner = ({
  theme,
  login,
  setSession,
  onQrSignIn,
}: {
  theme: ReturnType<typeof useMobileShellTheme>;
  login: (email: string, password: string, code?: string, device?: LoginDevice) => Promise<void>;
  /** Starts the session a Google, Apple or Microsoft sign-in returned (ACCT-SIGNIN-05). */
  setSession: (token: string, user: User) => Promise<void>;
  /** Opens the code sign-in (UX-PHONE-05, ACCT-PAIR-01). */
  onQrSignIn: () => void;
}) => {
  const { t } = useTranslation();
  // Phone only (ACCT-AUTH-10): the sign-up form, or its email code step (also opened by a sign-in whose email is unverified).
  const [mode, setMode] = useState<"signin" | "signup" | "verify">("signin");
  const [resetOpen, setResetOpen] = useState(false);
  // The line over the form: the password sign-in's, a provider's answer, the password reset's "done" (i18n keys).
  const [notice, setNotice] = useState<ProviderSignInNotice | null>(null);

  // API host modal: the server picker exists in development builds only (ACCT-AUTH-09), phone and TV alike.
  const serverPicker = serverPickerAllowed();
  const [apiHostVisible, setApiHostVisible] = useState(false);
  const [currentHost, setCurrentHost] = useState("");

  // Language
  const [lang, setLang] = useState(getCurrentLanguage());

  useEffect(() => {
    if (!serverPicker) return;
    void getStoredApiHost().then((v) => { if (v) setCurrentHost(v); });
  }, [serverPicker]);

  // --- Google, Apple, Microsoft (phone only, ACCT-SIGNIN-05): buttons under the form, the browser comes back through
  // spacebadger://auth/provider (AppNavigator hands the link over). A second step reuses the form's code field. ---
  const showProviderNotice = useCallback((next: ProviderSignInNotice | null) => {
    // A provider sign-in started from the sign-up form comes back here, where its notice and second step show.
    if (next) setMode("signin");
    setNotice(next);
  }, []);
  const providerSignIn = useMobileProviderSignIn({
    scheme: BADGER_LINK_SCHEME,
    enabled: !IS_TV,
    storage: AsyncStorage,
    device: { deviceType: "mobile", deviceName: IS_TV ? undefined : currentPhoneDeviceName() },
    uiLanguage: isMobileUiLanguage(lang) ? lang : undefined,
    setSession,
    onNotice: showProviderNotice,
  });

  // --- Email and password (phone and TV): the shared form. The account's device list names this device ("Badger
  // (Pixel 8)", the TV's model), not a bare "Phone": the same name and type its QR sign-in gives (ACCT-DEV-01, ACCT-PAIR-05). ---
  const form = useMobilePasswordSignIn({
    login: (email, password, code) =>
      login(
        email,
        password,
        code,
        IS_TV ? { deviceType: TV_PAIRING_DEVICE_TYPE, deviceName: currentTvDeviceName() } : { deviceType: "mobile", deviceName: currentPhoneDeviceName() },
      ),
    providerStep: {
      method: providerSignIn.secondStep?.method ?? null,
      finishing: providerSignIn.finishing,
      submit: providerSignIn.submitSecondStep,
    },
    // ACCT-AUTH-10: the account exists but its email was never verified: the code step, as on the desktop. The TV has none.
    onUnverified: IS_TV ? undefined : () => setMode("verify"),
    notice,
    setNotice,
  });

  // --- Language ---
  const handleLanguageChange = useCallback(async (code: string) => {
    if (!isMobileUiLanguage(code)) return;
    // Signed out: nothing to push; once signed in, the account's language wins (UX-I18N-01).
    await chooseUiLanguage(code, { pushToAccount: false });
    setLang(code);
  }, []);

  // --- API Host ---
  const handleApiHostSave = useCallback(async (host: string) => {
    await setStoredApiHost(host);
    setCurrentHost(host);
  }, []);

  const controls = (
    <MobileAuthSettingsBar
      languageMenu={
        <MobileLanguageMenu
          current={lang}
          onSelect={(c) => void handleLanguageChange(c)}
          languages={MOBILE_UI_LANGUAGES}
        />
      }
      onApiHostPress={serverPicker ? () => setApiHostVisible(true) : undefined}
    />
  );

  const providerRows = (labelKey: "login.provider.signInWith" | "login.provider.signUpWith") =>
    !IS_TV && providerSignIn.providers.length > 0 ? (
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

  if (!IS_TV && mode !== "signin") {
    return (
      <MobileStartupPage controls={controls} footer={<SignInSetupBack />}>
        <MobileAuthBrand iconSource={MASCOT} size={PHONE_MASCOT_SIZE} />
        <MobileSignUp
          key={mode}
          initialEmail={form.email.trim()}
          initialStep={mode === "verify" ? "verify" : "form"}
          language={lang}
          uiLanguage={isMobileUiLanguage(lang) ? lang : undefined}
          device={{ deviceType: "mobile", deviceName: currentPhoneDeviceName() }}
          onSignedIn={setSession}
          onSignIn={(typed) => {
            if (typed) form.setEmail(typed);
            setNotice(null);
            setMode("signin");
          }}
          providerRows={providerRows("login.provider.signUpWith")}
        />
      </MobileStartupPage>
    );
  }

  return (
    <View style={styles.root}>
      <MobileStartupPage controls={controls} footer={<SignInSetupBack />}>
        <MobileAuthBrand iconSource={MASCOT} subtitle={t("login.withAccount").toUpperCase()} size={IS_TV ? undefined : PHONE_MASCOT_SIZE} />
        {/* ACCT-PAIR-07: Parrot signed in on this phone → "Continue with your Parrot account", above the form. */}
        <MobileSiblingOffer
          app="badger"
          enabled={!IS_TV}
          createClient={() => createPhonePairingClient()}
          complete={async (approved) => {
            const completion = await completePairing(createPhoneCompletionDeps(setSession), approved);
            // The sister app brought the key, as a pairing does: the setup's key screen does not apply (UX-SETUP-03).
            if (completion.ok) await markPhoneSetupPaired();
            return completion;
          }}
          logTag="phone.sibling"
        />

        {/* ---- SIGN IN (phone and TV; the phone also links to creating an account, ACCT-AUTH-10): the shared form ---- */}
        <MobilePasswordSignInForm form={form} onForgot={() => setResetOpen(true)} />

        {/* ---- GOOGLE, APPLE, MICROSOFT (phone only, ACCT-SIGNIN-05): an "or" line under the form, its button and "Forgot password?" (which belongs to the password sign-in), then only the providers the server offers. A new email gets a free account, so the sign-up line sits under them (ACCT-AUTH-10). ---- */}
        {providerRows("login.provider.signInWith")}
        {!IS_TV && providerSignIn.providers.length > 0 ? <MobileSignUpTermsNotice language={lang} testID="provider-terms-notice" /> : null}

        {/* ---- CREATE AN ACCOUNT (phone only, ACCT-AUTH-10): a free account; no price, no payment ---- */}
        {IS_TV ? null : (
          <View style={styles.prompts}>
            <MobileAuthLink
              label={`${t("login.noAccountPrompt")} ${t("login.createAccount")}`.toUpperCase()}
              color={theme.colors.accent}
              style={styles.promptText}
              onPress={() => {
                setNotice(null);
                setMode("signup");
              }}
              testID="login-create-account"
            />
          </View>
        )}

        {/* ---- QR SIGN-IN (phone; UX-PHONE-05, ACCT-SIGNIN-04): the form first, the card opening the code screen under it ---- */}
        {IS_TV ? null : <MobilePhoneSignInCard onPress={onQrSignIn} />}

        {/* ---- API HOST MODAL (development builds only, ACCT-AUTH-09) ---- */}
        {serverPicker ? (
          <MobileApiHostModal
            visible={apiHostVisible}
            onClose={() => setApiHostVisible(false)}
            currentHost={currentHost}
            onSave={handleApiHostSave}
            labels={{
              title: t("authApiHost.title"),
              subtitle: t("authApiHost.subtitle"),
              label: t("authApiHost.label"),
              placeholder: t("authApiHost.placeholder"),
              hint: t("authApiHost.hint"),
              useDefault: t("authApiHost.useDefault"),
              save: t("authApiHost.save"),
              saving: t("authApiHost.saving"),
              error: t("authApiHost.error"),
            }}
          />
        ) : null}
      </MobileStartupPage>
      {/* ---- PASSWORD RESET: the shared card over the form (Back or Cancel closes it) ---- */}
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
  root: { flex: 1 },
  prompts: {
    gap: 6,
    alignItems: "center",
    marginTop: 4,
  },
  promptText: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.8,
    textAlign: "center",
  },
});
