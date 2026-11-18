import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

/**
 * One status pill for the whole app. The health pills for the metadata service / Invidious (and
 * the runtime status dot) were previously copy-pasted, byte-for-byte color
 * ladders that would inevitably drift. This centralizes the ok / fail / pending
 * / idle / info palette in a single place so every "connection / health /
 * test-result" indicator looks identical.
 */
const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold leading-none",
  {
    variants: {
      status: {
        ok: "bg-emerald-500/15 text-emerald-500",
        fail: "bg-red-500/15 text-red-500",
        pending: "bg-amber-500/15 text-amber-500",
        idle: "bg-muted text-muted-foreground",
        info: "bg-primary/15 text-primary",
      },
    },
    defaultVariants: { status: "idle" },
  }
);

const dotColor: Record<NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>, string> = {
  ok: "bg-emerald-500",
  fail: "bg-red-500",
  pending: "bg-amber-500",
  idle: "bg-muted-foreground",
  info: "bg-primary",
};

export type StatusBadgeStatus = NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>;

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  /** Render a leading colored dot (used for ambient/connection status). */
  dot?: boolean;
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ className, status, dot = false, children, ...props }, ref) => (
    <span ref={ref} className={cn(statusBadgeVariants({ status }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor[status ?? "idle"])}
        />
      ) : null}
      {children}
    </span>
  )
);
StatusBadge.displayName = "StatusBadge";

export { StatusBadge, statusBadgeVariants };
