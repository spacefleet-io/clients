import type { ReactNode } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@space/ui";
import { DesktopTopNavIconAction } from "./desktop-top-nav-actions";

/**
 * The top bar's Jobs item and its side panel (UX-JOBS-01), shared by Badger and Parrot desktop: the flask icon (a
 * spinner with the count of running jobs while any runs) opens a right-hand panel the app fills with its jobs. The
 * first-open tour (UX-TOUR-01 step 3) reads the button (`data-tour="jobs"`, with `jobCount`) and the open panel
 * (`data-tour="jobs-panel"`).
 */
export function DesktopJobsSheet({
  title,
  subtitle,
  activeCount,
  jobCount,
  open,
  onOpenChange,
  triggerClassName = "text-[#8b949e] hover:bg-[#161b22] hover:text-white",
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  /** Jobs still running or waiting; above 0 the flask turns into a spinner with this count. */
  activeCount: number;
  /** Every job the panel lists, finished ones included. */
  jobCount: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  testId?: string;
  children: ReactNode;
}) {
  const running = activeCount > 0;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <DesktopTopNavIconAction title={title} className={triggerClassName} testId={testId} data-tour="jobs" data-tour-jobs-count={jobCount}>
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" data-testid={testId ? `${testId}-running` : undefined} aria-hidden />
          ) : (
            <FlaskConical className="h-4 w-4" aria-hidden />
          )}
          {running ? (
            <span className="absolute -right-1 -top-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-black text-primary-foreground">
              {Math.min(activeCount, 99)}
            </span>
          ) : null}
        </DesktopTopNavIconAction>
      </SheetTrigger>
      <SheetContent side="right" className="w-[520px] bg-[#0d1117] text-white overflow-y-auto" data-tour="jobs-panel">
        <SheetHeader className="sr-only">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

export const DESKTOP_JOB_FILTERS = ["all", "active", "queued", "completed", "failed"] as const;
export type DesktopJobFilter = (typeof DESKTOP_JOB_FILTERS)[number];

/** The panel's row of filter chips (All, Active, Queued, Completed, Failed), with an optional action at its right. */
export function DesktopJobsFilterBar({
  value,
  onChange,
  labels,
  trailing,
}: {
  value: DesktopJobFilter;
  onChange: (filter: DesktopJobFilter) => void;
  labels: Record<DesktopJobFilter, string>;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-wrap gap-1">
        {DESKTOP_JOB_FILTERS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => onChange(level)}
            aria-pressed={value === level}
            data-testid={`jobs-filter-${level}`}
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition ${
              value === level
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/50 text-muted-foreground hover:bg-secondary"
            }`}
          >
            {labels[level]}
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
}

/** What the panel shows when no job matches. */
export function DesktopJobsEmpty({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="text-center py-12 text-muted-foreground" data-testid="jobs-empty">
      <p className="text-sm">{title}</p>
      <p className="text-xs mt-1">{subtitle}</p>
    </div>
  );
}
