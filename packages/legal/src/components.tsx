import { useEffect, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  LEGAL_CONTENT,
  LEGAL_FOOTER_SLUGS,
  legalPath,
  parseLegalInline,
  resolveLegalLanguage,
  legalItemText,
  type LegalLanguage,
  type LegalSlug,
} from "./index";
import { creditsFor, flagsCreditFor, fontsCreditFor } from "./credits";

const InlineText = ({ text, lang }: { text: string; lang: LegalLanguage }) => (
  <>
    {parseLegalInline(text).map((part, index) => {
      if (part.kind === "text") return <span key={index}>{part.text}</span>;
      if (part.kind === "page") {
        return (
          <Link key={index} to={legalPath(lang, part.slug)} className="text-[#58a6ff] underline-offset-2 hover:underline">
            {part.text}
          </Link>
        );
      }
      return (
        <a key={index} href={part.href} className="text-[#58a6ff] underline-offset-2 hover:underline" rel="noreferrer">
          {part.text}
        </a>
      );
    })}
  </>
);

/**
 * One legal page (WEB-LEGAL-01), in the language of the `:lang` route segment; any other segment shows English.
 * `credits` adds the third-party data credits at the end of the legal notice (WEB-LEGAL-17, website only): the
 * website renders them, as this package names no data source (META-SRC-09).
 */
export const LegalPage = ({
  slug,
  footer,
  credits,
}: {
  slug: LegalSlug;
  footer?: ReactNode;
  credits?: (lang: LegalLanguage) => ReactNode;
}) => {
  const lang = resolveLegalLanguage(useParams().lang);
  const content = LEGAL_CONTENT[lang];
  const page = content.pages[slug];

  useEffect(() => {
    document.title = `${page.title} | SpaceFleet`;
  }, [page.title]);

  return (
    <div className="min-h-screen text-foreground" data-testid={`legal-${slug}`}>
      <article className="relative z-20 px-4 pb-20 pt-32">
        <div className="container mx-auto max-w-3xl">
          <h1 className="mb-3 text-4xl font-bold tracking-tight md:text-5xl">{page.title}</h1>
          <p className="mb-6 text-sm text-muted-foreground/80">{content.updated}</p>
          <p className="mb-10 text-lg text-foreground/90">
            <InlineText text={page.intro} lang={lang} />
          </p>
          {page.sections.map((section) => (
            <section key={section.heading} className="mb-6 rounded-2xl border border-border bg-card p-6">
              <h2 className="mb-3 text-lg font-bold text-white">{section.heading}</h2>
              <div className="space-y-3 text-foreground/90">
                {section.blocks.map((block, index) =>
                  typeof block === "string" ? (
                    <p key={index}>
                      <InlineText text={block} lang={lang} />
                    </p>
                  ) : (
                    <ul key={index} className="list-disc space-y-2 pl-5">
                      {block.items.map((item) => (
                        <li
                          key={legalItemText(item)}
                          id={typeof item === "string" ? undefined : item.id}
                          className={typeof item === "string" ? undefined : "scroll-mt-24"}
                        >
                          <InlineText text={legalItemText(item)} lang={lang} />
                        </li>
                      ))}
                    </ul>
                  ),
                )}
              </div>
            </section>
          ))}
          {credits && slug === "legal-notice" ? credits(lang) : null}
        </div>
      </article>
      {footer}
    </div>
  );
};

/**
 * The frame of the website's data credits (WEB-LEGAL-17): heading, intro, then `children` (the credited sources,
 * supplied by the website from its server/site-only list), then the flags and fonts credits.
 */
export const LegalCreditsSection = ({ lang, children }: { lang: LegalLanguage; children?: ReactNode }) => {
  const credits = creditsFor(lang);
  return (
    <section className="mb-6 rounded-2xl border border-border bg-card p-6" data-testid="legal-credits">
      <h2 className="mb-3 text-lg font-bold text-white">{credits.heading}</h2>
      <div className="space-y-3 text-foreground/90">
        <p>{credits.intro}</p>
        {children}
        <p className="text-sm text-muted-foreground/80" data-testid="legal-flags-credit">
          {flagsCreditFor(lang)}
        </p>
        <p className="text-sm text-muted-foreground/80" data-testid="legal-fonts-credit">
          {fontsCreditFor(lang)}
        </p>
      </div>
    </section>
  );
};

