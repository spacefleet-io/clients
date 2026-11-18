// The sign-in, FIRST, before and outside the setup (UX-SETUP-06): the approved phone design — the language menu top
// right, the floating mascot, "SIGN IN WITH YOUR ACCOUNT", Email and Password, the green "Sign in →" and
// "FORGOT PASSWORD?" — over the starry sky (UX-SKY-01). It opens on that form (ACCT-SIGNIN-04); the shared highlighted
// "Sign in with another device" card under it swaps the form for the pairing code any signed-in Badger or Parrot app
// approves (ACCT-PAIR-01), and "Sign in with email and password" comes back. Sign-in only: no sign-up (ACCT-AUTH-10).
// The Google, Apple and Microsoft rows the server offers sit above an "or" line over the form (ACCT-SIGNIN-05).
// A session the server rejected comes back here with a short explanation.
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowRight, Lock, Mail } from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MobileAuthBrand,
  MobileAuthButton,
  MobileAuthInput,
  MobileAuthLink,
  MobileAuthSettingsBar,
  MobileLanguageMenu,
  MobileOrDivider,
  MobilePasswordReset,
  MobilePhoneSignInCard,
  MobileProviderSignInRows,
  MobileStartupPage,
} from "@space/mobile-shell/components";
import type { MobileSignInProviderId } from "@space/mobile-shell/components";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { MobileSetupHeader } from "@space/mobile-shell/setup-step";
import { useMobileProviderSignIn } from "@space/mobile-shell/provider-sign-in";
import type { ProviderSignInNotice } from "@space/mobile-shell/provider-sign-in";
import { ApiError, login } from "@space/shared/api";
import type { User } from "@space/shared/api";
import { classifySignInError, signInErrorDetails, signInErrorMessageKey, signInErrorValues } from "@space/shared/signInError";
import { scopeLogger } from "@space/mobile-shell/logger";
import { useSession } from "../state/session";
import { setParrotLanguage } from "../lib/i18n";
import { PARROT_LINK_SCHEME } from "../lib/linkScheme";
import { PARROT_MASCOT } from "../brand";
import { PairingPanel } from "./PairingPanel";
import { currentPhoneDeviceName } from "@space/mobile-shell/pairing-device";

const log = scopeLogger("login");

const PROVIDER_NAMES: Record<MobileSignInProviderId, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };

/** A provider sign-in that came back asking for the account's second step, and its trade in progress. */
type ProviderStep = {
  method: "totp" | "email" | null;
  finishing: boolean;
  submit: (code: string) => Promise<void>;
};

/**
 * Email, password and (when asked) the two-factor code; resolves into a signed-in session. After a provider return that
 * asks for the second step, the code field alone finishes that sign-in.
 */
