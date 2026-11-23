import React from "react";
import { MobileSetupHeader } from "@space/mobile-shell/setup-step";
import { useAppSettings } from "../../lib/appSettings";
import { chooseUiLanguage } from "../../lib/uiLanguage";
import { tvSetupPosition, type TvSetupStep } from "../lib/tvSetup";
import { useTvSetupProgress } from "../lib/tvSetupStore";

/**
 * "STEP N OF M", the segmented step bar and the language button (top-right, as on the TV's sign-in, UX-SETUP-08) on a
 * numbered TV setup screen: the phone's setup header, numbered over the TV's steps (the key only after a password
 * sign-in, then error reports). Nothing once the setup is over ("Send error reports" answered: a later key screen is not
 * part of a setup) or when the step is not counted. The numbered steps are signed in: a pick is the account's too.
 */
export const TvSetupStepHeader = ({ step }: { step: TvSetupStep }) => {
  const progress = useTvSetupProgress(true);
  const [{ errorReportsDecided }] = useAppSettings();
  if (!progress || errorReportsDecided) return null;
  const { step: n, total } = tvSetupPosition(progress, step);
  if (n === 0) return null;
  return <MobileSetupHeader step={n} total={total} onLanguage={(code) => void chooseUiLanguage(code, { pushToAccount: true })} />;
};
