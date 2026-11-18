import type { PhoneSetupStep } from "@space/mobile-shell/setup";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";

export type NavigatorScreen =
  | "loading"
  /** Badger phone's setup walkthrough (UX-SETUP-03) at a step of its own: language, notifications, error reports. */
  | "setup"
  /** Badger TV's "Choose your language" (UX-SETUP-08 step 0), before its sign-in. */
  | "tv-language"
  | "contract-error"
  | "format-too-new"
  | "loading-library"
  | "auth"
  | "onboarding"
  | "profiles"
  | "onboarding-reports"
  /** "How should titles appear?" on its own, right after a profile that never answered is picked (ACCT-PROF-03). */
  | "title-language"
  | "main";

/** "Who's watching?" state (`profileStore`): `choose` = must be answered, `loading` = first profile list not known yet. */
export type ProfileGate = "ready" | "choose" | "loading";

/**
 * Badger phone's setup (UX-SETUP-03): `step` already resolved against the session (`resolvePhoneSetupStep`), so the
 * sign-in and key steps show the sign-in and key screens. Absent on the TV, which keeps its gates (UX-SETUP-04) with
 * the language first (`tvLanguagePending`).
 */
export type SetupGate = { done: boolean; step: PhoneSetupStep; languageReconciled: boolean };

export const resolveNavigatorScreen = (input: {
  /**
   * The API refused this build as too old (REL-CD-29). Outranks everything, sign-in included: the refusal can come
   * from the very first call, and nothing else works until the app is updated.
   */
  updateRequired?: boolean;
  authLoading: boolean;
  user: unknown | null;
  contractIssue: string | null;
  /** True when a library surface is at a version newer than this build (D3). */
  formatTooNew: boolean;
  needsKey: boolean;
  /** The user has answered "Send error reports?" (REL-LOG-06). Asked once, after the key step, never again. */
  errorReportsAnswered: boolean;
  initializing: boolean;
  datasetStatus: { core: boolean };
  /** UX-PROF-01/02. Absent = ready (no question). */
  profiles?: ProfileGate;
  /** Absent = no walkthrough (TV). */
  setup?: SetupGate | null;
  /** Badger TV: the language (step 0) is not chosen yet (`tvSetup.ts`). Absent = chosen (phone). */
  tvLanguagePending?: boolean;
  /** The profile picked must answer "How should titles appear?" (ACCT-PROF-03, `useTitleLanguageQuestion`). */
  titleLanguageQuestion?: boolean;
}): NavigatorScreen => {
  if (input.updateRequired) return "contract-error";
  if (input.authLoading) return "loading";
  const setupOpen = input.setup !== undefined && input.setup !== null && !input.setup.done;
  // Badger phone: the language comes first, before the sign-in (UX-SETUP-08 step 0).
  if (setupOpen && input.setup!.step === "language") return "setup";
  // Badger TV: the language comes first too, before its sign-in (UX-SETUP-08 step 0).
  if (!input.user && input.tvLanguagePending) return "tv-language";
  if (!input.user) return "auth";
  // Right after the sign-in, the language picked before it is settled with the account's, before the key (UX-SETUP-08).
  if (setupOpen && !input.setup!.languageReconciled) return "setup";
  if (input.contractIssue) return "contract-error";
  // The format-too-new gate outranks key/loading: the library is genuinely
  // unreadable by this build, so no key entry or load progress is meaningful.
  if (input.formatTooNew) return "format-too-new";
  if (input.needsKey) return "onboarding";
  // "Who's watching?" comes before the library wait: the library keeps loading behind it, and the profile picked
  // decides which viewing state the first screen shows (ACCT-SQUAD-02). In the phone's setup it comes right after the
  // sign-in and the key, before the notifications screen (UX-SETUP-03, UX-PROF-01).
  if (input.profiles === "loading") return "loading";
  if (input.profiles === "choose") return "profiles";
  if (input.initializing || !input.datasetStatus.core) return "loading-library";
  // Badger phone: the title language, notifications and error reports, once the key is in and the library open
  // (UX-SETUP-03); the title language there is a numbered step of its own.
  if (setupOpen) return "setup";
  // ACCT-PROF-03: outside the phone's first setup (a profile created later, the TV), its own screen without a step
  // count, right after the profile is picked.
  if (input.titleLanguageQuestion) return "title-language";
  // Last gate before the app: after the key step and once the library is ready, so the question never races the
  // key check (needsKey and core readiness are not known yet right after sign-in). Never in a build that cannot send
  // reports (REL-LOG-06: a build with no reporting address, issue #2570).
  if (!input.errorReportsAnswered && errorReportsOffered()) return "onboarding-reports";
  return "main";
};
