import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** `lead` is drawn before the label: the language's flag in the setup language list (UX-I18N-10). */
export type ChoiceListOption<V extends string> = { value: V; label: string; hint?: string; lead?: ReactNode };

type Props<V extends string> = {
  /** Names the testids: `setup-${name}-${value}`. */
  name: string;
  value: V;
  options: ChoiceListOption<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
  recommended?: V;
  recommendedLabel?: string;
  /** Fixed list height; the list scrolls past it so a long list never pushes the screen (UX-SETUP-06). */
  maxHeightClassName?: string;
};

/**
 * A single-choice list that scrolls inside a fixed height instead of growing with its options, for choices that can
 * be long (the setup language). The picked item stays in view; Up/Down, Home/End and typing a letter move the pick.
 */
export function ChoiceList<V extends string>({
  name,
  value,
  options,
  onChange,
  ariaLabel,
  recommended,
  recommendedLabel,
  maxHeightClassName = "max-h-64",
}: Props<V>) {
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const optionId = (v: V) => `choice-${name}-${v}`;

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // jsdom has no layout, so scrollIntoView may be missing there.
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [value]);

  const pick = (next: number) => {
    const option = options[Math.min(options.length - 1, Math.max(0, next))];
    if (option && option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        pick(index + 1);
        break;
      case "ArrowUp":
        pick(index - 1);
        break;
      case "Home":
        pick(0);
        break;
      case "End":
        pick(options.length - 1);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const letter = event.key.toLocaleLowerCase();
        // Type-ahead: the next label after the current one starting with the typed letter, wrapping around.
        for (let step = 1; step <= options.length; step += 1) {
          const candidate = (index + step) % options.length;
          if (options[candidate]!.label.toLocaleLowerCase().startsWith(letter)) {
            pick(candidate);
            break;
          }
        }
        break;
      }
    }
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-activedescendant={optionId(value)}
      onKeyDown={onKeyDown}
      className={`${maxHeightClassName} space-y-2 overflow-y-auto rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-primary`}
      data-testid={`setup-${name}-list`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <div
            key={option.value}
            id={optionId(option.value)}
            role="option"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={`flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 ${selected ? "border-primary bg-primary/10" : "border-border hover:bg-card"}`}
            data-testid={`setup-${name}-${option.value}`}
          >
            {option.lead}
            <span>{option.label}</span>
            {option.hint ? <span className="text-xs text-muted-foreground">{option.hint}</span> : null}
            {recommended === option.value && recommendedLabel ? <span className="ml-auto text-xs text-primary">{recommendedLabel}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
