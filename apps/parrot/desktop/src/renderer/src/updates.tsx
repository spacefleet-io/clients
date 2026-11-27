/**
 * Automatic updates in Parrot's window (REL-UPD-01), over the shared desktop updater (`@space/desktop-shell/updater`).
 * The main process keeps the setting (ON unless the user turned it off), checks at start and every 6 hours, and
 * downloads in the background; a downloaded version installs the next time Parrot closes.
 *  - `ParrotUpdateSection`: Settings › About & updates, the shared `DesktopUpdateSection` (REL-UPD-05, the section
 *    Badger shows too) over `window.parrot.updater`, with the automatic-updates switch saved in main.
 *  - `UpdateReadyNotice`: on every screen, once a version has downloaded, a small card offers "Restart now". A mandatory
 *    update has its own blocking screen (`UpdateRequiredGate`), so the card stays out of its way, as in Badger.
 *  - `ParrotSystemUpdatePrompt`: a copy from SpaceFleet's .deb/.rpm/.pacman packages asks before updating through the
 *    package manager (REL-UPD-07, the shared `SystemUpdatePrompt`); a Flatpak copy shows `flatpak update`.
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@space/ui";
import { useDesktopUpdater, type DesktopUpdaterControls } from "@space/desktop-shell/updater-react";
import { DesktopUpdateSection } from "@space/desktop-shell/updater-section";
import { SystemUpdatePrompt } from "@space/desktop-shell/updater-system-prompt";
import type { ParrotLanguage } from "../../shared/ipc";
import type { Translate } from "./i18n";

const logUpdaterError = (message: string, context: string) => console.error(`[updater] ${context}: ${message}`);

const useParrotUpdater = (): DesktopUpdaterControls => useDesktopUpdater(window.parrot?.updater, logUpdaterError);

export function ParrotUpdateSection({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  return (
    <DesktopUpdateSection
      controls={updater}
      language={language}
      appName="Parrot"
      autoUpdate={{ checked: updater.state.autoUpdate, onCheckedChange: (on) => void updater.setAutoUpdate(on) }}
    />
  );
}

export function ParrotSystemUpdatePrompt({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  return <SystemUpdatePrompt controls={updater} language={language} appName="Parrot" />;
}

export function UpdateReadyNotice({ t }: { t: Translate }) {
  const { state, install } = useParrotUpdater();
  // Boxed so a downloaded update without a version can be dismissed too.
  const [dismissed, setDismissed] = useState<{ version: string | null } | null>(null);
  if (state.mandatory || state.phase !== "downloaded" || (dismissed !== null && dismissed.version === state.version)) return null;
  return (
    <div
      role="status"
      data-testid="update-ready-notice"
      className="fixed bottom-24 right-4 z-50 flex w-80 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <div className="font-semibold">{t("update.ready.title")}</div>
          <p className="text-sm text-muted-foreground">{state.version ? t("update.ready.body", { version: state.version }) : t("update.ready.bodyCurrent")}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setDismissed({ version: state.version })}>
          {t("update.later")}
        </Button>
        <Button type="button" size="sm" data-testid="update-ready-restart" onClick={install}>
          {t("update.restart")}
        </Button>
      </div>
    </div>
  );
}
