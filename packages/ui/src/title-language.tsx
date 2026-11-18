/**
 * ACCT-PROF-03: "App language everywhere" or "Original version" for a profile's titles, posters and backdrops — the
 * two options, each with its description and its two example titles, the same on every app (REL-FAM-02). The words
 * come from the app's i18n (`withTitleLanguageTexts` in `@space/shared/titleLanguage`, key `titleLanguage.*`).
 * `TitleLanguageChoice` is the two options (the Settings entry and the question both draw it); `TitleLanguageQuestion`
 * is the standalone "How should titles appear?" screen, "App language everywhere" selected until the user picks.
 */
import { useState } from "react";
import { TITLE_LANGUAGES, type TitleLanguage, type TitleLanguageTexts } from "@space/shared/titleLanguage";

import { Button } from "./button";
import { cn } from "./utils";

export type TitleLanguageChoiceProps = {
  value: TitleLanguage;
  onChange: (next: TitleLanguage) => void;
  texts: Pick<TitleLanguageTexts, "app" | "original">;
  /** Names the group for assistive tech (the question, or the setting's title). */
  ariaLabel: string;
  disabled?: boolean;
};

export const TitleLanguageChoice = ({ value, onChange, texts, ariaLabel, disabled }: TitleLanguageChoiceProps) => (
  <div role="radiogroup" aria-label={ariaLabel} className="grid gap-3" data-testid="title-language-choice">
    {TITLE_LANGUAGES.map((option) => {
      const selected = option === value;
      const words = texts[option];
      return (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          data-testid={`title-language-${option}`}
          onClick={() => onChange(option)}
          className={cn(
            "flex w-full flex-col gap-1 rounded-xl border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <span
              aria-hidden
              className={cn("flex h-4 w-4 items-center justify-center rounded-full border", selected ? "border-primary" : "border-muted-foreground")}
            >
              {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
            </span>
            {words.label}
          </span>
          <span className="text-sm text-muted-foreground">{words.description}</span>
          <span className="flex flex-col text-sm italic text-muted-foreground" data-testid={`title-language-${option}-examples`}>
            {words.examples.map((example) => (
              <span key={example}>{example}</span>
            ))}
          </span>
        </button>
      );
    })}
  </div>
);

/** The standalone question (no step count): asked once, right after the profile is picked. */
export const TitleLanguageQuestion = ({
  texts,
  continueLabel,
  onAnswer,
  busy,
}: {
  texts: TitleLanguageTexts;
  continueLabel: string;
  onAnswer: (answer: TitleLanguage) => void;
  busy?: boolean;
}) => {
  const [value, setValue] = useState<TitleLanguage>("app");
  return (
    <section data-testid="title-language-question" className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{texts.question}</h1>
        <p className="text-sm text-muted-foreground">{texts.intro}</p>
      </div>
      <TitleLanguageChoice value={value} onChange={setValue} texts={texts} ariaLabel={texts.question} disabled={busy} />
      <Button type="button" className="self-end" disabled={busy} data-testid="title-language-continue" onClick={() => onAnswer(value)}>
        {continueLabel}
      </Button>
    </section>
  );
};
