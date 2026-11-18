import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@space/ui";
import { CreditsPanel, OpenSourceNotice } from "@space/desktop-shell/components";
import { desktopTourText, startDesktopTour } from "@space/desktop-shell/tour";
import { DesktopUpdateSection } from "@space/desktop-shell/updater-section";
import { useUpdater } from "@/lib/useUpdater";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { desktopCreditsSource } from "@/lib/metadataTickets";

/**
 * Settings > About & updates: the installed version, the updater's live state, its one Check / Download / Restart
 * button and the automatic-updates switch (REL-UPD-05, REL-UPD-01; shared with Parrot), then "Show the tour again"
 * (UX-TOUR-04), the GPL-3.0 line and the link to the source code (UX-SET-03), then the outside data sources' credits
 * (from the metadata service, META-SRC-09), kept out of the everyday screens.
 */
export default function AboutSection() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const updater = useUpdater();
  // The setting lives in the window's settings; `updateSetting` records the choice and tells the main process.
  const { config, updateSetting } = useClientSettings();
  return (
    <div className="space-y-4">
      <DesktopUpdateSection
        controls={updater}
        language={i18n.language}
        appName="Badger"
        autoUpdate={{ checked: config.autoUpdate, onCheckedChange: (enabled) => updateSetting("autoUpdate", enabled) }}
      />
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/60 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{desktopTourText(i18n.language, "showAgain")}</div>
          <div className="text-sm text-muted-foreground">{desktopTourText(i18n.language, "showAgainBody", { app: "Badger" })}</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          data-testid="settings-show-tour"
          onClick={() => {
            startDesktopTour();
            navigate("/home");
          }}
        >
          {desktopTourText(i18n.language, "showAgain")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        <OpenSourceNotice language={i18n.language} product="badger" />
      </p>
      <CreditsPanel language={i18n.language} product="badger" source={desktopCreditsSource} />
    </div>
  );
}
