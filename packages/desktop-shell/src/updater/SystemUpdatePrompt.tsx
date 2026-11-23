/**
 * The package-manager update modal (REL-UPD-07), shared by Badger and Parrot desktop. A copy installed from
 * SpaceFleet's .deb/.rpm/.pacman packages updates through the system's package manager, which needs the user's
 * password, so the app never installs silently: when the automatic check (at start, then every 6 hours) finds a
 * version, a modal asks "Badger 0.1.9 is available. Install now?".
 *  - Install now: the system's password window (pkexec), then the package manager updates ONLY this app's package.
 *  - Later: hides the modal for a day (per app and version, kept in localStorage); the next check after that asks again.
 *  - Then: progress; success → "Badger 0.1.9 is installed. Restarting Badger…" while the main process relaunches the
 *    app on its own (no click); failure → the reason and the command to run by hand, with a copy button. Without
 *    pkexec or a display (minimal window manager, headless) only the command is shown. When the package manager finds
 *    nothing newer (its repository does not list the version yet), it is no failure: "A new version is on its way.
 *    We'll offer it when it's ready." with Close, and the main process does not offer that version again for an hour.
 * Flatpak copies update through `flatpak update`: the modal only says so, with the command.
 * Turning automatic updates off in Settings (REL-UPD-01) turns the modal off; Settings › About keeps the same steps.
 */
import { useState } from "react";
import { AlertTriangle, Check, Clock, Copy, Download, Loader2, RotateCw } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { systemFailureKey, updateSectionText, type UpdateSectionStringKey } from "./strings";
import type { DesktopUpdaterControls } from "./useUpdater";
import type { UpdaterState } from "./types";

/** "Later" hides the prompt for this long. */
export const SYSTEM_PROMPT_SNOOZE_MS = 24 * 60 * 60 * 1000;

const snoozeKey = (appName: string) => `spacefleet.updater.snooze.${appName.toLowerCase()}`;

type Snooze = { version: string; until: number };

const readSnooze = (appName: string): Snooze | null => {
  try {
    const raw = globalThis.localStorage?.getItem(snoozeKey(appName));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && "version" in parsed && "until" in parsed) {
      const { version, until } = parsed as Record<string, unknown>;
      if (typeof version === "string" && typeof until === "number") return { version, until };
    }
  } catch (err) {
    console.warn("[updater] unreadable update snooze — ignoring it", err);
  }
  return null;
};

/** True while "Later" holds for this version (a newer version asks at once). */
export const isSnoozed = (appName: string, version: string | null, now: number = Date.now()): boolean => {
  const snooze = readSnooze(appName);
  return snooze !== null && snooze.version === (version ?? "") && snooze.until > now;
};

export const snoozeSystemPrompt = (appName: string, version: string | null, now: number = Date.now()): void => {
  try {
    globalThis.localStorage?.setItem(snoozeKey(appName), JSON.stringify({ version: version ?? "", until: now + SYSTEM_PROMPT_SNOOZE_MS }));
  } catch (err) {
    console.warn("[updater] couldn't keep the update snooze", err);
  }
};

/** The terminal command with a copy button (REL-UPD-07 manual fallback). */
export function ManualUpdateCommand({ command, text }: { command: string; text: (key: UpdateSectionStringKey) => string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch((err: unknown) => console.warn("[updater] copy of the manual update command failed", err));
  };
  return (
    <div className="space-y-1.5" data-testid="update-manual">
      <div className="text-sm text-muted-foreground">{text("manualHint")}</div>
      <div className="flex items-center gap-2">
        <code data-testid="update-manual-command" className="min-w-0 flex-1 select-all break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
          {command}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy} data-testid="update-manual-copy" aria-label={text("copy")}>
          {copied ? <Check className="mr-1.5 size-4" aria-hidden /> : <Copy className="mr-1.5 size-4" aria-hidden />}
          {text(copied ? "copied" : "copy")}
        </Button>
      </div>
    </div>
  );
}

