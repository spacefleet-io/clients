/**
 * Settings › "About & updates" (REL-UPD-05), the one section Badger and Parrot desktop both mount: the installed
 * version, what the updater is doing right now, ONE button whose action follows that state (Check for updates →
 * Download update → Restart to update) and the automatic-updates switch (REL-UPD-01). The button works with automatic
 * updates off too; with them on, a check that finds a version downloads it at once (main's `autoDownload`; asking
 * again here is deduplicated by electron-updater).
 *
 * The app passes its own updater controls (`useDesktopUpdater` over its preload bridge) and its own setting, since
 * Badger keeps the switch in the window's settings and Parrot in the main process.
 */
import { AlertTriangle, CheckCircle2, Download, Info, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { Button, Switch } from "@space/ui";
import type { UpdaterPhase } from "./types";
import type { DesktopUpdaterControls } from "./useUpdater";
import { updateErrorKey, updateSectionText, type UpdateSectionStringKey } from "./strings";

export type UpdateSectionAction = "check" | "download" | "restart";

export type DesktopUpdateSectionProps = {
  controls: DesktopUpdaterControls;
  /** The window's UI language (`en`, `fr`, `nl`, `de`, `es`; anything else reads English). */
  language: string;
  /** Product name in the sentences ("Badger", "Parrot"). */
  appName: string;
  /** The automatic-updates setting as the app stores it. */
  autoUpdate: { checked: boolean; onCheckedChange: (enabled: boolean) => void };
};

/** What the one button does in each phase; null = no button (no in-app updater in this copy). */
export const updateSectionAction = (phase: UpdaterPhase): UpdateSectionAction | null => {
  switch (phase) {
    case "downloaded":
      return "restart";
    case "available":
    case "downloading":
      return "download";
    case "unsupported":
      return null;
    default:
      return "check";
  }
};

/** "14:05" for a check today, "12 Nov 2026, 14:05" for an older one, in the window's language. */
export const formatCheckedAt = (at: number, language: string, now: number = Date.now()): string => {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  try {
    return new Intl.DateTimeFormat(language, sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
};

const BUTTON_LABEL: Record<UpdateSectionAction, UpdateSectionStringKey> = { check: "check", download: "download", restart: "restart" };

export function DesktopUpdateSection({ controls, language, appName, autoUpdate }: DesktopUpdateSectionProps) {
  const { state, supported, check, download, install } = controls;
  const phase: UpdaterPhase = supported ? state.phase : "unsupported";
  const text = (key: UpdateSectionStringKey, values: Parameters<typeof updateSectionText>[2] = {}) =>
    updateSectionText(language, key, { app: appName, ...values });
  const version = state.version ?? "";
  const action = updateSectionAction(phase);
  const busy = phase === "checking" || phase === "downloading";

  const status =
    phase === "checking"
      ? text("checking")
      : phase === "available"
        ? text("available", { version })
        : phase === "downloading"
          ? text("downloading", { version, percent: Math.round(state.progress) })
          : phase === "downloaded"
            ? text("ready", { version })
            : phase === "error"
              ? text(updateErrorKey(state.errorMessage))
              : phase === "unsupported"
                ? text("unsupported")
                : state.lastCheckedAt !== null
                  ? text("upToDate", { time: formatCheckedAt(state.lastCheckedAt, language) })
                  : text("notChecked");

  const StatusIcon =
    phase === "checking" || phase === "downloading"
      ? Loader2
      : phase === "error"
        ? AlertTriangle
        : phase === "available" || phase === "downloaded"
          ? Download
          : phase === "idle" && state.lastCheckedAt !== null
            ? CheckCircle2
            : Info;
  const statusTone =
    phase === "error" ? "text-destructive" : phase === "available" || phase === "downloaded" ? "text-primary" : "text-muted-foreground";

  const onAction = (): void => {
    if (action === "restart") install();
    else if (action === "download") void download();
    else if (action === "check") {
      // Automatic mode is already downloading what the check finds; asking here only shows it at once.
      void check().then((found) => (found === "available" && state.autoUpdate ? download() : undefined));
    }
  };

  const ActionIcon = action === "restart" ? RotateCw : action === "download" ? Download : RefreshCw;

  return (
    <section data-testid="update-section" aria-label={text("title")} className="rounded-xl border border-border bg-card/60">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-foreground">{appName}</div>
          <div className="text-sm text-muted-foreground" data-testid="update-section-version">
            {text("version", { version: state.currentVersion ?? "…" })}
          </div>
        </div>
        {action ? (
          <Button
            type="button"
            variant={action === "check" ? "outline" : "default"}
            disabled={busy}
            onClick={onAction}
            data-testid="update-section-action"
            data-action={action}
          >
            <ActionIcon className="mr-2 size-4" aria-hidden />
            {text(BUTTON_LABEL[action])}
          </Button>
        ) : null}
      </div>
      <div className="space-y-2 px-4 pb-4">
        <p
          role="status"
          aria-live="polite"
          data-testid="update-section-status"
          data-phase={phase}
          data-checked={state.lastCheckedAt !== null ? "1" : "0"}
          className={`flex items-start gap-2 text-sm ${statusTone}`}
        >
          <StatusIcon className={`mt-0.5 size-4 shrink-0 ${busy ? "animate-spin" : ""}`} aria-hidden />
          <span className="min-w-0 break-words">{status}</span>
        </p>
        {phase === "downloading" ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress)}
            data-testid="update-section-progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(2, Math.min(100, state.progress))}%` }} />
          </div>
        ) : null}
      </div>
      {phase !== "unsupported" ? (
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium text-foreground">{text("autoLabel")}</div>
            <div className="text-sm text-muted-foreground">{text("autoHint")}</div>
          </div>
          <Switch
            aria-label={text("autoLabel")}
            data-testid="settings-auto-update-switch"
            checked={autoUpdate.checked}
            onCheckedChange={autoUpdate.onCheckedChange}
          />
        </div>
      ) : null}
    </section>
  );
}
