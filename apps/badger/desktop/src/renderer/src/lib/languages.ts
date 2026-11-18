import {
  findMediaLanguage,
  formatMediaLanguageLabel,
  formatMediaLanguageOptionLabel,
  getMediaLanguageFlag,
  MEDIA_LANGUAGE_OPTIONS,
} from "@space/shared";

export const isMediaLanguage = (value: string) => Boolean(findMediaLanguage(value));

export { MEDIA_LANGUAGE_OPTIONS, formatMediaLanguageLabel, formatMediaLanguageOptionLabel, getMediaLanguageFlag };
