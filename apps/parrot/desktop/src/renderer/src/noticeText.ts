// The words of Parrot's notices (UX-NOTICE-13): the shared `notify.*` texts of `@space/notify-core` (the bell, the
// tray, job titles) and Parrot's own keys, in the language of the moment. The history keeps keys, not words, so an
// entry follows a language change.
import { notifyLanguage, notifyTranslator, type Translate as NoticeTranslate } from "@space/notify-core/texts";
import type { ParrotLanguage } from "../../shared/ipc";
import { PARROT_STRINGS, type ParrotStringKey, type Translate } from "./i18n";

/** Titles an older version saved under Parrot's own keys, now shared ones. */
const SHARED_SINCE: Record<string, string> = {
  "notifications.importDone": "notify.job.importDone",
  "notifications.importFailed": "notify.job.importFailed",
};

const isParrotKey = (key: string): key is ParrotStringKey => key in PARROT_STRINGS.en;

/** One `t` for notices: `notify.*` from the shared texts, the rest from Parrot's `t`; an unknown key comes back as is. */
export const noticeTranslator = (language: ParrotLanguage, t: Translate): NoticeTranslate => {
  const shared = notifyTranslator(notifyLanguage(language));
  return (key, vars) => {
    const current = SHARED_SINCE[key] ?? key;
    if (current.startsWith("notify.")) return shared(current, vars);
    return isParrotKey(current) ? t(current, vars) : current;
  };
};
