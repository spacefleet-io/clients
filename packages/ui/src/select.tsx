import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "./utils";

/**
 * Styled native <select>. The design system historically shipped no Select, so
 * every dropdown in the app was a hand-rolled native <select> carrying a
 * copy-pasted className — which is why a row of unstyled OS dropdowns sat next
 * to polished Radix <Switch> toggles (the "patchwork" smell). This wraps the
 * native element (keeping full keyboard / a11y behavior, zero new deps) with
 * the same height / border / focus-ring tokens as <Input>, plus a custom
 * chevron, so dropdowns read as part of the same form language as everything
 * else.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        "h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm text-foreground transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      aria-hidden
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
    />
  </div>
));
Select.displayName = "Select";

export { Select };
