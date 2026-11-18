import type { ReactNode } from "react";
import { Label } from "@space/ui";
import { cn } from "@space/ui";

/**
 * Settings design kit — the small set of layout primitives every settings
 * section is built from, so the whole surface shares one visual language
 * (one radius, one border, one padding scale, one title/hint typography,
 * one control-right alignment). Replaces the ~17 divergent ad-hoc panel
 * recipes the old single-file Settings page accreted.
 */

/** A bordered, padded standalone panel. The atom for any complex control. */
export function SettingPanel({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "danger";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        tone === "danger" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card/40",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A divided container that stacks SettingRow children into a single grouped
 * card (macOS / Linear-style rows with hairline dividers).
 */
export function SettingGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/40",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * One setting row: title + optional hint on the left, a control on the right
 * (the canonical, app-wide control-right alignment). Optional `children`
 * render full-width below the row for expandable/secondary content.
 */
export function SettingRow({
  title,
  description,
  htmlFor,
  control,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("p-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {htmlFor ? (
            <Label htmlFor={htmlFor} className="font-semibold">
              {title}
            </Label>
          ) : (
            <div className="font-semibold">{title}</div>
          )}
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {control ? <div className="shrink-0 pt-0.5">{control}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/**
 * A labelled full-width field (label above, control below) — used for selects
 * and inputs that don't fit the compact control-right row.
 */
export function SettingField({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingPanel className={className}>
      <div className="space-y-2">
        <Label htmlFor={htmlFor} className="font-semibold">
          {label}
        </Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {children}
      </div>
    </SettingPanel>
  );
}

/** Small caps-ish heading used to label a sub-cluster within a section. */
export function SettingSubheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
  );
}

/** A muted hint paragraph at the standard hint size (text-xs muted). */
export function SettingHint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}
