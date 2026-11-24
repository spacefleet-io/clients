/**
 * ACCT-SIGNIN-05 on Badger desktop: what Badger hands the shared rows (`DesktopProviderSignIn`). The rows ask the API
 * which providers are on; a row starts the sign-in at the API and opens the provider in the system browser. The API
 * sends the browser back to `badger://auth/provider` with `signinCode` or `signinError`, main brings the app forward and
 * the sign-in screen trades the code (`useProviderReturn`).
 */
import { isClientUiLanguage } from "@space/shared";
import { providerReturnAddress } from "@space/shared/providerSignIn";
import { tooManyAttemptsText, type SignInErrorValues } from "@space/shared/signInError";
import type { ProviderSignInStart } from "@space/desktop-shell/provider-sign-in";
import { listSignInProviders, startProviderSignIn } from "../api";
import type { SignInProvider } from "../api";

/** The providers the API offers (`GET /auth/providers`). */
export const listBadgerProviders = (): Promise<SignInProvider[]> => listSignInProviders().then(({ providers }) => providers);

/**
 * Starts the sign-in at the API and opens the provider in the system browser (https only: the window-open handler hands
 * it to `shell.openExternal`). A refusal for too many attempts keeps its own sentence; any other failure gets the shared one.
 */
export const startBadgerProviderSignIn = async (
  provider: SignInProvider,
  clientChallenge: string,
  t: (key: string, values: SignInErrorValues) => string,
  language: string,
): Promise<ProviderSignInStart> => {
  try {
    const { url } = await startProviderSignIn(provider, {
      returnTo: providerReturnAddress("badger"),
      surface: "desktop",
      clientChallenge,
      ...(isClientUiLanguage(language) ? { uiLanguage: language } : {}),
    });
    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: tooManyAttemptsText(t, err) ?? undefined };
  }
};