/**
 * The footer links to the legal pages and the security policy. Plain anchors, so a footer rendered
 * outside a router still works; `language` is the app's current UI language.
 */
export const LegalLinks = ({ language }: { language: string | undefined }) => {
  const lang = resolveLegalLanguage(language);
  const content = LEGAL_CONTENT[lang];
  return (
    <nav aria-label={content.nav.label} data-testid="legal-links" className="flex flex-wrap justify-center gap-x-6 gap-y-2 px-4 text-xs">
      {LEGAL_FOOTER_SLUGS.map((slug) => (
        <a key={slug} href={legalPath(lang, slug)} className="hover:text-white transition-colors">
          {content.nav[slug]}
        </a>
      ))}
    </nav>
  );
};

/**
 * Consent text (WEB-LEGAL-18) with its links as plain anchors opening in a new tab, so reading the terms never loses a
 * half-filled checkout. `baseUrl` is the website's origin, for an app that is not served from the website.
 */
export const ConsentText = ({ text, language, baseUrl = "" }: { text: string; language: string | undefined; baseUrl?: string }) => {
  const lang = resolveLegalLanguage(language);
  return (
    <>
      {parseLegalInline(text).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <a
            key={index}
            href={part.kind === "page" ? `${baseUrl}${legalPath(lang, part.slug)}` : part.href}
            target="_blank"
            rel="noreferrer"
            className="text-[#58a6ff] underline underline-offset-2 hover:text-white"
          >
            {part.text}
          </a>
        ),
      )}
    </>
  );
};

export type CheckoutConsentState = { acceptTerms: boolean; startNow: boolean };
export const NO_CHECKOUT_CONSENT: CheckoutConsentState = { acceptTerms: false, startNow: false };

/**
 * The two boxes ticked before any payment (WEB-LEGAL-18): the terms of service and sale accepted, and the express
 * request to start at once while the 14-day money-back guarantee still applies (L221-25). Unticked at first; until
 * both are ticked, a line says so and the app keeps its paid choices closed.
 */
export const CheckoutConsentBoxes = ({
  language,
  value,
  onChange,
  baseUrl,
  testIdPrefix = "checkout",
}: {
  language: string | undefined;
  value: CheckoutConsentState;
  onChange: (next: CheckoutConsentState) => void;
  baseUrl?: string;
  testIdPrefix?: string;
}) => {
  const consent = LEGAL_CONTENT[resolveLegalLanguage(language)].consent;
  const box = (key: keyof CheckoutConsentState, text: string) => (
    <label className="flex items-start gap-3 text-left text-sm leading-relaxed text-foreground/90 cursor-pointer">
      <input
        type="checkbox"
        required
        data-testid={`${testIdPrefix}-consent-${key === "acceptTerms" ? "terms" : "start-now"}`}
        checked={value[key]}
        onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
        className="mt-1 h-4 w-4 shrink-0 accent-[#ffaa54] cursor-pointer"
      />
      <span>
        <ConsentText text={text} language={language} baseUrl={baseUrl} />
      </span>
    </label>
  );
  const given = value.acceptTerms && value.startNow;
  return (
    <fieldset
      data-testid={`${testIdPrefix}-consent`}
      data-given={String(given)}
      className="mx-auto w-full max-w-3xl space-y-3 rounded-xl border border-border bg-background px-4 py-4"
    >
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">{consent.heading}</legend>
      {box("acceptTerms", consent.terms)}
      {box("startNow", consent.startNow)}
      {!given && (
        <p data-testid={`${testIdPrefix}-consent-required`} className="text-left text-xs text-[#ffaa54]">
          {consent.required}
        </p>
      )}
    </fieldset>
  );
};

/** The sign-up line (WEB-LEGAL-18): creating an account accepts the terms; no box, as the terms' intro says. */
export const SignupTermsNotice = ({ language, baseUrl }: { language: string | undefined; baseUrl?: string }) => (
  <p data-testid="signup-terms-notice" className="text-xs leading-relaxed text-muted-foreground/80">
    <ConsentText text={LEGAL_CONTENT[resolveLegalLanguage(language)].consent.signup} language={language} baseUrl={baseUrl} />
  </p>
);
