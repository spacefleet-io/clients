// The pairing code field on a computer (ACCT-PAIR-01): 8 boxes in two groups of 4 with a gap, never a dash
// (Chris 2026-11-18). One real <input> lies over the boxes and holds the code: typed or pasted with or without a dash or
// spaces, in any case (or a whole pairing link), it keeps the plain characters, and each one lands in the next box.
import { useState } from "react";
import { SHORT_CODE_LENGTH, shortCodeInput } from "@space/pairing-crypto";

export function ShortCodeInput({
  id,
  value,
  onChange,
  disabled,
  autoFocus,
  testId,
}: {
  id?: string;
  /** The canonical code typed so far (0..8 characters). */
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  testId?: string;
}) {
  const [focused, setFocused] = useState(false);
  const chars = value.padEnd(SHORT_CODE_LENGTH, " ").split("");
  const half = SHORT_CODE_LENGTH / 2;
  const active = focused && value.length < SHORT_CODE_LENGTH ? value.length : -1;
  return (
    <div className="relative mx-auto w-fit">
      <div className="flex items-center gap-4" aria-hidden="true" data-testid={testId ? `${testId}-boxes` : undefined}>
        {[chars.slice(0, half), chars.slice(half)].map((group, gi) => (
          <div key={gi} className="flex gap-1.5">
            {group.map((char, ci) => (
              <span
                key={ci}
                className={`flex h-12 w-9 items-center justify-center rounded-lg border bg-muted/40 font-mono text-xl font-semibold ${
                  gi * half + ci === active ? "border-2 border-primary" : "border-border"
                }`}
              >
                {char.trim()}
              </span>
            ))}
          </div>
        ))}
      </div>
      <input
        id={id}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(shortCodeInput(event.target.value))}
        // A pasted code or link replaces what is there, even when the boxes are already full.
        onPaste={(event) => {
          const pasted = shortCodeInput(event.clipboardData.getData("text"));
          if (!pasted) return;
          event.preventDefault();
          onChange(pasted);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
      />
    </div>
  );
}
