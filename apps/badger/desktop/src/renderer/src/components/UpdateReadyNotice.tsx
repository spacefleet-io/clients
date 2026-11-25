import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "@space/ui";
import { useUpdater } from "@/lib/useUpdater";
import { loadClientConfig } from "@/lib/config";

/**
 * Automatic updates in the window (REL-UPD-01), on every screen, signed in or out:
 *  - at start, pushes the stored `autoUpdate` setting (ON by default) down to the main process, which arms the start-up
 *    check and the 6-hour background check (the Settings switch pushes later changes);
 *  - once a new version has downloaded in the background, a small notice says it installs the next time Badger
 *    quits, with "Restart now" to install it at once. "Later" hides it; quitting installs the update anyway.
 * A mandatory update has its own blocking prompt, so the notice stays out of its way.
 */
export default function UpdateReadyNotice({ blocked }: { blocked: boolean }) {
  const { t } = useTranslation();
  const { state, install } = useUpdater();
  // Boxed so a downloaded update without a version can be dismissed too.
  const [dismissed, setDismissed] = useState<{ version: string | null } | null>(null);

  useEffect(() => {
    void window.spaceBadger?.updater?.setAutoUpdate(loadClientConfig().autoUpdate);
  }, []);

  if (blocked || state.mandatory || state.phase !== "downloaded" || (dismissed !== null && dismissed.version === state.version)) return null;

  return (
    <div
      role="status"
      data-testid="update-ready-notice"
      className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-3 rounded-lg border border-[#30363d] bg-[#161b22] p-4 text-white shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 h-5 w-5 shrink-0 text-[#58a6ff]" aria-hidden />
        <div className="space-y-1">
          <div className="font-semibold">{t("updater.ready.title")}</div>
          <p className="text-sm text-[#8b949e]">
            {state.version ? t("updater.ready.body", { version: state.version }) : t("updater.ready.bodyCurrent")}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="border border-[#30363d] bg-[#0f141b] text-white"
          onClick={() => setDismissed({ version: state.version })}
        >
          {t("updater.available.later")}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="update-ready-restart"
          className="bg-[#238636] text-white hover:bg-[#2ea043]"
          onClick={install}
        >
          {t("updater.available.restart")}
        </Button>
      </div>
    </div>
  );
}
