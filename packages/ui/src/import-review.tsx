import * as React from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { cn } from "./utils";
import { ChevronDown, Search } from "lucide-react";

/**
 * The family's "here's what I found" import dialog (REL-FAM-02, PAR-UP-05): a list of what was found on the left,
 * the selected entry's details on the right, and a footer with a summary and the Cancel / confirm buttons. Badger's
 * file import and Parrot's music import both build on these pieces; each app supplies its own rows and details:
 *
 *   <ImportReviewDialog …>
 *     <ImportReviewBody><ImportReviewList>rows</ImportReviewList><ImportReviewDetail>…</ImportReviewDetail></ImportReviewBody>
 *     <ImportReviewFooter><ImportReviewSummary>…</ImportReviewSummary><ImportReviewActions>buttons</ImportReviewActions></ImportReviewFooter>
 *   </ImportReviewDialog>
 */
export type ImportReviewDialogProps = Omit<React.ComponentPropsWithoutRef<typeof DialogContent>, "title" | "className"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
};

export function ImportReviewDialog({ open, onOpenChange, title, children, ...contentProps }: ImportReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        {...contentProps}
        className="max-w-5xl h-[80vh] flex flex-col p-0 gap-0 overflow-hidden bg-background text-foreground"
      >
        <DialogHeader className="p-6 border-b border-border">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The list and the details side by side, filling the dialog between its title and its footer. */
export function ImportReviewBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-1 min-h-0 relative", className)} {...props} />;
}

/** The footer row: an ImportReviewSummary at the left, ImportReviewActions at the right, notices between. */
export function ImportReviewFooter({ children }: { children: React.ReactNode }) {
  return (
    <DialogFooter className="p-6 border-t border-border bg-card">
      <div className="flex justify-between w-full items-center">{children}</div>
    </DialogFooter>
  );
}

