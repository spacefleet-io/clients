import { errorReportsPrivacyUrl } from "@space/shared/websiteLinks";

/**
 * REL-LOG-06: the small "What's in a report?" link after the one-line error-reports text, in Settings and in the
 * first-launch question. It opens the error-reports part of the privacy policy in the browser (the window's open
 * handler hands `https:` links to the operating system).
 */
export const ErrorReportsLink = ({ language, label, testId }: { language: string; label: string; testId?: string }) => (
  <a
    href={errorReportsPrivacyUrl(language)}
    target="_blank"
    rel="noreferrer"
    className="whitespace-nowrap underline underline-offset-2 hover:text-foreground"
    data-testid={testId}
  >
    {label}
  </a>
);
