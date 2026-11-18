import { openSourceFor, type CreditProduct } from "@space/legal/credits";

/**
 * UX-SET-03: the line that opens each app's credits place, "<App> is open source, under the GPL-3.0 licence.", and a
 * link to the public client repository, then the credits of the language pickers' flag artwork (UX-I18N-10) and of
 * the Inter and Space Grotesk fonts. `<span>`s with `block`, so it also fits in a settings row's description paragraph.
 * In the Electron apps the `_blank` link reaches the main process's window-open handler, which hands `https:` addresses
 * to the system browser (`isAllowedExternalUrl`); the web players open it in a new tab.
 */
export const OpenSourceNotice = ({ language, product }: { language: string | undefined; product: CreditProduct }) => {
  const { notice, linkLabel, url, flags, fonts } = openSourceFor(language, product);
  return (
    <span className="block" data-testid="open-source-notice">
      <span>{notice}</span>{" "}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        data-testid="open-source-link"
      >
        {linkLabel}
      </a>
      <span className="mt-2 block" data-testid="open-source-flags">
        {flags}
      </span>
      <span className="block" data-testid="open-source-fonts">
        {fonts}
      </span>
    </span>
  );
};
