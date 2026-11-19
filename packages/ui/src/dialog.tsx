import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { useCloseLabel } from "./close-label";
import { RenderBoundary } from "./render-boundary";
import { cn } from "./utils";

/** Whether the enclosing dialog or sheet is open, and how to close it; read by its content's crash guard. */
export const PopupCloseContext = React.createContext<{ open: boolean; close: () => void } | null>(null);

/**
 * Radix's dialog root, keeping track of whether it is open so a crash inside its content can close it (UX-CRASH-01).
 * Works for controlled (`open` + `onOpenChange`) and uncontrolled (`defaultOpen`, a trigger) dialogs alike; the
 * sheet uses it too.
 */
const Dialog = ({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange]
  );
  const popup = React.useMemo(() => ({ open: isOpen, close: () => setOpen(false) }), [isOpen, setOpen]);
  return (
    <PopupCloseContext.Provider value={popup}>
      <DialogPrimitive.Root {...props} open={isOpen} onOpenChange={setOpen} />
    </PopupCloseContext.Provider>
  );
};
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Screen-reader label of the corner close button; defaults to the `CloseLabelProvider` label. */
    closeLabel?: string;
    /** Extra backdrop classes, e.g. a z-index above a page's own fixed header (pair it with the same z on `className`). */
    overlayClassName?: string;
    /** Leaves out the corner close button, for a dialog that draws its own next to its content (UX-WAIT-02). */
    hideCloseButton?: boolean;
  }
>(({ className, children, closeLabel, overlayClassName, hideCloseButton, ...props }, ref) => {
  const label = useCloseLabel(closeLabel);
  const popup = React.useContext(PopupCloseContext);
  return (
    // UX-CRASH-01: a crash inside the dialog (or the portal's own update loop) closes it; the window guard says why.
    <RenderBoundary name="dialog" variant="overlay" resetKey={popup?.open} onDismiss={popup?.close}>
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-3xl grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
          {hideCloseButton ? null : (
            <DialogClose className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">{label}</span>
            </DialogClose>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </RenderBoundary>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
