import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { fuzzyRank } from "@space/shared/fuzzySearch";

import { RenderBoundary } from "./render-boundary";
import { cn } from "./utils";

/**
 * The search palette of Badger and Parrot (UX-SEARCH-01): a modal opened from the header's search button or
 * Ctrl+K / Cmd+K, ranking the library live as the user types with the shared typo-tolerant matcher
 * (UX-SEARCH-02). Up/Down move the highlight, Enter opens the highlighted result, Esc closes.
 */

export type SearchPaletteItem = {
  /** Unique across all kinds. */
  key: string;
  /** Kind shown as a tag on the row (title, person, artist, album, song); a key of `labels.kinds`. */
  kind: string;
  title: string;
  subtitle?: string;
  /**
   * The subtitle as names that each open their own page (Parrot's artist and album, PAR-NAV-05), joined by " · ";
   * shown instead of `subtitle` unless the row names the keyword it matched.
   */
  subtitleLinks?: readonly { text: string; onOpen?: () => void }[];
  /** App-specific artwork reference (a poster path, a cover id) handed to `renderImage`. */
  image?: string | null;
  /** Other searched texts (people in a title, the artist of an album); a match there names it on the row. */
  keywords?: readonly string[];
  /** Icon buttons on the row (Parrot's Add to queue on a song, PAR-CARD-02); they act without opening the result. */
  actions?: readonly SearchPaletteItemAction[];
};

export type SearchPaletteItemAction = {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  testId: string;
};

export type SearchPaletteLabels = {
  /** Dialog name for screen readers. */
  title: string;
  placeholder: string;
  /** Shown when the query matches nothing. */
  empty: string;
  /** Shown before anything is typed. */
  hint: string;
  /** Prefix of the matched keyword on a row, e.g. "With" in "With Keanu Reeves". */
  matchedVia: string;
  kinds: Record<string, string>;
};

export type SearchPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly SearchPaletteItem[];
  labels: SearchPaletteLabels;
  onSelect: (item: SearchPaletteItem) => void;
  /** Draws a row's 40px artwork (each app resolves its own image paths); rows without one show the title's initial. */
  renderImage?: (item: SearchPaletteItem) => React.ReactNode;
  /** Most rows shown at once. */
  limit?: number;
};

export function SearchPalette({ open, onOpenChange, items, labels, onSelect, renderImage, limit = 30 }: SearchPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const hits = React.useMemo(
    () => fuzzyRank(items, query, (item) => [item.title, ...(item.keywords ?? [])], limit),
    [items, query, limit],
  );

  React.useEffect(() => setActive(0), [query]);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: SearchPaletteItem) => {
    onOpenChange(false);
    onSelect(item);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (!hit) return;
      event.preventDefault();
      choose(hit.item);
    }
  };

  const listId = React.useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const trimmed = query.trim();

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* UX-CRASH-01: a crash inside the palette closes it; the window guard says why. */}
      <RenderBoundary name="search-palette" resetKey={open} onDismiss={() => onOpenChange(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="search-palette"
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
        >
          <DialogPrimitive.Title className="sr-only">{labels.title}</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <Search aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
            <input
              data-testid="search-palette-input"
              autoFocus
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls={listId}
              aria-activedescendant={hits[active] ? optionId(active) : undefined}
              aria-autocomplete="list"
              value={query}
              placeholder={labels.placeholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
            />
          </div>
          {trimmed === "" || hits.length === 0 ? (
            <p data-testid="search-palette-status" className="px-5 py-6 text-sm text-muted-foreground">
              {trimmed === "" ? labels.hint : labels.empty}
            </p>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" aria-label={labels.title} className="overflow-y-auto p-2">
              {hits.map((hit, index) => {
                const { item } = hit;
                const via = hit.field > 0 ? item.keywords?.[hit.field - 1] : undefined;
                const subtitle = via ? `${labels.matchedVia} ${via}` : item.subtitle;
                return (
                  <li
                    key={item.key}
                    id={optionId(index)}
                    data-index={index}
                    data-testid="search-palette-result"
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(item)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2",
                      index === active ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    {/* UX-CRASH-01: a result that throws shows a placeholder in its place; the other results stay. */}
                    <RenderBoundary name={`search-result:${item.key}`} variant="item" className="min-h-10 flex-1">
                    {item.image && renderImage ? (
                      <span className="h-10 w-10 shrink-0 overflow-hidden rounded-md">{renderImage(item)}</span>
                    ) : (
                      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
                        {item.title.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.title}</span>
                      {subtitle ? (
                        <span data-testid="search-palette-subtitle" className={cn("block truncate text-sm", index === active ? "text-accent-foreground opacity-80" : "text-muted-foreground")}>
                          {!via && item.subtitleLinks
                            ? item.subtitleLinks.map((link, part) => (
                                <React.Fragment key={part}>
                                  {part > 0 && " · "}
                                  {link.onOpen ? (
                                  <button
                                    type="button"
                                    className="hover:underline focus-visible:underline focus-visible:outline-none"
                                    data-testid="search-palette-subtitle-link"
                                    onClick={(event) => {
                                      // The name opens its own page, not the result's.
                                      event.stopPropagation();
                                      onOpenChange(false);
                                      link.onOpen!();
                                    }}
                                  >
                                    {link.text}
                                  </button>
                                  ) : (
                                    link.text
                                  )}
                                </React.Fragment>
                              ))
                            : subtitle}
                        </span>
                      ) : null}
                    </span>
                    {item.actions?.map((action) => (
                      <button
                        key={action.testId}
                        type="button"
                        aria-label={action.label}
                        title={action.label}
                        data-testid={action.testId}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md opacity-80 hover:bg-background/40 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(event) => {
                          // Acts on the song and leaves the palette open, to add more.
                          event.stopPropagation();
                          action.onSelect();
                        }}
                      >
                        {action.icon}
                      </button>
                    ))}
                    <span
                      data-testid="search-palette-kind"
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-xs",
                        index === active ? "border-current text-accent-foreground opacity-80" : "border-border text-muted-foreground",
                      )}
                    >
                      {labels.kinds[item.kind] ?? item.kind}
                    </span>
                    </RenderBoundary>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
      </RenderBoundary>
    </DialogPrimitive.Root>
  );
}

/** Opens the palette on Ctrl+K (Cmd+K on macOS) anywhere in the window. */
export function useSearchPaletteShortcut(onOpen: () => void, enabled = true) {
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen, enabled]);
}
