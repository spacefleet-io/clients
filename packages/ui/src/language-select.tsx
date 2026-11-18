import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { isClientUiLanguage } from "@space/shared/i18n";
import { Flag } from "./flag";
import { cn } from "./utils";

export type LanguageSelectItem<L extends string> = { code: L; nativeName: string };

export type LanguageSelectProps<L extends string> = {
  value: L;
  onChange: (code: L) => void;
  /** The app's languages in menu order: `CLIENT_UI_LANGUAGES` from `@space/shared/i18n`. A choice that is not a
   * language (Badger's metadata "Automatic") draws no flag and keeps the flag's room, so the names stay aligned. */
  languages: readonly LanguageSelectItem<L>[];
  ariaLabel: string;
  /** The trigger's id, for a `<label htmlFor>`. */
  id?: string;
  /** The trigger's test id; each row is `${testId}-option-${code}`. */
  testId?: string;
  disabled?: boolean;
  /** Extra classes for the trigger (the website's dark field). */
  className?: string;
  /** Extra classes for the open list. */
  menuClassName?: string;
};

const LanguageLead = ({ code }: { code: string }) =>
  isClientUiLanguage(code) ? <Flag code={code} /> : <span className="h-4 w-6 shrink-0" aria-hidden="true" />;

/**
 * The language setting as a dropdown field whose button and rows show the language's SVG flag and its own name
 * (UX-I18N-10). A native `<select>` cannot draw a flag (its rows are plain text, and emoji flags show as "GB", "FR"…
 * on Windows), so Settings use this instead. Click or Enter/Space/Down opens it; Up/Down move between rows; Escape or a
 * click outside closes it.
 */
export function LanguageSelect<L extends string>({
  value,
  onChange,
  languages,
  ariaLabel,
  id,
  testId,
  disabled,
  className,
  menuClassName,
}: LanguageSelectProps<L>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = languages.find((language) => language.code === value) ?? languages[0];

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, languages.findIndex((language) => language.code === value));
    rowRefs.current[index]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, languages, value]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (code: L) => {
    close();
    if (code !== value) onChange(code);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowRefs.current.filter((row): row is HTMLButtonElement => row !== null);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      rows[Math.min(rows.length - 1, at + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      rows[Math.max(0, at - 1)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      rows[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={`${ariaLabel}: ${current?.nativeName ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        data-value={value}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm text-foreground transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {current ? <LanguageLead code={current.code} /> : null}
        <span className="flex-1 truncate" lang={current && isClientUiLanguage(current.code) ? current.code : undefined}>
          {current?.nativeName}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={onListKeyDown}
          className={cn(
            "absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-background p-1 text-sm shadow-lg",
            menuClassName,
          )}
        >
          {languages.map((language, index) => {
            const selected = language.code === value;
            return (
              <button
                key={language.code}
                ref={(row) => {
                  rowRefs.current[index] = row;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                lang={isClientUiLanguage(language.code) ? language.code : undefined}
                data-testid={testId ? `${testId}-option-${language.code}` : undefined}
                onClick={() => pick(language.code)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                  selected ? "text-primary" : "text-foreground",
                )}
              >
                <LanguageLead code={language.code} />
                <span className="flex-1">{language.nativeName}</span>
                {selected ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
