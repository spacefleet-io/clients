/**
 * The update modal (REL-UPD-08, with the package-manager steps of REL-UPD-07), shared by Badger and Parrot desktop.
 * The main process checks on its own (at start, every 4 hours, when the computer wakes, when the window comes back
 * after an hour), so a user who never opens Settings still gets the new version offered:
 *  - channel `self` (AppImage, Windows, macOS): once the version has downloaded in the background, "Badger 0.1.9 has
 *    downloaded…" with Restart now.
 *  - channel `system` (.deb/.rpm/.pacman): "Badger 0.1.9 is available. Install now?" with Install now (the system's
 *    password window, then the package manager); without pkexec or a display it says why there is no Install button
 *    and shows the command to run by hand. Then progress, "installed, restarting", or the failure with the command.
 *  - channel `flatpak`: the same steps through the Flatpak portal (which may ask the user to allow the update), with
 *    the portal's progress; where the portal is missing (flatpak older than 1.5), why, and the `flatpak update` command.
 * Beside the install button: Remind me later (this version, 24 hours, until the app restarts; kept in main) and
 * Ignore (this version, kept across restarts: it no longer installs on quit; Settings › About still offers it, and a
 * newer version asks again).
 * A mandatory update has its blocking screen instead (never Later/Ignore), and a screen the app marks `blocked` (its
 * own update-required prompt) owns the window. With automatic updates off the modal never opens.
 * The question waits while something plays (`<html data-app-playback>`), and while the app is busy with work a
 * restart would cut (`<html data-app-busy>`) unless the user has been away from the keyboard and mouse for
 * `UPDATE_PROMPT_IDLE_MS`; it then says that restarting interrupts that work.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Copy, Download, Loader2, RotateCw } from "lucide-react";
import { APP_BUSY_ATTRIBUTE } from "@space/ui/app-busy-mark";
import { APP_PLAYBACK_ATTRIBUTE } from "@space/ui/app-playback-mark";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { systemFailureKey, updateSectionText, type UpdateSectionStringKey } from "./strings";
import type { DesktopUpdaterControls } from "./useUpdater";
import type { UpdaterState } from "./types";

/** A busy app still gets the question once the user has left keyboard and mouse alone this long. */
export const UPDATE_PROMPT_IDLE_MS = 5 * 60 * 1000;

