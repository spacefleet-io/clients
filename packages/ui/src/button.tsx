import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "./spinner";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ring-offset-background",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  pending?: boolean;
  spinnerLabel?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      pending = false,
      spinnerLabel,
      disabled,
      "aria-busy": ariaBusy,
      children,
      ...props
    },
    ref,
  ) => {
    if (asChild && pending) {
      if (process.env.NODE_ENV !== "production") {
        throw new Error(
          "Button: `asChild` combined with `pending` is not supported. Remove one or the other.",
        );
      }
    }
    const Comp = asChild ? Slot : "button";
    const rootClassName = cn(
      buttonVariants({ variant, size, className }),
      pending ? "relative" : undefined,
    );
    if (pending) {
      return (
        <button
          type="button"
          aria-busy="true"
          disabled
          className={rootClassName}
          ref={ref}
          {...props}
        >
          <span className="invisible">{children}</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner aria-label={spinnerLabel ?? "Loading"} />
          </span>
        </button>
      );
    }
    return (
      <Comp
        className={rootClassName}
        ref={ref}
        disabled={disabled}
        aria-busy={ariaBusy}
        {...props}
      >
        {children}
      </Comp>
    );
  }
);
Button.displayName = "Button";

/**
 * "← Back" to the page this one was opened from: the ghost button, so hovering fills a rounded pill in the app's
 * accent with dark text (Badger yellow, Parrot green, UX-BTN-01). Every app's back button is this one.
 */
const BackButton = ({ label, onClick, testId, className }: { label: React.ReactNode; onClick: () => void; testId?: string; className?: string }) => (
  <Button variant="ghost" onClick={onClick} className={className} data-testid={testId}>
    <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
    {label}
  </Button>
);

export { BackButton, Button, buttonVariants };
