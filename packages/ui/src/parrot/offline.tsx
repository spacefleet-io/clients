// Parrot's "Save offline" pieces (PAR-OFFL-01/02/03), shared by every Parrot app that keeps songs offline on a
// web-technology screen (the desktop app today): the keep button on an album, a playlist or a song, the line saying
// how much space a kept album or playlist takes, and the question asking which copy to keep. They take translated text
// and callbacks only; downloading is the app's job. The web player keeps nothing
// (PAR-OFFL-03 platform-only), so it shows none of them.
import { CircleCheck, Download, LoaderCircle } from "lucide-react";
import { Button } from "../button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { cn } from "../utils";

/** Where a kept item is: not kept, its songs still downloading, or all on this device. */
export type ParrotKeepState = "off" | "downloading" | "kept";

/**
 * The keep toggle: a download arrow while not kept, a turning circle while its songs download, a green tick once they
 * are all here. Pressing it keeps the item, or turns keeping off. `held` = a song kept only because a kept album or
 * playlist holds it: it shows that state but cannot be turned off on its own (the album or playlist is).
 */
export function ParrotKeepButton({
  state,
  labels,
  onToggle,
  held = false,
  size = "md",
  testId = "keep-toggle",
}: {
  state: ParrotKeepState;
  labels: { keep: string; remove: string; held?: string };
  onToggle: () => void;
  held?: boolean;
  size?: "sm" | "md";
  testId?: string;
}) {
  const label = held && labels.held ? labels.held : state === "off" ? labels.keep : labels.remove;
  const icon = size === "sm" ? "size-4" : "size-5";
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(size === "sm" ? "size-8" : "size-10", state === "off" ? "text-muted-foreground" : "text-primary", held && "disabled:opacity-100")}
      aria-label={label}
      aria-pressed={state !== "off"}
      title={label}
      onClick={onToggle}
      disabled={held}
      data-testid={testId}
      data-keep-state={state}
      data-keep-held={held || undefined}
    >
      {state === "off" ? (
        <Download className={icon} aria-hidden />
      ) : state === "downloading" ? (
        <LoaderCircle className={cn(icon, "animate-spin")} aria-hidden />
      ) : (
        <CircleCheck className={icon} aria-hidden />
      )}
    </Button>
  );
}

/**
 * The line under a kept album's or playlist's title: "Kept on this computer · 340 MB", or how far its download is. A
 * span shown as its own line, so it can sit inside the page header's detail paragraph.
 */
export function ParrotKeptLine({ text, testId = "kept-line" }: { text: string; testId?: string }) {
  return (
    <span className="mt-2 flex w-fit items-center gap-1.5 text-xs font-semibold text-primary" data-testid={testId}>
      <Download className="size-3.5" aria-hidden />
      {text}
    </span>
  );
}

/** One copy the question offers: its format ("FLAC", "MP3 320 kbps") and the space it would take, already written. */
export type ParrotKeepChoice = { key: string; label: string; detail: string };

/** Asks once which copy to keep when the songs have more than one besides the light copy (PAR-OFFL-02). */
export function ParrotKeepChoiceDialog({
  open,
  title,
  body,
  choices,
  cancelLabel,
  onPick,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  choices: ParrotKeepChoice[];
  cancelLabel: string;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md" closeLabel={cancelLabel} data-testid="keep-choice-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              onClick={() => onPick(choice.key)}
              className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-4 py-3 text-left transition-colors hover:border-primary hover:bg-secondary"
              data-testid="keep-choice"
              data-choice={choice.key}
            >
              <span className="font-semibold">{choice.label}</span>
              <span className="text-sm text-muted-foreground">{choice.detail}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