/** What will be imported ("7 ready to import"). */
export function ImportReviewSummary({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

/** Cancel and the confirm button, plus anything the app adds. */
export function ImportReviewActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex gap-2", className)} {...props} />;
}

/** Why the confirm button is off, in a few words, right before it ("Decide on 2 unidentified songs"). */
export function ImportReviewBlocked({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="status" className={cn("self-center text-xs text-amber-300", className)} {...props} />;
}

/** A small mark on a list row: `attention` asks for a look ("Check"), `muted` only informs ("8 of 10 tracks"). */
export function ImportReviewBadge({ tone = "muted", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "muted" | "attention" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        tone === "attention" ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-border bg-muted/40 text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

/** The scrolling list of found entries, a third of the dialog's width. */
export function ImportReviewList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("w-1/3 border-r border-border overflow-y-auto bg-muted/10", className)} {...props} />;
}

/** A small caps heading over a group of rows ("Ready to import", "Needs a decision"). */
export function ImportReviewSection({ tone = "muted", className, ...props }: React.HTMLAttributes<HTMLDivElement> & { tone?: "muted" | "attention" }) {
  return (
    <div
      className={cn(
        "px-4 py-2 text-[11px] uppercase tracking-[0.2em]",
        tone === "attention" ? "text-amber-300" : "text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export type ImportReviewRowProps = Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "onSelect"> & {
  selected: boolean;
  onSelect: () => void;
  /** Before the title (a type icon). */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** The full title on hover, when `title` may be cut. */
  titleText?: string;
  /** Lines under the title. */
  children?: React.ReactNode;
  /** At the right: status icons, the remove or untick control. */
  trailing?: React.ReactNode;
};

/** One found entry in the list; the selected one gets the accent bar and its details show on the right. */
export function ImportReviewRow({ selected, onSelect, icon, title, titleText, children, trailing, className, ...props }: ImportReviewRowProps) {
  return (
    <div
      className={cn(
        "p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20",
        selected && "bg-muted/30 border-l-4 border-l-primary",
        className
      )}
      onClick={onSelect}
      data-selected={selected || undefined}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {icon}
            <div className="font-medium text-sm truncate" title={titleText}>
              {title}
            </div>
          </div>
          {children}
        </div>
        {trailing ? (
          <div className="shrink-0 flex items-center gap-2">
            {trailing}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The box of what a matched entry holds, under its match header: Badger's show episodes, Parrot's album tracks. A
 * heading, optional chips (Badger's seasons), then ImportReviewItem rows.
 */
export function ImportReviewItems({ heading, chips, children, className, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & { heading: React.ReactNode; chips?: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-border bg-muted/20 p-4 space-y-3", className)} {...props}>
      <div className="text-sm font-semibold">{heading}</div>
      {chips ? <div className="flex flex-wrap gap-2">{chips}</div> : null}
      <div className="grid grid-cols-1 gap-2">{children}</div>
    </div>
  );
}

export type ImportReviewItemProps = Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "onSelect"> & {
  selected?: boolean;
  /** Without it the item only shows (a track with no song to import). */
  onSelect?: () => void;
  /** Before the label: an untick box. */
  leading?: React.ReactNode;
  /** "S1E01", "7 · Faint". */
  label: React.ReactNode;
  /** The small line under the label: the file it pairs with. */
  sub?: React.ReactNode;
  /** At the right: a remove control. */
  trailing?: React.ReactNode;
  /** Greyed out: unticked, or nothing to import. */
  dimmed?: boolean;
};

/** One item in an ImportReviewItems box (an episode, a track); the selected one shows its details under the box. */
export function ImportReviewItem({ selected, onSelect, leading, label, sub, trailing, dimmed, className, ...props }: ImportReviewItemProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition",
        selected ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 bg-muted/30 text-muted-foreground",
        dimmed && "opacity-50",
        className
      )}
      data-selected={selected || undefined}
      {...props}
    >
      {leading}
      {onSelect ? (
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <div className="truncate font-medium text-foreground">{label}</div>
          {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{label}</div>
          {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
        </div>
      )}
      {trailing}
    </div>
  );
}

/** The selected entry's details, filling the rest of the dialog. */
export function ImportReviewDetail({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 overflow-y-auto p-8 bg-card", className)} {...props} />;
}

export type ImportReviewMatchHeaderProps = Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & {
  /** The matched work's picture (a poster, an album cover), filling its frame. */
  artwork: React.ReactNode;
  /** A poster stands 2:3 (movies, shows); a cover is square (albums). */
  artworkShape?: "poster" | "square";
  /** The small accent line over the title: a type icon and its name ("TV show", "Album"). */
  kind: React.ReactNode;
  title: React.ReactNode;
  /** The muted line under the title (a year; an artist and a year). */
  meta?: React.ReactNode;
  /** Below: an overview, a track count, what is being added. */
  children?: React.ReactNode;
};

/** What an entry was matched to, at the top of its details (Badger's show or movie, Parrot's album). */
export function ImportReviewMatchHeader({ artwork, artworkShape = "poster", kind, title, meta, children, className, ...props }: ImportReviewMatchHeaderProps) {
  return (
    <div className={cn("flex gap-6", className)} {...props}>
      <div className="w-40 shrink-0">
        <div className={cn("rounded-lg overflow-hidden shadow-lg bg-muted", artworkShape === "poster" ? "aspect-[2/3]" : "aspect-square")}>{artwork}</div>
      </div>
      <div className="space-y-4 flex-1 min-w-0">
        <div>
          <div className="flex items-center gap-2 text-primary font-semibold tracking-wide uppercase text-xs mb-1">{kind}</div>
          <h2 className="text-2xl font-bold">{title}</h2>
          {meta !== undefined ? <div className="text-muted-foreground text-sm mt-1">{meta}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The neutral notice shown instead of a match header while the entry's lookup is still running, so an entry is never
 * called unmatched before its lookup has ended (INGS-IDENT-02). `role="status"` announces it to screen readers.
 */
export function ImportReviewSearching({ title, hint, icon, className, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & { title: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className={cn("rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm", className)} {...props}>
      <div className="flex items-center gap-2 text-foreground">
        {icon}
        <span className="font-semibold">{title}</span>
      </div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The amber notice shown instead of a match header when nothing was matched. */
export function ImportReviewNoMatch({ title, hint, icon, className, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & { title: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm", className)} {...props}>
      <div className="flex items-center gap-2 text-amber-300">
        {icon}
        <span className="font-semibold">{title}</span>
      </div>
      {hint ? <p className="mt-1 text-xs text-amber-200/90">{hint}</p> : null}
    </div>
  );
}

export type ImportReviewMatchSearchProps = Omit<React.HTMLAttributes<HTMLDetailsElement>, "title" | "onToggle"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fold's label ("Wrong match? Search manually", "Wrong album? Search"). */
  label: React.ReactNode;
  /** The search controls (inputs, the Search button), on one row. */
  controls: React.ReactNode;
  /** The results under the controls (a grid of ImportReviewMatchResult, a "More results" button). */
  children?: React.ReactNode;
};

/** The fold under an entry's details where the user searches for another match by hand. */
export function ImportReviewMatchSearch({ open, onOpenChange, label, controls, children, className, ...props }: ImportReviewMatchSearchProps) {
  return (
    <details className={cn("pt-6 border-t border-border", className)} open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)} {...props}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-0" : "-rotate-90"}`} />
        <Search className="h-4 w-4 text-muted-foreground" />
        <span>{label}</span>
      </summary>
      <div className="mt-4 flex flex-col min-h-0">
        <div className="flex gap-2">{controls}</div>
        {children}
      </div>
    </details>
  );
}

export type ImportReviewMatchResultProps = Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "onSelect"> & {
  /** The result's picture, filling its frame. */
  artwork: React.ReactNode;
  /** A poster stands 2:3 (movies, shows); a cover is square (albums). */
  artworkShape?: "poster" | "square";
  title: React.ReactNode;
  /** The small line under the title (a year; an artist and a year). */
  meta?: React.ReactNode;
  selectLabel: React.ReactNode;
  onSelect: () => void;
  /** More buttons shown with Select over the picture on hover (Badger's trailer). */
  actions?: React.ReactNode;
};

/** One search result: its picture, with Select over it on hover, then its title and a small line. */
export function ImportReviewMatchResult({ artwork, artworkShape = "poster", title, meta, selectLabel, onSelect, actions, className, ...props }: ImportReviewMatchResultProps) {
  return (
    <div className={cn("text-left group relative", className)} {...props}>
      <div className={cn("rounded-md overflow-hidden bg-muted mb-2 relative", artworkShape === "poster" ? "aspect-[2/3]" : "aspect-square")}>
        {artwork}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2 opacity-0 group-hover:opacity-100 bg-black/50 transition-opacity">
          <Button size="sm" className="w-full max-w-[11rem]" onClick={onSelect}>
            {selectLabel}
          </Button>
          {actions}
        </div>
      </div>
      <div className="text-xs font-semibold truncate">{title}</div>
      {meta !== undefined ? <div className="text-[10px] text-muted-foreground">{meta}</div> : null}
    </div>
  );
}

export type ImportReviewPickerProps = {
  /** Big round icon over the title (an upload arrow). */
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle: React.ReactNode;
  /** A scan error shown over the buttons. */
  error?: React.ReactNode;
  browseFilesLabel: React.ReactNode;
  browseFoldersLabel: React.ReactNode;
  onBrowse: (kind: "file" | "folder") => void;
  disabled?: boolean;
  /** Shown instead of the buttons while the picked files are being read (a spinner and a line). */
  busy?: React.ReactNode;
};

/**
 * What the top bar's "+" opens first (UX-ADD-01): one dialog offering to pick files or a folder, before the list of
 * what was found. Badger's media import and Parrot's music import show this same step.
 */
export function ImportReviewPicker({ icon, title, subtitle, error, browseFilesLabel, browseFoldersLabel, onBrowse, disabled, busy }: ImportReviewPickerProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-12 text-center" data-testid="import-picker">
      <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center mb-6">{icon}</div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-muted-foreground max-w-sm mb-8">{subtitle}</p>
      {error ? (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}
      {busy ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="import-picker-busy">
          {busy}
        </div>
      ) : (
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => onBrowse("file")} disabled={disabled} data-testid="import-pick-files">
            {browseFilesLabel}
          </Button>
          <Button variant="outline" onClick={() => onBrowse("folder")} disabled={disabled} data-testid="import-pick-folders">
            {browseFoldersLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
