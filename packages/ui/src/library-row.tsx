/**
 * The one library row Parrot and Badger share (PAR-LIB-06, UX-LIB-01; Chris 2026-11-20, then "same row design for both
 * apps" the same day): on the left the tab switch, a thin divider and the quiet counts; on the right a Filter button
 * opening the filter panel (its count badge and a Clear link while filters are on), a Sort button opening the sort
 * panel, and the view button where the app has more than one view. The row stays pinned under the app's top bar while
 * the library scrolls. Everything is drawn in theme tokens, so each app keeps its own accent (Parrot green, Badger
 * orange).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Filter, SortAsc } from "lucide-react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { cn } from "./utils";

/** The element whose scrolling moves the row: the nearest ancestor that scrolls on its own, else the page (null). */
const scrollerOf = (node: HTMLElement): HTMLElement | null => {
  for (let parent = node.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
};

/**
 * Pins its row under the app's top bar while the page scrolls. It is transparent at rest and gets the page's background
 * and a bottom line once it is pinned, so the grid scrolling under it stays readable; the row keeps its place in the
 * page, so nothing jumps.
 *
 * `pinTop` is the sticky `top`, counted from the inside of the scroller's padding (as the browser counts it): 64 under
 * a 64px bar over a scrolling window, or minus the scroller's top padding to sit flush with the top of a padded
 * scroller. Whether it has pinned is measured, not guessed from offsets or gaps: the row is pinned while it sits on
 * that stuck line, whichever element scrolls (the window or an app's own scrolling main).
 */
export function PinnedRow({ pinTop = 0, className, children, testId, logTag }: { pinTop?: number; className?: string; children: ReactNode; testId?: string; logTag: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const rowNode = row.current;
    if (!rowNode) return;
    const scroller = scrollerOf(rowNode);
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Where the browser holds a stuck row: the top of the scroller's content box (the viewport's top for the page),
      // plus the sticky top. A row resting lower in the page sits below it; one whose container has scrolled out
      // with it sits above it. Only a row held on the line is pinned.
      let line = pinTop;
      if (scroller) {
        const style = getComputedStyle(scroller);
        line += scroller.getBoundingClientRect().top + (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.paddingTop) || 0);
      }
      const top = rowNode.getBoundingClientRect().top;
      const next = Math.abs(top - line) < 0.5;
      setPinned((was) => {
        if (was !== next) console.info(`[${logTag}] toolbar`, next ? "pinned" : "unpinned", { top: Math.round(top), line: Math.round(line) });
        return next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture catches the scroll of any scroller (the window or an app's own scrolling main), which does not bubble.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [logTag, pinTop]);
  return (
    <div
      ref={row}
      style={{ top: pinTop }}
      data-pinned={pinned ? "true" : "false"}
      data-testid={testId}
      className={cn(
        "sticky z-20 border-b transition-[background-color,border-color] duration-200",
        pinned ? "border-border/70 bg-background/85 backdrop-blur-md" : "border-transparent bg-transparent",
        className
      )}
    >
      {children}
    </div>
  );
}

/** One number of the quiet counts and its words ("14 albums", "12 of 21 movies"): the number is drawn in the text colour. */
export type LibraryCount = { n: number; text: string };

/** "14 albums · 153 songs · 2 artists", quiet, each number in the text colour. */
export function LibraryCounts({ counts, className }: { counts: LibraryCount[]; className?: string }) {
  return (
    <span className={cn("min-w-0 truncate whitespace-nowrap text-[13px] text-muted-foreground", className)} data-testid="library-counts">
      {counts.map((count, i) => {
        const n = String(count.n);
        const at = count.text.indexOf(n);
        return (
          <span key={i}>
            {/* Spaces around the dot keep the counts readable as text ("14 albums · 153 songs"); with them the
                dot sits 6px from each word, as in the draft. */}
            {i > 0 && (
              <>
                {" "}
                <span className="mx-[2.5px] opacity-50">·</span>{" "}
              </>
            )}
            {at < 0 ? (
              count.text
            ) : (
              <>
                {count.text.slice(0, at)}
                <em className="font-semibold not-italic text-foreground">{n}</em>
                {count.text.slice(at + n.length)}
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}

export type LibrarySegmentOption<T extends string> = { id: T; label: string; icon?: ReactNode; testId?: string };

/** The tab switch at the start of the row: Albums / Artists / Songs, Movies / TV shows. */
export function LibrarySegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testId = "library-toggle",
}: {
  options: ReadonlyArray<LibrarySegmentOption<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  testId?: string;
}) {
  // The tabs pattern: only the selected tab is in the Tab order; arrows, Home and End move the selection and focus.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    const at = options.findIndex((option) => option.id === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : step === undefined ? -1 : (at + step + options.length) % options.length;
    const target = options[next];
    if (!target) return;
    event.preventDefault();
    console.info("[library-row] tab by key", event.key, target.id);
    onChange(target.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      className="flex shrink-0 gap-1 rounded-[11px] border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card)/0.8)] p-[3px]"
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onChange(option.id)}
            data-testid={option.testId}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The row itself: switch, divider and counts on the left, the app's buttons pushed right. On a narrow window the right
 * group wraps under the left one rather than squeezing the counts away.
 */
export function LibraryRow({
  switcher,
  counts,
  trailing,
  pinTop,
  className,
  logTag,
  testId = "library-row",
}: {
  switcher: ReactNode;
  counts: LibraryCount[];
  trailing?: ReactNode;
  pinTop?: number;
  className?: string;
  /** The console tag of the pinned / unpinned log ("parrot-library", "badger-library"). */
  logTag: string;
  testId?: string;
}) {
  return (
    <PinnedRow pinTop={pinTop} className={className} testId="library-toolbar" logTag={logTag}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 py-3" data-testid={testId}>
        {switcher}
        {counts.length > 0 ? (
          <>
            <span className="h-[22px] w-px shrink-0 bg-border" aria-hidden data-testid="library-row-divider" />
            <LibraryCounts counts={counts} />
          </>
        ) : null}
        {trailing ? (
          <div className="ml-auto flex shrink-0 items-center gap-2" data-testid="library-row-actions">
            {trailing}
          </div>
        ) : null}
      </div>
    </PinnedRow>
  );
}

/** The row's 38px button (Filter, Sort); filled in the accent while filters are on, with their count after a dot. */
export function LibraryRowButton({
  label,
  icon,
  count = 0,
  active = false,
  disabled = false,
  onClick,
  testId,
}: {
  label: string;
  icon?: ReactNode;
  count?: number;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[38px] items-center gap-2 whitespace-nowrap rounded-[10px] border px-3.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4",
        active ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-secondary/50 text-foreground hover:border-primary/60 hover:bg-secondary"
      )}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {icon}
      {label}
      {count ? ` · ${count}` : ""}
    </button>
  );
}

/** The Filter button ("Filter · 2" while two filters are on) and, while any is on, the Clear link that drops them all. */
export function LibraryFilterButton({
  label,
  clearLabel,
  count,
  onOpen,
  onClear,
  disabled = false,
}: {
  label: string;
  clearLabel: string;
  count: number;
  onOpen: () => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <LibraryRowButton icon={<Filter />} label={label} count={count} active={count > 0} disabled={disabled} onClick={onOpen} testId="library-filter-button" />
      {count > 0 ? (
        <button
          type="button"
          className="shrink-0 text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onClear}
          data-testid="library-filter-clear"
        >
          {clearLabel}
        </button>
      ) : null}
    </>
  );
}

/** The Sort button; the sort panel it opens shows the current pick. */
export function LibrarySortButton({ label, onOpen, disabled = false }: { label: string; onOpen: () => void; disabled?: boolean }) {
  return <LibraryRowButton icon={<SortAsc />} label={label} disabled={disabled} onClick={onOpen} testId="library-sort-button" />;
}

/**
 * The Filter / Sort panel. The body is the app's (filter lists, sort options); `footer` holds its buttons (Filter:
 * Reset + Apply; Sort: Done).
 */
export function LibraryModal({
  open,
  onOpenChange,
  title,
  closeLabel,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  footer: ReactNode;
  testId?: string;
}) {
  // The body mounts with the portal, a render after `open`, so it is tracked through a callback ref.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    if (!body) return;
    const update = () => setMoreBelow(body.scrollTop + body.clientHeight < body.scrollHeight - 1);
    update();
    body.addEventListener("scroll", update, { passive: true });
    // The body's own size (window resize) and its content's (a list growing on "+N more") both change what is below.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(body);
    if (body.firstElementChild) observer?.observe(body.firstElementChild);
    return () => {
      body.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [body]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Focus lands on the panel itself, without scrolling, so it opens at its top with the first heading in view (a
        first control taking focus would scroll the body to it).
      */}
      <DialogContent
        className="max-w-md outline-none"
        closeLabel={closeLabel}
        data-testid={testId}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/*
          The Filter panel holds up to seven lists (UX-LIB-03): the body is the one thing that scrolls; its lists never
          do. While more of it sits below, a fade over its bottom and a line over the buttons say so.
        */}
        <div className="relative">
          <div ref={setBody} className="-mr-2 max-h-[65vh] overflow-y-auto pr-2" data-testid={testId ? `${testId}-body` : undefined}>
            <div className="space-y-5">{children}</div>
          </div>
          {moreBelow ? (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" data-testid={testId ? `${testId}-fade` : undefined} />
          ) : null}
        </div>
        <DialogFooter className={cn(moreBelow && "border-t border-border pt-4")}>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled group inside a panel (Genres, Decade, Sort by). */
export function LibraryModalSection({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      {children}
    </section>
  );
}

/** The panel footer's secondary and primary buttons. */
export function LibraryModalButtons({
  secondary,
  primary,
}: {
  secondary?: { label: string; onClick: () => void; testId?: string };
  primary: { label: string; onClick: () => void; testId?: string };
}) {
  return (
    <>
      {secondary ? (
        <Button type="button" variant="ghost" onClick={secondary.onClick} data-testid={secondary.testId}>
          {secondary.label}
        </Button>
      ) : null}
      <Button type="button" onClick={primary.onClick} data-testid={primary.testId}>
        {primary.label}
      </Button>
    </>
  );
}

/** A pill of a panel; `on` marks a pick or toggle (aria-pressed), and is left out for an action pill (Badger's direction). */
export type LibraryPill = { id: string; label: string; on?: boolean; onClick: () => void; testId?: string; icon?: ReactNode };

/** A wrap of pressable pills inside a panel: the sort fields, a single pick (Genre, Decade) or on / off filters. */
export function LibraryPills({ pills }: { pills: ReadonlyArray<LibraryPill> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {pills.map((pill) => (
        <button
          key={pill.id}
          type="button"
          aria-pressed={pill.on}
          data-testid={pill.testId}
          className={cn(
            "inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-4 [&_svg]:w-4",
            pill.on ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-secondary/50 text-foreground hover:border-primary/60 hover:bg-secondary"
          )}
          onClick={pill.onClick}
        >
          {pill.icon}
          {pill.label}
        </button>
      ))}
    </div>
  );
}

export type LibraryViewOption<T extends string> = { id: T; label: string; icon: ReactNode };

/**
 * One 38px button for the library view, where an app has more than one (Badger). Its icon shows the current view; a
 * click moves to the next one (posters → compact → details → posters), which its tooltip names.
 */
export function LibraryViewCycleButton<T extends string>({
  options,
  value,
  onChange,
  nextLabel,
  testId = "library-view-cycle",
}: {
  options: ReadonlyArray<LibraryViewOption<T>>;
  value: T;
  onChange: (id: T) => void;
  /** The tooltip for the next view, e.g. "Switch to Compact grid". */
  nextLabel: (next: LibraryViewOption<T>) => string;
  testId?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  const current = options[index]!;
  const next = options[(index + 1) % options.length]!;
  const label = nextLabel(next);
  return (
    <button
      type="button"
      data-testid={testId}
      data-view={current.id}
      aria-label={label}
      title={label}
      className="flex h-[38px] w-10 shrink-0 items-center justify-center rounded-[10px] border border-border bg-secondary/50 text-foreground transition hover:border-primary/60 hover:bg-secondary [&_svg]:h-4 [&_svg]:w-4"
      onClick={() => onChange(next.id)}
    >
      {current.icon}
    </button>
  );
}
