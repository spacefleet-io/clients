import { PUBLIC_CLIENT_REPO_URL } from "@space/shared/publicClientRepo";
import { LEGAL_CONTENT, resolveLegalLanguage } from "./index";

export type CreditProduct = "badger" | "parrot";

export type CreditsLabels = {
  /** The label of the collapsed About header the apps' credits sit under (UX-SET-02). */
  about: string;
  heading: string;
  intro: string;
  /** Shown in place of the list before the app ever reached the metadata service (META-SRC-09): no source named. */
  unavailable: string;
};

/**
 * The words around the data credits, in a UI language (English otherwise). The credited sources themselves come from
 * the metadata service (`GET /credits`, META-SRC-09) in the apps, and from the server/site-only list on the website's
 * legal notice (WEB-LEGAL-17); this package names none of them.
 */
export const creditsFor = (language: string | undefined): CreditsLabels => {
  const { about, heading, intro, unavailable } = LEGAL_CONTENT[resolveLegalLanguage(language)].credits;
  return { about, heading, intro, unavailable };
};

const APP_NAMES: Record<CreditProduct, string> = { badger: "Badger", parrot: "Parrot" };

export type OpenSourceNotice = {
  /** "<App> is open source, under the GPL-3.0 licence." */
  notice: string;
  /** "View the source code" */
  linkLabel: string;
  /** The public client repository, the one address the apps and the website link to. */
  url: string;
  /** "Language flags: Noto Emoji artwork by Google, under the Apache License 2.0." (UX-I18N-10's flag images) */
  flags: string;
  /** "Fonts: Inter and Space Grotesk, under the SIL Open Font License 1.1." (the fonts the mobile and TV apps bundle) */
  fonts: string;
};

/**
 * UX-SET-03: the line that opens each app's credits place, and its link to the public source code, in a UI language,
 * with the credits of the language pickers' flag artwork (UX-I18N-10) and of the bundled fonts.
 */
export const openSourceFor = (language: string | undefined, product: CreditProduct): OpenSourceNotice => {
  const { notice, link, flags, fonts } = LEGAL_CONTENT[resolveLegalLanguage(language)].credits.openSource;
  return { notice: notice.replace("{app}", APP_NAMES[product]), linkLabel: link, url: PUBLIC_CLIENT_REPO_URL, flags, fonts };
};

/** The credit of the language pickers' flag artwork (UX-I18N-10), for the website's legal notice. */
export const flagsCreditFor = (language: string | undefined): string => LEGAL_CONTENT[resolveLegalLanguage(language)].credits.openSource.flags;

/** The credit of the bundled Inter and Space Grotesk fonts (UX-SET-03), for the website's legal notice. */
export const fontsCreditFor = (language: string | undefined): string => LEGAL_CONTENT[resolveLegalLanguage(language)].credits.openSource.fonts;
