/**
 * The menus that open under the library row's Sort, Genres and Actors buttons (UX-LIB-01), shared by the Badger desktop
 * app and the web player (REL-FAM-02). Each app keeps when a menu is open; these draw what is inside it.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { cn } from "../utils";

/** The panel a row menu opens in, right-aligned under its button. */
export function BadgerMenuPanel({ children, width = "wide", onMouseLeave, testId }: { children: ReactNode; width?: "narrow" | "wide"; onMouseLeave?: () => void; testId?: string }) {
  return (
    <div
      className={cn(
        "absolute right-0 z-20 mt-2 max-w-[90vw] rounded-xl border border-[#30363d] bg-[#0f141b] p-3 text-white shadow-2xl",
        width === "wide" ? "w-[320px]" : "w-64",
      )}
      onMouseLeave={onMouseLeave}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export type BadgerMultiSelectOption = { value: string; label: string; icon?: ReactNode };

const normalize = (value: string) => value.trim().toLowerCase();

/** A searchable list of choices; picked ones show as removable chips above it (Genres, Actors). */
export function BadgerMultiSelect({
  label,
  placeholder,
  searchPlaceholder,
  emptyText,
  options,
  selected,
  onChange,
}: {
  label?: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  options: BadgerMultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return options;
    return options.filter((option) => normalize(option.label).includes(q));
  }, [options, query]);

  const toggle = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((entry) => entry !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <div className="space-y-2">
      {label ? <div className="text-sm font-semibold">{label}</div> : null}
      <div className="rounded-xl border border-border bg-background px-3 py-3 space-y-3">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} />
        {selected.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {selected.map((value) => {
              const option = options.find((entry) => entry.value === value);
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggle(value)}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-2 py-1 text-xs text-foreground hover:bg-muted/70"
                >
                  {option?.icon}
                  <span>{option?.label ?? value}</span>
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">{placeholder}</div>
        )}
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((option) => {
              const active = selectedSet.has(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(option.value)}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition", active ? "bg-primary/10 text-primary" : "hover:bg-muted/60")}
                >
                  {option.icon}
                  <span>{option.label}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** The Sort menu: which field (added, name, release) and which direction; labels arrive translated. */
export function BadgerSortMenu<T extends string>({
  byLabel,
  directionLabel,
  options,
  value,
  onChange,
  direction,
  directionText,
  onToggleDirection,
}: {
  byLabel: string;
  directionLabel: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  direction: "asc" | "desc";
  /** "Ascending" or "Descending", already translated. */
  directionText: string;
  onToggleDirection: () => void;
}) {
  return (
    <>
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">{byLabel}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? "default" : "secondary"}
            aria-pressed={value === option.value}
            data-testid={`library-sort-${option.value}`}
            className={value === option.value ? "bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30]" : "border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <div className="mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">{directionLabel}</div>
      <div className="mt-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="library-sort-direction"
          className="border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"
          onClick={onToggleDirection}
        >
          {direction === "asc" ? <ArrowUp className="mr-2 h-4 w-4" /> : <ArrowDown className="mr-2 h-4 w-4" />}
          {directionText}
        </Button>
      </div>
    </>
  );
}
