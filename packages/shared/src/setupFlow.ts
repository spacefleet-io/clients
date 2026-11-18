/**
 * The setup flow every client follows (UX-SETUP-08): the language first (step 0, before any sign-in), then the sign-in
 * or sign-up (not counted), then the setup steps numbered from 1 ("STEP 1 OF M"). A setup step whose answer is
 * account-wide and already given on another client is skipped; a device step (this device's folders, starting with the
 * computer, its notifications permission, its error reports, its copy of the library key) always shows.
 *
 * Pure: each client passes its own steps and what the account already holds.
 */

/** Where a setup step's answer is kept (accounts.md, which settings follow the account and which stay on the device). */
export type SetupStepScope = "account" | "device";

export type SetupStepSpec<Step extends string> = { step: Step; scope: SetupStepScope };

/**
 * The numbered steps this device shows, in order: every device step, and each account step the account has not
 * answered yet (`answeredOnAccount`), so a step answered on another client never comes back.
 */
export const setupStepsToShow = <Step extends string>(
  steps: ReadonlyArray<SetupStepSpec<Step>>,
  answeredOnAccount: ReadonlySet<Step> | ReadonlyArray<Step> = [],
): Step[] => {
  const answered = answeredOnAccount instanceof Set ? answeredOnAccount : new Set(answeredOnAccount);
  return steps.filter((spec) => spec.scope === "device" || !answered.has(spec.step)).map((spec) => spec.step);
};

/** "Step N of M" for a numbered setup step (1-based); 0 for a screen before them (the language, the sign-in). */
export const setupStepNumber = <Step extends string>(numbered: ReadonlyArray<Step>, step: Step): { step: number; total: number } => ({
  step: numbered.indexOf(step) + 1,
  total: numbered.length,
});
