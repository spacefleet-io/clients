import { loadClientConfig } from "../lib/config";
import { initI18n } from "./index";

// Starts fetching the active locale chunk the moment this module evaluates.
// main.tsx imports it FIRST, so ES module order runs it before the App graph in
// the entry chunk: the locale fetch overlaps the rest of the entry's evaluation
// instead of starting after it (issue #25). main.tsx awaits this before render.
export const i18nReady: Promise<void> = initI18n(loadClientConfig().uiLanguage);
