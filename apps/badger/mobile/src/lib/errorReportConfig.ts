/**
 * Build-time error report settings (REL-LOG-06). The Bugsink DSNs are not in the source: `scripts/write-error-report-config.ts`
 * writes the gitignored `src/generated/errorReportConfig.ts` from `SF_BUGSINK_DSN_BADGER_MOBILE` / `SF_BUGSINK_DSN_BADGER_TV`.
 * On a fresh clone (or any build that skipped the script) the file does not exist: that build has no DSN and cannot report.
 */
import { Platform } from "react-native";

export type GeneratedErrorReportConfig = {
  BADGER_MOBILE_DSN?: string;
  BADGER_TV_DSN?: string;
};

/** The TV app gets its own Bugsink project, so a TV crash never lands in the phone's list. */
export const pickDsn = (generated: GeneratedErrorReportConfig, isTV: boolean): string =>
  (isTV ? generated.BADGER_TV_DSN : generated.BADGER_MOBILE_DSN) ?? "";

/** Metro treats a `require` inside `try` as an optional dependency, so the missing file does not fail the bundle. */
const readGenerated = (): GeneratedErrorReportConfig => {
  try {
    return require("../generated/errorReportConfig") as GeneratedErrorReportConfig;
  } catch {
    return {};
  }
};

/** DSN baked into this build for this app (phone or TV); empty string when the build cannot report. */
export const getBuildDsn = (generated: GeneratedErrorReportConfig = readGenerated()): string =>
  pickDsn(generated, Platform.isTV === true);
