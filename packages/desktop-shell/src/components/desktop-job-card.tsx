import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { Button } from "@space/ui";
import { AnimatedDismissRow } from "./animated-dismiss-row";

/**
 * The cards inside the Jobs panel (UX-JOBS-02), shared by Badger and Parrot desktop so a job looks, reads and is
 * cancelled the same way in both: a group card (artwork, title, count, status pill, one X or bin, chevron), the job
 * rows it opens onto (status pill, progress bar with % and speed, X while running, bin once ended), the finished-job
 * row, and the loading placeholder. Each app maps its own job states to a `DesktopJobTone` and passes the words in,
 * already translated.
 */

export type DesktopJobTone = "neutral" | "blue" | "amber" | "emerald" | "purple" | "cyan" | "destructive";

const TONE_CLASS: Record<DesktopJobTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-blue-500/20 text-blue-400",
  amber: "bg-amber-500/20 text-amber-400",
  emerald: "bg-emerald-500/20 text-emerald-400",
  purple: "bg-purple-500/20 text-purple-400",
  cyan: "bg-cyan-500/20 text-cyan-400",
  destructive: "bg-destructive/20 text-destructive",
};

/** A job's status pill ("Uploading", "Waiting · #3 in line", "Done"…). */
export function DesktopJobStatusPill({ tone, children, testId }: { tone: DesktopJobTone; children: ReactNode; testId?: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]}`} data-testid={testId}>
      {children}
    </span>
  );
}

/** The X (stop a running job) or the bin (remove an ended one from the list). */
export function DesktopJobActionButton({
  kind,
  label,
  onClick,
  disabled,
  testId,
}: {
  kind: "cancel" | "remove";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-destructive disabled:opacity-50"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick();
      }}
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      {kind === "cancel" ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
    </Button>
  );
}

/** A thin bar with the rounded percentage and, when known, the speed. */
export function DesktopJobProgress({ percent, speedLabel, testId }: { percent: number; speedLabel?: string | null; testId?: string }) {
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-[11px] text-muted-foreground">{Math.round(percent)}%</span>
      {speedLabel ? <span className="text-[11px] text-muted-foreground">{speedLabel}</span> : null}
    </div>
  );
}

const onEnterOrSpace = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};

/** One card per title (a film, a show, an album): opens onto its jobs. */
export function DesktopJobGroupCard({
  removing,
  expanded,
  onToggle,
  artwork,
  title,
  kindLabel,
  countLabel,
  badge,
  action,
  testId,
  children,
}: {
  removing: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** The poster or cover, drawn 36×48. */
  artwork: ReactNode;
  title: string;
  /** "TV", "Movie"… next to the title. */
  kindLabel?: string;
  /** "3 jobs". */
  countLabel: string;
  badge: ReactNode;
  action: ReactNode;
  testId?: string;
  /** The open card's body (its rows). */
  children?: ReactNode;
}) {
  const toggle = () => {
    if (removing) return;
    onToggle();
  };
  return (
    <AnimatedDismissRow removing={removing} innerClassName="rounded-xl border border-border bg-card">
      <div
        role="button"
        tabIndex={removing ? -1 : 0}
        className="flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer"
        onClick={toggle}
        onKeyDown={onEnterOrSpace(toggle)}
        data-testid={testId}
        aria-expanded={expanded}
      >
        <div className="h-12 w-9 rounded bg-muted overflow-hidden shrink-0">{artwork}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{title}</span>
            {kindLabel ? <span className="text-[10px] text-muted-foreground">{kindLabel}</span> : null}
          </div>
          <div className="text-[11px] text-muted-foreground">{countLabel}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {badge}
          {action}
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </div>
      </div>
      {expanded ? <div className="border-t border-border/50 px-4 py-3 bg-muted/10">{children}</div> : null}
    </AnimatedDismissRow>
  );
}

/** A collapsible sub-group inside a card (one episode's jobs). */
export function DesktopJobBucketHeader({
  expanded,
  onToggle,
  title,
  countLabel,
  badge,
}: {
  expanded: boolean;
  onToggle: () => void;
  title: string;
  countLabel: string;
  badge?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex w-full items-center gap-2 py-2 text-left cursor-pointer"
      onClick={onToggle}
      onKeyDown={onEnterOrSpace(onToggle)}
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}
      <span className="text-sm font-semibold truncate min-w-0 flex-1">{title}</span>
      <span className="text-[11px] text-muted-foreground shrink-0">{countLabel}</span>
      {badge}
    </div>
  );
}

/** Wraps a row in the removal animation when the list animates removals; plain otherwise. */
function RowFrame({ removing, className, testId, children }: { removing?: boolean; className: string; testId?: string; children: ReactNode }) {
  if (removing === undefined) {
    return (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <AnimatedDismissRow removing={removing} innerClassName={className}>
      {testId ? <div data-testid={testId}>{children}</div> : children}
    </AnimatedDismissRow>
  );
}

/** A job still running or waiting: what it makes, its file, its pill, progress while moving bytes, the X. */
export function DesktopJobRow({
  removing,
  title,
  detail,
  filename,
  badge,
  progress,
  extra,
  action,
  testId,
}: {
  /** Omit when the list does not animate removals. */
  removing?: boolean;
  title: ReactNode;
  /** A short note beside the title ("S01E02"). */
  detail?: ReactNode;
  filename?: string;
  badge: ReactNode;
  progress?: ReactNode;
  /** Lines under the pill (counts, an error). */
  extra?: ReactNode;
  action: ReactNode;
  testId?: string;
}) {
  return (
    <RowFrame removing={removing} className="rounded-lg border border-border/60 bg-background/80 p-3 space-y-2" testId={testId}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          {detail ? <span className="text-[11px] text-muted-foreground">{detail}</span> : null}
        </div>
        {filename !== undefined ? (
          <div className="text-[11px] text-muted-foreground truncate" title={filename}>
            {filename}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {badge}
        {progress}
        <div className="ml-auto flex items-center gap-2">{action}</div>
      </div>
      {extra}
    </RowFrame>
  );
}

/** A finished job: what it made, its file, a line of detail, its pill and the bin. */
export function DesktopCompletedJobRow({
  removing,
  title,
  filename,
  meta,
  badge,
  extra,
  action,
  testId,
}: {
  removing?: boolean;
  title: ReactNode;
  filename?: string;
  meta?: ReactNode;
  badge: ReactNode;
  extra?: ReactNode;
  action: ReactNode;
  testId?: string;
}) {
  return (
    <RowFrame removing={removing} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2" testId={testId}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{title}</p>
          {filename !== undefined ? (
            <p className="text-[10px] text-muted-foreground truncate" title={filename}>
              {filename}
            </p>
          ) : null}
          {meta ? <p className="text-[10px] text-muted-foreground">{meta}</p> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          {action}
        </div>
      </div>
      {extra}
    </RowFrame>
  );
}

/**
 * The three lines under a failed job (UX-JOBS-03): what happened, what it means for the user, and the ONE thing to do
 * about it. Omit `action` when nothing can be done but remove the job (the row's bin already does that).
 */
export function DesktopFailedJobDetail({
  what,
  meaning,
  action,
  testId,
}: {
  what: ReactNode;
  meaning: ReactNode;
  action?: { label: string; onClick: () => void; busy?: boolean; testId?: string };
  testId?: string;
}) {
  return (
    <div className="mt-2 space-y-1" data-testid={testId}>
      <p className="text-[11px] font-medium text-destructive">{what}</p>
      <p className="text-[11px] text-muted-foreground">{meaning}</p>
      {action ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[11px]"
          disabled={action.busy}
          aria-busy={action.busy || undefined}
          onClick={action.onClick}
          data-testid={action.testId}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** One reason some of a job's files were not taken, with how many and which ones. */
export type DesktopJobFailureGroup = {
  /** Stable across renders ("missing", "unsupported"…). */
  key: string;
  /** The whole sentence, count included and already translated ("13 files not found: …"). */
  label: string;
  /** The files' names only, never a path: shown behind the disclosure. */
  files: string[];
};

/**
 * The files a job could not take, grouped by reason (UX-JOBS-03): one plain line per reason ("13 files not found:
 * they were moved or deleted after you chose them."), each opening onto its files' names. Never a raw error, a path
 * or a stack: the app turns its errors into these groups before it passes them in.
 */
export function DesktopJobFailureGroups({ groups, filesLabel, testId }: { groups: DesktopJobFailureGroup[]; filesLabel: string; testId?: string }) {
  if (groups.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-[11px]" data-testid={testId}>
      {groups.map((group) => (
        <li key={group.key} data-reason={group.key}>
          <details>
            <summary className="cursor-pointer text-muted-foreground marker:text-muted-foreground/60">
              <span className="text-foreground">{group.label}</span> <span className="underline-offset-2 hover:underline">{filesLabel}</span>
            </summary>
            <ul className="mt-1 max-h-40 overflow-y-auto pl-4 text-muted-foreground">
              {group.files.map((file, index) => (
                <li key={`${index}:${file}`} className="truncate py-0.5">
                  {file}
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

/**
 * Placeholder cards while the job list loads, shaped like the real ones so nothing shifts when they arrive. `card`
 * is the panel's (three group cards); `row` is a title's Jobs tab (two rows).
 */
export function DesktopJobsLoadingSkeleton({ variant = "card", testId }: { variant?: "card" | "row"; testId: string }) {
  if (variant === "row") {
    return (
      <div className="space-y-2" data-testid={testId}>
        {[0, 1].map((i) => (
          <div key={i} className="border rounded-md p-2 animate-pulse bg-muted/30" aria-hidden="true">
            <div className="flex items-center gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/3 rounded bg-muted/60" />
                <div className="h-2 w-1/2 rounded bg-muted/40" />
              </div>
              <div className="h-5 w-14 rounded bg-muted/40" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid={testId}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="border rounded-lg p-3 animate-pulse bg-muted/30" aria-hidden="true">
          <div className="flex items-center gap-3">
            <div className="h-12 w-8 rounded bg-muted/60" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 rounded bg-muted/60" />
              <div className="h-2 w-1/3 rounded bg-muted/40" />
            </div>
            <div className="h-5 w-16 rounded bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One quiet line at the top of the panel for slow work that runs on its own (crew, lyrics, artist photos). */
export function DesktopJobsBackgroundLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="px-1 pt-2 text-xs text-[#8b949e]" data-testid={testId}>
      {children}
    </p>
  );
}

/** A title's Jobs tab with nothing left in it. */
export function DesktopJobsTabEmpty({ title, subtitle, testId }: { title: string; subtitle: string; testId?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground" data-testid={testId}>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs mt-1">{subtitle}</p>
    </div>
  );
}