/** The terminal command with a copy button (REL-UPD-07 manual fallback). `hint` off when the text above already leads into it (Flatpak). */
export function ManualUpdateCommand({
  command,
  text,
  hint = true,
}: {
  command: string;
  text: (key: UpdateSectionStringKey) => string;
  hint?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch((err: unknown) => console.warn("[updater] copy of the manual update command failed", err));
  };
  return (
    <div className="space-y-1.5" data-testid="update-manual">
      {hint ? <div className="text-sm text-muted-foreground">{text("manualHint")}</div> : null}
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

export type UpdatePromptView = "ready" | "ask" | "manual" | "flatpak" | "installing" | "installed" | "pending" | "failed";

/** The views that ask the user about a version (Later/Ignore apply, the no-interrupt hold applies). */
const isAsking = (view: UpdatePromptView): boolean => view === "ready" || view === "ask" || view === "manual" || view === "flatpak";

/**
 * What the modal shows for this state, before Later/Ignore, the hold and closes; null = nothing. A Flatpak the portal
 * can update goes through the same steps as a system package; without the portal it only shows the command.
 */
export const updatePromptView = (state: UpdaterState): UpdatePromptView | null => {
  if (state.mandatory || !state.autoUpdate) return null;
  if (state.channel === "self") return state.phase === "downloaded" ? "ready" : null;
  switch (state.phase) {
    case "available":
      return state.canInstall ? "ask" : state.channel === "flatpak" ? "flatpak" : "manual";
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

/** True while the user's Later or Ignore holds this version back (a newer version asks at once). */
export const isHeldByUser = (state: UpdaterState, now: number = Date.now()): boolean =>
  state.version !== null &&
  (state.ignoredVersion === state.version || (state.remindLater !== null && state.remindLater.version === state.version && state.remindLater.until > now));

const hasMark = (attribute: string): boolean => typeof document !== "undefined" && document.documentElement.hasAttribute(attribute);

/** Watches the playing/busy marks on `<html>` and the user's last keyboard or mouse input. */
const useActivity = (): { playing: boolean; busy: boolean; idleFor: () => number } => {
  const [marks, setMarks] = useState(() => ({ playing: hasMark(APP_PLAYBACK_ATTRIBUTE), busy: hasMark(APP_BUSY_ATTRIBUTE) }));
  const [lastInput] = useState(() => ({ at: Date.now() }));
  useEffect(() => {
    const read = () => {
      const next = { playing: hasMark(APP_PLAYBACK_ATTRIBUTE), busy: hasMark(APP_BUSY_ATTRIBUTE) };
      setMarks((prev) => (prev.playing === next.playing && prev.busy === next.busy ? prev : next));
    };
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [APP_PLAYBACK_ATTRIBUTE, APP_BUSY_ATTRIBUTE] });
    read();
    const touch = () => {
      lastInput.at = Date.now();
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true, capture: true });
    return () => {
      observer.disconnect();
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
    };
  }, [lastInput]);
  return { ...marks, idleFor: () => Date.now() - lastInput.at };
};

export type DesktopUpdatePromptProps = {
  controls: DesktopUpdaterControls;
  /** The window's UI language (an unknown one falls back to English). */
  language: string;
  /** The product name, never translated ("Badger", "Parrot"). */
  appName: string;
  /** Another prompt owns the screen (the app's own update-required one). */
  blocked?: boolean;
};

export function DesktopUpdatePrompt({ controls, language, appName, blocked = false }: DesktopUpdatePromptProps) {
  const { state, download, install, remindLater, ignoreVersion } = controls;
  // Close on a result view (failed, pending), or on a ready update without a version (Later/Ignore need one).
  const [closed, setClosed] = useState<{ version: string | null; phase: string } | null>(null);
  const [, setTick] = useState(0);
  const activity = useActivity();
  // Install (or, without it, Later / Close) takes the focus on open — never Ignore, which Enter must not hit by accident.
  const focusRef = useRef<HTMLButtonElement>(null);
  const view = updatePromptView(state);
  const asking = view !== null && isAsking(view);
  const heldByUser = asking && isHeldByUser(state);
  const idle = activity.idleFor() >= UPDATE_PROMPT_IDLE_MS;
  const heldByActivity = asking && (activity.playing || (activity.busy && !idle));

  // Re-evaluate when "Remind me later" runs out, and while a busy app waits for the user to go idle.
  const remindUntil = heldByUser && state.remindLater?.version === state.version ? state.remindLater.until : null;
  useEffect(() => {
    if (remindUntil === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, remindUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [remindUntil]);
  const waitingForIdle = asking && !heldByUser && !activity.playing && activity.busy && !idle;
  useEffect(() => {
    if (!waitingForIdle) return;
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [waitingForIdle]);

  if (blocked || !controls.supported || view === null || heldByUser || heldByActivity) return null;
  if (closed !== null && closed.version === state.version && closed.phase === state.phase) return null;

  const text = (key: UpdateSectionStringKey) => updateSectionText(language, key, { app: appName, version: state.version ?? "" });
  const close = (): void => setClosed({ version: state.version, phase: state.phase });
  // Later/Ignore need a version (the main process refuses them otherwise) and never apply to a mandatory update.
  const canHold = asking && state.version !== null && !state.mandatory;
  const later = (): void => {
    if (canHold) void remindLater();
    else close();
  };
  // While the password window and the package manager run, and while the app restarts, nothing closes the modal.
  const working = view === "installing" || view === "installed";

  const flatpak = state.channel === "flatpak";
  const message =
    view === "ready"
      ? text(state.version ? "readyBody" : "readyBodyCurrent")
      : view === "ask"
        ? text("systemPrompt")
        : view === "manual"
          ? `${text("systemAvailable")} ${text("systemNoPasswordDialog")}`
          : view === "flatpak"
            ? text("flatpakHint")
            : view === "installing"
              ? text(flatpak ? "installingFlatpak" : "installing")
              : view === "installed"
                ? text("installed")
                : text(systemFailureKey(state.failure));
  const Icon =
    view === "installing" ? Loader2 : view === "failed" ? AlertTriangle : view === "installed" ? RotateCw : view === "pending" ? Clock : Download;
  const showCommand = (view === "manual" || view === "flatpak" || view === "failed") && state.manualCommand;
  const title: UpdateSectionStringKey = view === "failed" ? "systemFailedTitle" : view === "ready" ? "readyTitle" : "systemPromptTitle";
  // Restarting (self) or installing (system, which relaunches the app) would cut the work the app marked busy.
  const showBusyNote = (view === "ready" || view === "ask") && activity.busy;
  const hasInstall = view === "ask" || view === "ready";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !working) (asking ? later : close)();
      }}
    >
      <DialogContent
        data-testid="update-prompt"
        data-view={view}
        role={view === "failed" ? "alertdialog" : "dialog"}
        // Wide enough for three buttons in French ("Me le rappeler plus tard"); the footer wraps rather than overflow.
        className="max-w-lg"
        hideCloseButton={working}
        onEscapeKeyDown={(event) => {
          if (working) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (working) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          if (!focusRef.current) return;
          event.preventDefault();
          focusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon
              className={`size-5 shrink-0 ${view === "failed" ? "text-destructive" : "text-primary"} ${working ? "animate-spin" : ""}`}
              aria-hidden
            />
            {text(title)}
          </DialogTitle>
          <DialogDescription className="text-foreground" data-testid="update-prompt-message">
            {message}
          </DialogDescription>
        </DialogHeader>
        {showBusyNote ? (
          <p data-testid="update-prompt-busy" className="text-sm text-muted-foreground">
            {text("busyNote")}
          </p>
        ) : null}
        {view === "failed" && state.failureDetail ? (
          <pre data-testid="update-prompt-detail" className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {state.failureDetail}
          </pre>
        ) : null}
        {view === "installing" && flatpak ? (
          // The Flatpak portal reports its progress; the package manager does not.
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.progress}
            data-testid="update-prompt-progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${state.progress}%` }} />
          </div>
        ) : working ? (
          <div role="progressbar" aria-busy="true" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        ) : null}
        {showCommand ? <ManualUpdateCommand command={state.manualCommand ?? ""} text={text} hint={view !== "flatpak"} /> : null}
        {working ? null : (
          <DialogFooter className="gap-2 sm:flex-wrap sm:gap-2">
            {canHold ? (
              <>
                <Button type="button" variant="ghost" size="sm" data-testid="update-prompt-ignore" onClick={() => void ignoreVersion()}>
                  {text("ignore")}
                </Button>
                <Button
                  ref={hasInstall ? undefined : focusRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="update-prompt-later"
                  onClick={later}
                >
                  {text("remindLater")}
                </Button>
              </>
            ) : (
              <Button ref={hasInstall ? undefined : focusRef} type="button" variant="outline" size="sm" data-testid="update-prompt-close" onClick={close}>
                {text("close")}
              </Button>
            )}
            {view === "ask" ? (
              <Button ref={focusRef} type="button" size="sm" data-testid="update-prompt-install" onClick={() => void download()}>
                {text("installNow")}
              </Button>
            ) : view === "ready" ? (
              <Button ref={focusRef} type="button" size="sm" data-testid="update-prompt-install" onClick={install}>
                {text("restartNow")}
              </Button>
            ) : null}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
