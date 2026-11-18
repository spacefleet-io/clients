import { useId, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Globe2 } from "lucide-react";
import { Button } from "./button";
import { Flag } from "./flag";
import { cn } from "./utils";

export type LanguageMenuVariant = "badge" | "pills";

/**
 * The languages the app ships, passed by every caller: `CLIENT_UI_LANGUAGES` for Badger and Parrot (UX-I18N-01). No
 * default, so a picker can never silently show a shorter list than its app speaks. Each row is the language's SVG flag
 * and its own name (UX-I18N-10).
 */
type LanguageMenuItem = { code: string; nativeName: string };

type LanguageMenuProps = {
  current: string;
  onSelect: (lang: string) => void;
  languages: readonly LanguageMenuItem[];
  variant?: LanguageMenuVariant;
  ariaLabel?: string;
  className?: string;
};

export default function LanguageMenu({
  current,
  onSelect,
  languages: items,
  variant = "badge",
  ariaLabel = "Language",
  className,
}: LanguageMenuProps) {
  if (variant === "pills") {
    return (
      <div
        className={cn(
          "flex items-center gap-1 rounded-full border border-border bg-background/40 px-2 py-1 text-xs font-semibold uppercase",
          className
        )}
      >
        {items.map((lang) => (
          <button
            key={lang.code}
            type="button"
            lang={lang.code}
            onClick={() => onSelect(lang.code)}
            className={cn(
              "flex items-center gap-2 rounded-full px-2 py-1 transition",
              current === lang.code
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-label={lang.nativeName}
            aria-current={current === lang.code ? "page" : undefined}
          >
            <Flag code={lang.code} />
            <span>{lang.nativeName}</span>
          </button>
        ))}
      </div>
    );
  }

  return <LanguageBadgeMenu current={current} onSelect={onSelect} items={items} ariaLabel={ariaLabel} className={className} />;
}

/**
 * The badge menu shows on hover for the mouse; for the keyboard the globe opens and closes it (Enter or Space), and
 * while it is closed its rows are out of the Tab order, so nothing invisible takes the focus. Each row is named by its
 * language (`ariaLabel` names the globe, the question the menu answers).
 */
function LanguageBadgeMenu({
  current,
  onSelect,
  items,
  ariaLabel,
  className,
}: Pick<LanguageMenuProps, "current" | "onSelect" | "className"> & { items: readonly LanguageMenuItem[]; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const closeOnFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className={cn("relative group", className)} onBlur={closeOnFocusOut} onKeyDown={closeOnEscape}>
      <Button type="button" variant="outline" size="icon" aria-label={ariaLabel} aria-haspopup="true" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((was) => !was)}>
        <Globe2 className="h-4 w-4" />
      </Button>
      <div
        id={menuId}
        className={cn(
          "absolute right-0 top-full z-50 mt-0 w-44 rounded-xl border border-border bg-background/95 p-2 text-sm shadow-lg transition",
          open ? "visible opacity-100" : "invisible opacity-0 group-hover:visible group-hover:opacity-100"
        )}
      >
        {items.map((lang) => (
          <button
            key={lang.code}
            type="button"
            lang={lang.code}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              setOpen(false);
              onSelect(lang.code);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
              current === lang.code
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            aria-label={lang.nativeName}
            aria-current={current === lang.code ? "page" : undefined}
          >
            <Flag code={lang.code} />
            <span>{lang.nativeName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
