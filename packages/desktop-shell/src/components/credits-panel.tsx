import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { creditsFor, type CreditProduct } from "@space/legal/credits";
import { resolveLegalLanguage } from "@space/legal";
import type { CreditsSource } from "@space/metadata-client/credits";
import { useSourceCredits } from "@space/metadata-client/credits-react";

/**
 * Settings > About: who provides the data the app shows, with the logo and notice a source's terms require, in the
 * app's language. The list comes from the metadata service (`GET /credits`, META-SRC-09), the same list as the
 * website's legal notice credits (WEB-LEGAL-17), and the last answer is kept on the device; before the app was ever
 * online a neutral line stands in. The words around it come from `@space/legal/credits`.
 * The credits sit under one "About" header that is closed by default and opens in place (UX-SET-02); the closed body
 * stays in the page, `hidden`, so the attribution text and logo are unchanged and one click away.
 */
export const CreditsPanel = ({
  language,
  product,
  source,
}: {
  language: string | undefined;
  product: CreditProduct;
  source: CreditsSource;
}) => {
  const lang = resolveLegalLanguage(language);
  const labels = creditsFor(lang);
  const credits = useSourceCredits(product, lang, source);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section className="rounded-xl border border-border bg-card/40 text-sm" data-testid="settings-credits">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-xl p-4 text-left font-semibold hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        data-testid="settings-credits-toggle"
      >
        <span>{labels.about}</span>
        <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div id={bodyId} hidden={!open} className="space-y-3 px-4 pb-4" data-testid="settings-credits-body">
        <h3 className="font-semibold">{labels.heading}</h3>
        <p className="text-muted-foreground">{labels.intro}</p>
        {credits ? (
          <>
            <ul className="list-disc space-y-1.5 pl-5">
              {credits.entries.map((entry) => (
                <li key={entry.id}>
                  <a href={entry.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    {entry.name}
                  </a>
                  {credits.separator}
                  <span className="text-muted-foreground">{entry.text}</span>
                </li>
              ))}
            </ul>
            {credits.entries
              .filter((entry) => entry.logo || entry.notice)
              .map((entry) => (
                <p key={entry.id} className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {entry.logo ? <img src={entry.logo} alt={entry.name} className="h-3 w-auto" data-testid="credit-logo" /> : null}
                  {entry.notice ? <span>{entry.notice}</span> : null}
                </p>
              ))}
          </>
        ) : (
          <p className="text-muted-foreground" data-testid="settings-credits-unavailable">
            {labels.unavailable}
          </p>
        )}
      </div>
    </section>
  );
};
