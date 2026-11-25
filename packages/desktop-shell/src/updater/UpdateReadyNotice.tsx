/**
 * The "update ready" card (REL-UPD-01), shared by Badger and Parrot desktop. Once a new version has downloaded in the
 * background, a small card on every screen says it installs the next time the app quits, with "Restart now" to
 * install it at once and "Later" to hide it for that version (a newer download shows it again; quitting installs the
 * update anyway). A mandatory update, and a screen the app marks `blocked` (its own update-required prompt), have
 * their blocking prompt, so the card stays out of their way.
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { Button, cn } from "@space/ui";
import { updateSectionText, type UpdateSectionStringKey } from "./strings";
import type { DesktopUpdaterControls } from "./useUpdater";

export type DesktopUpdateReadyNoticeProps = {
  controls: DesktopUpdaterControls;
  /** The window's UI language (an unknown one falls back to English). */
  language: string;
  /** The product name, never translated ("Badger", "Parrot"). */
  appName: string;
  /** True while the app's own blocking update prompt covers the window. */
  blocked?: boolean;
  /** Placement classes (the card is fixed; Parrot lifts it above its player bar). Defaults to the bottom-right corner. */
  className?: string;
};

export function DesktopUpdateReadyNotice({ controls, language, appName, blocked = false, className }: DesktopUpdateReadyNoticeProps) {
  const { state, install } = controls;
  // Boxed so a downloaded update without a version can be dismissed too.
  const [dismissed, setDismissed] = useState<{ version: string | null } | null>(null);
  if (blocked || state.mandatory || state.phase !== "downloaded" || (dismissed !== null && dismissed.version === state.version)) return null;
  const text = (key: UpdateSectionStringKey) => updateSectionText(language, key, { app: appName, version: state.version ?? "" });
  return (
    <div
      role="status"
      data-testid="update-ready-notice"
      className={cn(
        "fixed z-50 flex w-80 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-2xl",
        className ?? "bottom-4 right-4",
      )}
    >
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <div className="font-semibold">{text("readyTitle")}</div>
          <p className="text-sm text-muted-foreground">{text(state.version ? "readyBody" : "readyBodyCurrent")}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setDismissed({ version: state.version })}>
          {text("later")}
        </Button>
        <Button type="button" size="sm" data-testid="update-ready-restart" onClick={install}>
          {text("restartNow")}
        </Button>
      </div>
    </div>
  );
}
