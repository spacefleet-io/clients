// META-ANON-06/07: the dev-key TEST package (`package.mjs --test-build`, `bun run package:windows-test`).
//
// A release package pins only the production ticket key; a stack that signs with the development key (the e2e
// harness, staging, a quick local build) then can never hand it a ticket, so title search cannot work. A test package
// is the release package's build with the renderer built as a `build:test` build (VITE_SF_DEV_TICKET_KEY=1, so
// `ticketKeysForBuild(true)`: development key + production key) and a version marked `-devkey`, so the installer
// (`Badger-Setup-<version>-devkey.exe`), the installed app (Apps & features, app.getVersion()) and every store
// record show it is no release. The release tooling refuses a `-devkey` version, so
// a test package can never become a release candidate, be released or reach the update feed.
//
// Both modes refuse VITE_SF_DEV_TICKET_KEY from the caller's environment: only the explicit --test-build flag makes
// a dev-key package, never a variable inherited from a shell or an .env file.

export const TEST_BUILD_FLAG = "--test-build";
/** Marks a test package's version (`0.1.0` → `0.1.0-devkey`). */
export const TEST_BUILD_VERSION_SUFFIX = "-devkey";
/** The variable package.mjs hands electron-builder.config.mjs: "1" for a test package, "" for a release package. */
export const TEST_BUILD_ENV = "SF_PACKAGE_TEST_BUILD";

/** @param {string} version */
export const testBuildVersion = (version) => `${version}${TEST_BUILD_VERSION_SUFFIX}`;

/** Whether an app version (or the version an installer file name carries) is a dev-key test package's. @param {string} version */
export const isTestBuildVersion = (version) => /-devkey(?:[.+]|$)/.test(version);

/**
 * The environment package.mjs's `build` step runs electron-vite with. Throws when the caller's environment sets the
 * dev-key flag itself (the release refusal, unchanged); otherwise the flag is "1" for a test package and blanked for a
 * release package.
 * @param {{ testBuild: boolean; env: Record<string, string | undefined> }} o
 * @returns {{ VITE_SF_DEV_TICKET_KEY: string }}
 */
export const packageBuildEnv = ({ testBuild, env }) => {
  if (env.VITE_SF_DEV_TICKET_KEY?.trim()) throw new Error("VITE_SF_DEV_TICKET_KEY is set: a package never pins the development ticket key (META-ANON-06)");
  return { VITE_SF_DEV_TICKET_KEY: testBuild ? "1" : "" };
};
