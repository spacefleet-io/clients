import * as React from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const spinnerVariants = cva("animate-spin", {
  variants: {
    size: {
      sm: "h-3 w-3",
      default: "h-4 w-4",
      lg: "h-5 w-5",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export interface SpinnerProps
  extends Omit<React.SVGProps<SVGSVGElement>, "size">,
    VariantProps<typeof spinnerVariants> {
  "aria-label"?: string;
}

const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size, "aria-label": ariaLabel = "Loading", ...props }, ref) => (
    <Loader2
      ref={ref}
      role="status"
      aria-label={ariaLabel}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  ),
);
Spinner.displayName = "Spinner";

export { Spinner, spinnerVariants };
