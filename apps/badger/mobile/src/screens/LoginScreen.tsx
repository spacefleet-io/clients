import React, { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ArrowRight, Lock, Mail } from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import {
  MobileStartupPage,
  MobileAuthBrand,
  MobileAuthInput,
  MobileAuthButton,
  MobileAuthLink,
  MobileApiHostModal,
  MobileLanguageMenu,
  MobileAuthSettingsBar,
  MobileOrDivider,
  MobilePhoneSignInCard,
  MobileProviderSignInRows,
  MobileSignUp,
  MobileSignUpTermsNotice,
  type MobileSignInProviderId,
} from "@space/mobile-shell/components";
import { useMobileProviderSignIn, type ProviderSignInNotice } from "@space/mobile-shell/provider-sign-in";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { ApiError, requestPasswordReset, confirmPasswordReset, type LoginDevice, type User } from "@space/shared/api";
import {
  classifySignInError,
  isRateLimited,
  signInErrorDetails,
  signInErrorMessageKey,
  signInErrorValues,
  TOO_MANY_ATTEMPTS_KEY,
} from "@space/shared/signInError";
import { getStoredApiHost, serverPickerAllowed, setStoredApiHost } from "../lib/apiConfig";
import { useAuth } from "../store/auth";
import { scopeLogger } from "@space/mobile-shell/logger";
import { chooseUiLanguage, ensureI18n } from "../lib/uiLanguage";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TV_PAIRING_DEVICE_TYPE } from "../tv/lib/pairingClient";
import { tvDeviceName } from "../tv/lib/pairingRuntime";
import { currentPhoneDeviceName } from "../lib/phonePairing";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [loading, setLoading] = useState(false);
  // Phone and TV (UX-TV-16, UX-PHONE-08): the keyboard's Next moves to the next field and Done signs in.
  const passwordRef = useRef<TextInputInstance>(null);
  const twoFactorRef = useRef<TextInputInstance>(null);
  // `error`, `info` and `resetMessage` hold i18n keys, translated at render so they follow a language switch.
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // The minutes the "too many attempts" sentence names, from the last refused request (ACCT-AUTH-11).
  const [errorValues, setErrorValues] = useState(() => signInErrorValues(null));
  // Phone only (ACCT-AUTH-10): the sign-up form, or its email code step (also opened by a sign-in whose email is unverified).
  const [mode, setMode] = useState<"signin" | "signup" | "verify">("signin");

  // Reset modal
  const [resetOpen, setResetOpen] = useState(false);
  const [resetStep, setResetStep] = useState<"request" | "confirm">("request");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetMessage, setResetMessage] = useState<string | null>(null);

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

  // Back closes the password-reset panel first; with nothing open it leaves the app (MainActivity keeps it alive).
  useEffect(() => {
    if (!resetOpen) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      log.info("reset.back");
      setResetOpen(false);
      setResetStep("request");
      setResetMessage(null);
      return true;
    });
    return () => sub.remove();
  }, [resetOpen]);

  // --- Google, Apple, Microsoft (phone only, ACCT-SIGNIN-05): buttons under the form, the browser comes back through
  // spacebadger://auth/provider (AppNavigator hands the link over). A second step reuses the code field below. ---
  const showProviderNotice = useCallback((notice: ProviderSignInNotice | null) => {
    setError(null);
    setInfo(null);
    // A provider sign-in started from the sign-up form comes back here, where its notice and second step show.
    if (notice) setMode("signin");
    if (notice?.kind === "error") {
      setErrorValues(notice.values ?? signInErrorValues(null));
      setError(notice.key);
    } else if (notice) {
      setInfo(notice.key);
    }
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
  const providerSecondStep = providerSignIn.secondStep !== null;

  // --- Login ---
  const handleLogin = useCallback(async () => {
    if (providerSecondStep) {
      await providerSignIn.submitSecondStep(twoFactor.trim());
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // The account's device list names this device ("Badger (Pixel 8)", the TV's model), not a bare "Phone": the
      // same name and type its QR sign-in gives (ACCT-DEV-01, ACCT-PAIR-05).
      await login(
        email.trim(),
        password,
        needsTwoFactor ? twoFactor.trim() : undefined,
        IS_TV ? { deviceType: TV_PAIRING_DEVICE_TYPE, deviceName: tvDeviceName() } : { deviceType: "mobile", deviceName: currentPhoneDeviceName() },
      );
    } catch (err) {
      const failure = classifySignInError(err);
      // Never the credentials: the kind, the HTTP status and the API's error code (ACCT-AUTH-11).
      log.warn("login.failed", { failure, ...signInErrorDetails(err) });
      if (failure === "twoFactorRequired" && err instanceof ApiError) {
        setNeedsTwoFactor(true);
        const method = err.payload.method === "totp" ? "totp" : "email";
        setInfo(method === "totp" ? "login.infoTotp" : "login.infoEmail");
      } else if (failure === "emailNotVerified" && !IS_TV) {
        // ACCT-AUTH-10: the account exists but its email was never verified: the code step, as on the desktop.
        setMode("verify");
      } else {
        setErrorValues(signInErrorValues(err));
        setError(signInErrorMessageKey(failure));
      }
    } finally {
      setLoading(false);
    }
  }, [email, login, needsTwoFactor, password, providerSecondStep, providerSignIn, twoFactor]);

  // --- Password reset ---
  const handleRequestReset = useCallback(async () => {
    if (!email.trim()) return;
    setLoading(true);
    setResetMessage(null);
    try {
      await requestPasswordReset(email.trim());
      setResetStep("confirm");
      setResetMessage("login.reset.noticeSent");
    } catch (err) {
      setErrorValues(signInErrorValues(err));
      setResetMessage(isRateLimited(err) ? TOO_MANY_ATTEMPTS_KEY : "login.reset.errorFailed");
    } finally {
      setLoading(false);
    }
  }, [email]);

  const handleConfirmReset = useCallback(async () => {
    if (newPassword !== resetConfirmPassword) {
      setResetMessage("login.reset.errorMismatch");
      return;
    }
    setLoading(true);
    setResetMessage(null);
    try {
      await confirmPasswordReset(email.trim(), resetCode.trim(), newPassword);
      setResetOpen(false);
      setResetStep("request");
      setResetCode("");
      setNewPassword("");
      setResetConfirmPassword("");
      setInfo("login.reset.noticeComplete");
    } catch (err) {
      setErrorValues(signInErrorValues(err));
      setResetMessage(isRateLimited(err) ? TOO_MANY_ATTEMPTS_KEY : "login.reset.errorInvalidCode");
    } finally {
      setLoading(false);
    }
  }, [email, newPassword, resetCode, resetConfirmPassword]);

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
          initialEmail={email.trim()}
          initialStep={mode === "verify" ? "verify" : "form"}
          language={lang}
          uiLanguage={isMobileUiLanguage(lang) ? lang : undefined}
          device={{ deviceType: "mobile", deviceName: currentPhoneDeviceName() }}
          onSignedIn={setSession}
          onSignIn={(typed) => {
            if (typed) setEmail(typed);
            setError(null);
            setInfo(null);
            setMode("signin");
          }}
          providerRows={providerRows("login.provider.signUpWith")}
        />
      </MobileStartupPage>
    );
  }

  return (
    <MobileStartupPage controls={controls} footer={<SignInSetupBack />}>
      <MobileAuthBrand iconSource={MASCOT} subtitle={t("login.withAccount").toUpperCase()} size={IS_TV ? undefined : PHONE_MASCOT_SIZE} />

      {error ? (
        <View style={[styles.notice, styles.errorNotice]}>
          <Text style={styles.errorText}>{t(error, errorValues)}</Text>
        </View>
      ) : null}
      {info ? (
        <View style={[styles.notice, styles.infoNotice, { borderColor: `${theme.colors.accent}44` }]}>
          <Text style={[styles.infoText, { color: theme.colors.accent }]}>{t(info)}</Text>
        </View>
      ) : null}

      {/* ---- SIGN IN (phone and TV; the phone also links to creating an account, ACCT-AUTH-10) ---- */}
      <View style={styles.fieldStack}>
        <MobileAuthInput testID="login-email" icon={Mail} value={email} onChangeText={setEmail} placeholder={t("login.emailLabel")} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} />
        <MobileAuthInput testID="login-password" icon={Lock} value={password} onChangeText={setPassword} placeholder={t("login.passwordLabel")} secureTextEntry textContentType="password" autoComplete="current-password" inputRef={passwordRef} {...(needsTwoFactor ? { returnKeyType: "next" as const, onSubmitEditing: () => twoFactorRef.current?.focus() } : { returnKeyType: "done" as const, onSubmitEditing: () => void handleLogin() })} />
        {needsTwoFactor || providerSecondStep ? (
          <MobileAuthInput testID="login-two-factor" icon={Lock} value={twoFactor} onChangeText={setTwoFactor} placeholder={t("login.twoFactorPlaceholder")} textContentType="oneTimeCode" autoComplete="one-time-code" inputRef={twoFactorRef} returnKeyType="done" onSubmitEditing={() => void handleLogin()} />
        ) : null}
      </View>

      <MobileAuthButton
        testID="login-submit"
        label={loading || providerSignIn.finishing ? t("login.signingIn") : t("login.button")}
        onPress={() => void handleLogin()}
        disabled={loading || providerSignIn.finishing}
        icon={<ArrowRight size={18} color={theme.accentTextHex} />}
      />

      <View style={styles.prompts}>
        <MobileAuthLink
          label={t("login.reset.button").toUpperCase()}
          color={theme.colors.textMuted}
          style={styles.promptText}
          onPress={() => { setResetOpen(true); setResetStep("request"); setResetMessage(null); }}
        />
      </View>

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
              setError(null);
              setInfo(null);
              setMode("signup");
            }}
            testID="login-create-account"
          />
        </View>
      )}

      {/* ---- QR SIGN-IN (phone; UX-PHONE-05, ACCT-SIGNIN-04): the form first, the card opening the code screen under it ---- */}
      {IS_TV ? null : <MobilePhoneSignInCard onPress={onQrSignIn} />}

      {/* ---- PASSWORD RESET MODAL ---- */}
      {resetOpen ? (
        <View style={styles.resetOverlay}>
          <View style={[styles.resetCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.resetTitle, { color: theme.colors.text }]}>{t("login.reset.title")}</Text>
            <Text style={[styles.resetSubtitle, { color: theme.colors.textMuted }]}>{t("login.reset.subtitle")}</Text>

            {resetMessage ? (
              <View style={[styles.notice, styles.infoNotice, { borderColor: `${theme.colors.accent}44` }]}>
                <Text style={[styles.infoText, { color: theme.colors.accent }]}>{t(resetMessage, errorValues)}</Text>
              </View>
            ) : null}

            {resetStep === "request" ? (
              <>
                <MobileAuthInput icon={Mail} value={email} onChangeText={setEmail} placeholder={t("login.reset.emailLabel")} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" />
                <MobileAuthButton label={loading ? t("login.reset.requesting") : t("login.reset.request")} onPress={() => void handleRequestReset()} disabled={loading} />
              </>
            ) : (
              <>
                <MobileAuthInput icon={Lock} value={resetCode} onChangeText={setResetCode} placeholder={t("login.reset.codePlaceholder")} textContentType="oneTimeCode" autoComplete="one-time-code" />
                <MobileAuthInput icon={Lock} value={newPassword} onChangeText={setNewPassword} placeholder={t("login.reset.passwordLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" />
                <MobileAuthInput icon={Lock} value={resetConfirmPassword} onChangeText={setResetConfirmPassword} placeholder={t("login.reset.passwordConfirmLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" />
                <MobileAuthButton label={loading ? t("login.reset.submitting") : t("login.reset.submit")} onPress={() => void handleConfirmReset()} disabled={loading} />
              </>
            )}

            <Pressable onPress={() => { setResetOpen(false); setResetStep("request"); setResetMessage(null); }}>
              <Text style={[styles.promptText, { color: theme.colors.accent, textAlign: "center" }]}>{t("login.reset.cancel").toUpperCase()}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

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
  );
};

const styles = StyleSheet.create({
  fieldStack: {
    gap: 10,
  },
  notice: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorNotice: {
    borderColor: "rgba(255,99,99,0.4)",
    backgroundColor: "rgba(255,99,99,0.1)",
  },
  errorText: {
    color: "#ff7f7f",
    fontSize: 12,
    textAlign: "center",
  },
  infoNotice: {
    backgroundColor: "rgba(255,170,84,0.08)",
  },
  infoText: {
    fontSize: 12,
    textAlign: "center",
  },
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
  resetOverlay: {
    marginTop: 10,
    gap: 10,
  },
  resetCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 12,
  },
  resetTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  resetSubtitle: {
    fontSize: 12,
    lineHeight: 18,
  },
});
