#!/usr/bin/env bun
/**
 * Writes `src/generated/errorReportConfig.ts` (gitignored) from the build environment so the Bugsink DSN is baked into
 * the JS bundle at build time (REL-LOG-06); the Play build's comes from a CI secret, the Google-free build's from the
 * committed `scripts/android-foss-error-report.env`. Run it before bundling a build that should be able to report:
 * `bun run --cwd apps/parrot/mobile error-report-config`.
 *
 *   SF_BUGSINK_DSN_PARROT_MOBILE  phone app DSN
 *
 * An unset variable becomes an empty string: that build cannot report. The writer is the one Badger uses
 * (`@space/error-report/build-config`).
 */
import { fileURLToPath } from "node:url";
import { describeErrorReportEnv, writeErrorReportConfigFile } from "@space/error-report/build-config";

const path = fileURLToPath(new URL("../src/generated/errorReportConfig.ts", import.meta.url));
writeErrorReportConfigFile(path, { PARROT_MOBILE_DSN: process.env.SF_BUGSINK_DSN_PARROT_MOBILE }, "scripts/write-error-report-config.ts");
console.info(`[error-report-config] wrote ${path}`);
for (const line of describeErrorReportEnv(process.env, ["SF_BUGSINK_DSN_PARROT_MOBILE"])) console.info(line);
