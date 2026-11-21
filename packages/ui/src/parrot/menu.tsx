/**
 * The "…" button and the small list of actions it opens, shared by Parrot's browser-engine apps (desktop renderer and
 * web player): the album page's "…" in the approved design (PAR-LOOK-01) and the "…" on album and artist tiles. The
 * list closes on a pick, on Escape and on a click outside it; arrow keys move between items.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import { RenderBoundary } from "../render-boundary";
import { cn } from "../utils";

export type ParrotMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Drawn in red (delete). */
  destructive?: boolean;
  /** A thin line above this item, to set a group apart. */
  separatorBefore?: boolean;
  disabled?: boolean;
  testId?: string;
};

type ParrotMenuProps = {
  /** The button's name for screen readers and on hover ("More"). */
  label: string;
  items: ParrotMenuItem[];
  testId?: string;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  /** Which edge of the button the list lines up with. */
  align?: "start" | "end";
  /** What the button shows instead of the "…" icon (the library's sort button: its icon and the picked order). */
  trigger?: ReactNode;
};

export function ParrotMenu({ label, items, testId = "parrot-menu", onOpenChange, triggerClassName, align = "start", trigger }: ParrotMenuProps) {
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list is drawn on top of the page (a portal, fixed in the window), so a tile row that hides its overflow or a
  // card that moves on hover never cuts it: it opens under the button, or over it when the window has no room below.
  const [place, setPlace] = useState<CSSProperties>({});
  const menuId = useId();
  const setOpen = (next: boolean) => {
    if (next) {
      const rect = root.current!.getBoundingClientRect();
      setPlace(align === "end" ? { top: rect.bottom + 8, right: window.innerWidth - rect.right } : { top: rect.bottom + 8, left: rect.left });
    }
    setOpenState(next);
    onOpenChange?.(next);
  };

  useLayoutEffect(() => {
    if (!open || !list.current || !root.current) return;
    const height = list.current.offsetHeight;
    const rect = root.current.getBoundingClientRect();
    if (rect.bottom + 8 + height > window.innerHeight && rect.top - 8 - height >= 0) setPlace((current) => ({ ...current, top: rect.top - 8 - height }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    // The list stays where the button was: a scroll or a resize closes it rather than leaving it floating.
    const onMove = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
    // setOpen only wraps state and the caller's callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={root} className="relative inline-flex" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        className={cn(
          "inline-flex h-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          trigger ? "gap-2 whitespace-nowrap rounded-xl px-3 text-sm font-semibold text-foreground" : "w-11",
          triggerClassName,
        )}
        data-testid={testId}
      >
        {trigger ?? <Ellipsis className="h-5 w-5" aria-hidden />}
      </button>
      {open && (
        // UX-CRASH-01: a crash inside the list closes the menu; the window guard says why.
        <RenderBoundary name="menu" onDismiss={() => setOpen(false)}>
        {createPortal(
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          style={place}
          className="fixed z-50 min-w-52 rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-2xl shadow-black/50"
          data-testid={`${testId}-list`}
        >
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore && <div role="separator" className="my-1 h-px bg-border/60" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:bg-white/10 focus-visible:outline-none disabled:opacity-50",
                  item.destructive && "text-destructive",
                )}
                data-testid={item.testId ?? `${testId}-${item.id}`}
              >
                {item.icon && <span className="flex h-4 w-4 items-center justify-center" aria-hidden>{item.icon}</span>}
                {item.label}
              </button>
            </div>
          ))}
        </div>,
          document.body
        )}
        </RenderBoundary>
      )}
    </div>
  );
}
