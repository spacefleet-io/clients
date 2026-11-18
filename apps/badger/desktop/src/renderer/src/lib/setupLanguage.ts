/**
 * Whether this computer has answered setup step 0, "Choose your language" (UX-SETUP-08). Kept per computer: a new
 * computer asks again. A computer that is already signed in counts as answered, so an install that set up before this
 * step existed never sees it after a sign-out.
 */
const CHOSEN_KEY = "sf_setup_language_chosen_v1";

export const isSetupLanguageChosen = (): boolean => window.localStorage.getItem(CHOSEN_KEY) === "1";

export const markSetupLanguageChosen = (): void => {
  window.localStorage.setItem(CHOSEN_KEY, "1");
};
