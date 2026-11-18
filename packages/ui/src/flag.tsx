import { flagDataUri, isFlagCode } from "@space/shared/languageFlags";

export { FLAG_CODES } from "@space/shared/languageFlags";

type FlagProps = { code: string; className?: string };

/**
 * A flag as an image (the Noto emoji artwork of `@space/shared/languageFlags`), never emoji text, so it looks the same
 * on every system: emoji flags show as the letters "GB", "FR"… on Windows. The app and site languages (English is the
 * British flag) for every language picker on desktop and the web (UX-I18N-10, WEB-LANG-03), and the European Union for
 * the website's trust badges. Fitted, centred, in the 3:2 box `className` sizes; any other code draws nothing.
 */
export const Flag = ({ code, className = "h-4 w-6" }: FlagProps) => {
  if (!isFlagCode(code)) return null;
  return <img src={flagDataUri(code)} alt="" aria-hidden="true" draggable={false} className={`${className} shrink-0 object-contain`} data-flag={code} />;
};