const PasswordSignInForm = ({
  onForgot,
  email,
  setEmail,
  provider,
}: {
  onForgot: () => void;
  email: string;
  setEmail: (value: string) => void;
  provider: ProviderStep;
}) => {
  const { signIn } = useSession();
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState<null | "totp" | "email">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeMethod = provider.method ?? needsCode;
  const working = busy || provider.finishing;
  const ready = provider.method ? !!code.trim() : !!email.trim() && !!password && (!needsCode || !!code.trim());

  const submit = async () => {
    if (!ready) return;
    setError(null);
    if (provider.method) {
      await provider.submit(code.trim());
      return;
    }
    setBusy(true);
    try {
      const result = await login(email.trim(), password, needsCode ? code.trim() : undefined, undefined, {
        deviceType: "mobile",
        // "Parrot (Pixel 8)": the name this phone's session carries in the account's device list (ACCT-PAIR-05).
        deviceName: currentPhoneDeviceName("Parrot"),
      });
      await signIn({
        token: result.token,
        user: { id: result.user.id, email: result.user.email, emailVerified: !!result.user.emailVerified },
      });
    } catch (err) {
      const failure = classifySignInError(err);
      if (failure === "twoFactorRequired" && err instanceof ApiError) {
        setNeedsCode(err.payload?.method === "totp" ? "totp" : "email");
      } else {
        log.warn("login.failed", signInErrorDetails(err));
        setError(t(signInErrorMessageKey(failure), signInErrorValues(err)));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error ? <Text style={[styles.notice, { color: theme.colors.danger }]}>{error}</Text> : null}
      <View style={styles.fields}>
        <MobileAuthInput icon={Mail} value={email} onChangeText={setEmail} placeholder={t("login.emailLabel")} keyboardType="email-address" autoCapitalize="none" textContentType="emailAddress" autoComplete="email" />
        <MobileAuthInput icon={Lock} value={password} onChangeText={setPassword} placeholder={t("login.passwordLabel")} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="done" onSubmitEditing={() => void submit()} />
        {codeMethod ? (
          <MobileAuthInput
            testID="login-two-factor"
            icon={Lock}
            value={code}
            onChangeText={setCode}
            placeholder={codeMethod === "totp" ? t("parrot.login.codeTotp") : t("parrot.login.codeEmail")}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
          />
        ) : null}
      </View>
      <MobileAuthButton
        testID="login-submit"
        label={working ? t("login.signingIn") : t("login.button")}
        onPress={() => void submit()}
        disabled={working || !ready}
        icon={<ArrowRight size={18} color={theme.accentTextHex} />}
      />
      <MobileAuthLink label={t("login.reset.button").toUpperCase()} color={theme.colors.textMuted} style={styles.link} onPress={onForgot} />
    </>
  );
};

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
  const [mode, setMode] = useState<"password" | "phone">("password");
  const [email, setEmail] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<ProviderSignInNotice | null>(null);
  const [lang, setLang] = useState(() => getCurrentLanguage());

  // Google, Apple, Microsoft (ACCT-SIGNIN-05): the browser comes back through parrot://auth/provider (App.tsx hands the
  // link over, even while the pairing panel shows); a phone never creates an account, so `no_account` is said in words.
  const startProviderSession = useCallback(
    (token: string, user: User) => signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } }),
    [signIn]
  );
  const showProviderNotice = useCallback((notice: ProviderSignInNotice | null) => {
    setInfo(null);
    setProviderNotice(notice);
    if (notice) setMode("password");
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
  const providerStep: ProviderStep = {
    method: providerSignIn.secondStep?.method ?? null,
    finishing: providerSignIn.finishing,
    submit: providerSignIn.submitSecondStep,
  };

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

  return (
    <View style={{ flex: 1 }} testID="sign-in">
      <MobileStartupPage controls={controls}>
        {onBack ? <MobileSetupHeader step={0} total={0} onBack={onBack} /> : null}
        <MobileAuthBrand iconSource={PARROT_MASCOT} subtitle={t("login.withAccount").toUpperCase()} />
        <SignInNoticeText />
        {info ? <Text style={[styles.notice, { color: theme.colors.accent }]}>{t(info)}</Text> : null}
        {providerNotice ? (
          <Text testID="provider-sign-in-notice" style={[styles.notice, { color: providerNotice.kind === "error" ? theme.colors.danger : theme.colors.accent }]}>
            {t(providerNotice.key, providerNotice.values)}
          </Text>
        ) : null}
        {mode === "password" ? (
          <>
            <PasswordSignInForm email={email} setEmail={setEmail} onForgot={() => setResetOpen(true)} provider={providerStep} />
            {providerSignIn.providers.length > 0 ? (
              <>
                <MobileOrDivider label={t("login.provider.or")} testID="provider-sign-in-divider" />
                <MobileProviderSignInRows
                  providers={providerSignIn.providers}
                  busy={providerSignIn.busy}
                  label={(provider) => t("login.provider.signInWith", { provider: PROVIDER_NAMES[provider] })}
                  onSelect={(provider) => void providerSignIn.start(provider)}
                />
              </>
            ) : null}
            <MobilePhoneSignInCard onPress={() => setMode("phone")} />
          </>
        ) : (
          <>
            <PairingPanel onPaired={onPaired ?? (async () => undefined)} />
            <Pressable testID="sign-in-use-password" accessibilityRole="button" onPress={() => setMode("password")} hitSlop={8}>
              <Text style={[styles.switch, { color: theme.colors.accent }]}>{t("parrot.login.usePassword")}</Text>
            </Pressable>
          </>
        )}
      </MobileStartupPage>
      {resetOpen ? (
        <MobilePasswordReset
          initialEmail={email}
          onDone={(notice) => {
            setResetOpen(false);
            setProviderNotice(null);
            setInfo(notice);
          }}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fields: { gap: 12, alignSelf: "stretch" },
  notice: { fontSize: 13, textAlign: "center" },
  link: { fontSize: 12, fontWeight: "700", letterSpacing: 1.5, textAlign: "center" },
  switch: { fontSize: 14, fontWeight: "600", textAlign: "center", paddingVertical: 8 },
});
