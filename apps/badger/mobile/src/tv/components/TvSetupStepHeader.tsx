import React from "react";
import { MobileSetupHeader, MobileSetupTvHeaderPart } from "@space/mobile-shell/setup-step";
import { pendingSetupFeatures } from "@space/shared/appFeatures";
import { useAppSettings } from "../../lib/appSettings";
import { useProfiles } from "../../lib/profiles/profileStore";
import { chooseUiLanguage } from "../../lib/uiLanguage";
import { tvSetupPosition, type TvSetupStep } from "../lib/tvSetup";
import { useTvSetupProgress } from "../lib/tvSetupStore";

/**
 * "STEP N OF M", the segmented step bar and the language button (top-right, as on the TV's sign-in, UX-SETUP-08) on a
 * numbered TV setup screen: the phone's setup header, numbered over the TV's steps (the key only after a password
 * sign-in, "Your profile" when the profile still has its name and avatar to set (UX-SETUP-10), then error reports).
 * Before "Who's watching?" the profile is not picked yet: "Your profile" counts when any of the account's profiles has
 * it to do. Nothing once the setup is over ("Send error reports" answered: a later key screen is not part of a setup)
 * or when the step is not counted. The numbered steps are signed in: a pick is the account's too.
 * `part`: a TV screen of its own draws "STEP N OF M" and the bar inside its card (`steps`, at `scale`) and the language
 * button in its top-right corner (`language`); inside `MobileSetupStep` the step places them itself.
 */
export const TvSetupStepHeader = ({ step, part, scale }: { step: Exclude<TvSetupStep, "profile">; part?: "steps" | "language"; scale?: number }) => {
  const progress = useTvSetupProgress(true);
  const [{ errorReportsDecided }] = useAppSettings();
  const { profiles, activeId } = useProfiles();
  if (!progress || errorReportsDecided) return null;
  const candidates = profiles.filter((profile) => activeId === null || profile.id === activeId);
  const profilePending = candidates.some((profile) => pendingSetupFeatures(profile).includes("avatars"));
  const { step: n, total } = tvSetupPosition(progress, step, profilePending);
  if (n === 0) return null;
  const header = <MobileSetupHeader step={n} total={total} onLanguage={(code) => void chooseUiLanguage(code, { pushToAccount: true })} />;
  return part ? (
    <MobileSetupTvHeaderPart part={part} scale={scale}>
      {header}
    </MobileSetupTvHeaderPart>
  ) : (
    header
  );
};