/** What the prompt shows for this state, before snooze and dismissals; null = nothing. */
export const systemPromptView = (
  state: UpdaterState,
): "ask" | "manual" | "flatpak" | "installing" | "installed" | "pending" | "failed" | null => {
  if (state.mandatory || !state.autoUpdate) return null;
  if (state.channel === "flatpak") return state.phase === "available" ? "flatpak" : null;
  if (state.channel !== "system") return null;
  switch (state.phase) {
    case "available":
      return state.canInstall ? "ask" : "manual";
    case "installing":
      return "installing";
    case "installed":
      return "installed";
    case "error":
      return state.failure === "notNewer" ? "pending" : state.failure ? "failed" : null;
    default:
      return null;
  }
};

export type SystemUpdatePromptProps = {
  controls: DesktopUpdaterControls;
  language: string;
  appName: string;
  /** Another prompt owns the screen (the mandatory-update one). */
  blocked?: boolean;
};

export function SystemUpdatePrompt({ controls, language, appName, blocked = false }: SystemUpdatePromptProps) {
  const { state, download } = controls;
  const [closed, setClosed] = useState<{ version: string | null; phase: string } | null>(null);
  const [, setSnoozedAt] = useState(0);
  const text = (key: UpdateSectionStringKey) => updateSectionText(language, key, { app: appName, version: state.version ?? "" });
  const view = systemPromptView(state);
  if (blocked || !controls.supported || view === null) return null;
  if ((view === "ask" || view === "manual" || view === "flatpak") && isSnoozed(appName, state.version)) return null;
  if (closed !== null && closed.version === state.version && closed.phase === state.phase) return null;

  const later = (): void => {
    snoozeSystemPrompt(appName, state.version);
    setSnoozedAt(Date.now());
  };
  const close = (): void => setClosed({ version: state.version, phase: state.phase });
  const asking = view === "ask" || view === "manual" || view === "flatpak";
  // While the password window and the package manager run, and while the app restarts, nothing closes the modal.
  const busy = view === "installing" || view === "installed";
  const dismiss = asking ? later : close;

  const message =
    view === "ask"
      ? text("systemPrompt")
      : view === "manual"
        ? `${text("systemPrompt")} ${text("systemNoPasswordDialog")}`
        : view === "flatpak"
          ? text("flatpakHint")
          : view === "installing"
            ? text("installing")
            : view === "installed"
              ? text("installed")
              : text(systemFailureKey(state.failure));
  const Icon =
    view === "installing" ? Loader2 : view === "failed" ? AlertTriangle : view === "installed" ? RotateCw : view === "pending" ? Clock : Download;
  const showCommand = (view === "manual" || view === "flatpak" || view === "failed") && state.manualCommand;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) dismiss();
      }}
    >
      <DialogContent
        data-testid="system-update-prompt"
        data-view={view}
        role={view === "failed" ? "alertdialog" : "dialog"}
        className="max-w-md"
        hideCloseButton={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon
              className={`size-5 shrink-0 ${view === "failed" ? "text-destructive" : "text-primary"} ${busy ? "animate-spin" : ""}`}
              aria-hidden
            />
            {text(view === "failed" ? "systemFailedTitle" : "systemPromptTitle")}
          </DialogTitle>
          <DialogDescription className="text-foreground" data-testid="system-update-prompt-message">
            {message}
          </DialogDescription>
        </DialogHeader>
        {view === "failed" && state.failureDetail ? (
          <pre data-testid="system-update-prompt-detail" className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {state.failureDetail}
          </pre>
        ) : null}
        {busy ? (
          <div role="progressbar" aria-busy="true" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        ) : null}
        {showCommand ? <ManualUpdateCommand command={state.manualCommand ?? ""} text={text} /> : null}
        {busy ? null : (
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" data-testid="system-update-prompt-later" onClick={dismiss}>
              {text(asking ? "later" : "close")}
            </Button>
            {view === "ask" ? (
              <Button type="button" size="sm" data-testid="system-update-prompt-install" onClick={() => void download()}>
                {text("installNow")}
              </Button>
            ) : null}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
