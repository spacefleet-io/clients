/**
 * The menus that open under the library row's Sort, Genres and Actors buttons (UX-LIB-01), shared by the Badger desktop
 * app and the web player (REL-FAM-02). Each app keeps when a menu is open; these draw what is inside it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { LibraryModalSection, LibraryPills, type LibraryPill } from "../library-row";
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

/** Up to this many choices a Filter list is plain chips; past it (Actors, Directors in a big library) a search narrows them. */
export const FILTER_CHIP_LIMIT = 15;

/**
 * UX-LIB-01: one list of the Filter panel, drawn as Parrot's are — chips that are on while picked. A short list
 * (watch state, a small library's genres) shows every chip; a long one shows a search, its picked chips, and the
 * first FILTER_CHIP_LIMIT matches, then a "+N more" chip that shows the rest in place. Nothing scrolls inside the
 * panel, which scrolls as one.
 */
export function BadgerFilterPicker({
  searchPlaceholder,
  emptyText,
  moreLabel,
  options,
  selected,
  onChange,
}: {
  searchPlaceholder: string;
  emptyText: string;
  /** The "+N more" chip's words, given N. */
  moreLabel: (count: number) => string;
  options: BadgerMultiSelectOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  // "+N more" vanishes as it is pressed: the focus moves on to the first chip it revealed (else it falls to the panel).
  const [focusChip, setFocusChip] = useState<number | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusChip === null) return;
    chipsRef.current?.querySelectorAll("button")[focusChip]?.focus();
    setFocusChip(null);
  }, [focusChip]);
  const searchable = options.length > FILTER_CHIP_LIMIT;
  const selectedSet = new Set(selected);
  const q = normalize(query);
  const picked = searchable ? options.filter((option) => selectedSet.has(option.value)) : [];
  const matches = searchable ? options.filter((option) => !selectedSet.has(option.value) && (!q || normalize(option.label).includes(q))) : options;
  const visible = expanded ? matches : matches.slice(0, FILTER_CHIP_LIMIT);
  const hidden = matches.length - visible.length;
  const toggle = (value: string) => onChange(selectedSet.has(value) ? selected.filter((entry) => entry !== value) : [...selected, value]);
  const pills: LibraryPill[] = [...picked, ...visible].map((option) => ({ id: option.value, label: option.label, on: selectedSet.has(option.value), onClick: () => toggle(option.value) }));
  if (hidden > 0)
    pills.push({
      id: "__more",
      label: moreLabel(hidden),
      onClick: () => {
        setExpanded(true);
        setFocusChip(pills.length - 1);
      },
      testId: "library-filter-more",
    });
  return (
    <div className="space-y-2">
      {searchable ? <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} /> : null}
      {pills.length === 0 ? (
        <div className="text-xs text-muted-foreground">{emptyText}</div>
      ) : (
        <div ref={chipsRef}>
          <LibraryPills pills={pills} />
        </div>
      )}
    </div>
  );
}

/** The Sort panel: which field (added, name, release) and which direction; labels arrive translated, colours are the theme's. */
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
      <LibraryModalSection label={byLabel}>
        <LibraryPills pills={options.map((option) => ({ id: option.value, label: option.label, on: value === option.value, onClick: () => onChange(option.value), testId: `library-sort-${option.value}` }))} />
      </LibraryModalSection>
      <LibraryModalSection label={directionLabel}>
        <LibraryPills
          pills={[{ id: "direction", label: directionText, onClick: onToggleDirection, testId: "library-sort-direction", icon: direction === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden /> }]}
        />
      </LibraryModalSection>
    </>
  );
}
