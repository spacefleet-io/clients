#!/usr/bin/env bun
/**
 * Writes `src/generated/errorReportConfig.ts` (gitignored) from the build environment so the Bugsink DSNs are baked
 * into the JS bundle at build time (REL-LOG-06); the Play build's come from CI secrets, the Google-free build's from
 * the committed `scripts/android-foss-error-report.env`. Run it before bundling a build that should be able to report:
 * `bun run --cwd apps/badger/mobile error-report-config`.
 *
 *   SF_BUGSINK_DSN_BADGER_MOBILE  phone app DSN
 *   SF_BUGSINK_DSN_BADGER_TV      TV app DSN
 *
 * An unset variable becomes an empty string: that build cannot report. Without this file the app behaves the same
 * (`src/lib/errorReportConfig.ts` treats a missing file as "no DSN"). The writer is shared with Parrot
 * (`@space/error-report/build-config`).
 */
import { fileURLToPath } from "node:url";
import { describeErrorReportEnv, renderErrorReportConfig as render, writeErrorReportConfigFile } from "@space/error-report/build-config";

export const ERROR_REPORT_CONFIG_PATH = fileURLToPath(new URL("../src/generated/errorReportConfig.ts", import.meta.url));

export interface ErrorReportBuildEnv extends Record<string, string | undefined> {
  SF_BUGSINK_DSN_BADGER_MOBILE?: string;
  SF_BUGSINK_DSN_BADGER_TV?: string;
}

const GENERATOR = "scripts/write-error-report-config.ts";
const entries = (env: ErrorReportBuildEnv) => ({
  BADGER_MOBILE_DSN: env.SF_BUGSINK_DSN_BADGER_MOBILE,
  BADGER_TV_DSN: env.SF_BUGSINK_DSN_BADGER_TV,
});

export const renderErrorReportConfig = (env: ErrorReportBuildEnv): string => render(entries(env), GENERATOR);

export const writeErrorReportConfig = (env: ErrorReportBuildEnv, path = ERROR_REPORT_CONFIG_PATH): void =>
  writeErrorReportConfigFile(path, entries(env), GENERATOR);

if (import.meta.main) {
  writeErrorReportConfig(process.env);
  console.info(`[error-report-config] wrote ${ERROR_REPORT_CONFIG_PATH}`);
  for (const line of describeErrorReportEnv(process.env, ["SF_BUGSINK_DSN_BADGER_MOBILE", "SF_BUGSINK_DSN_BADGER_TV"])) console.info(line);
}
