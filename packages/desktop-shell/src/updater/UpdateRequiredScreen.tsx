/**
 * REL-CD-29: the screen Badger and Parrot desktop both show when this build is too old (an API call was refused with
 * "please update", or release-status reported the build below `minClientVersion`). It covers the whole window, sign-in
 * included, says why, and offers only the "About & updates" card (REL-UPD-05): check, download, restart. Nothing closes
 * it. The app decides when to mount it and runs its own one check per refusal; colours come from the app's theme.
 */
import { ArrowUpCircle } from "lucide-react";
import { DesktopUpdateSection, type DesktopUpdateSectionProps } from "./UpdateSection";
import { updateSectionText } from "./strings";

export function DesktopUpdateRequiredScreen(props: DesktopUpdateSectionProps) {
  const { language, appName } = props;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-required-title"
      data-testid="update-required"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-8"
    >
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-start gap-3">
          <ArrowUpCircle className="mt-0.5 size-7 shrink-0 text-primary" aria-hidden />
          <div className="space-y-2">
            <h1 id="update-required-title" className="text-xl font-semibold text-foreground">
              {updateSectionText(language, "requiredTitle", { app: appName })}
            </h1>
            <p className="text-sm text-muted-foreground">{updateSectionText(language, "requiredBody", { app: appName })}</p>
          </div>
        </div>
        <DesktopUpdateSection {...props} />
      </div>
    </div>
  );
}
