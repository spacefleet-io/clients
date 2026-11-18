// better-sqlite3 13 is a Node-API addon: one prebuilt binary per platform
// (`prebuilds/<platform>-<arch>.node`) loads under Node and every Electron
// version, so there is no per-Electron rebuild or binding cache to manage.
// The binding can still fail to load (platform without a prebuild, a damaged
// install, an OS policy blocking the .node file); this classifies those errors
// so the IPC layer can return actionable guidance instead of a raw dlopen error.

export const BETTER_SQLITE_NATIVE_LOAD_GUIDANCE =
  "Native SQLite binding mismatch: better-sqlite3 could not load its prebuilt binary for this platform. Reinstall Badger (in a dev checkout, run `bun install`) and restart the app.";

export const isBetterSqliteNativeMismatchError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Module did not self-register") ||
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("ERR_DLOPEN_FAILED") ||
    // No prebuild for this platform: better-sqlite3 falls back to
    // build/Release/better_sqlite3.node, which a prebuilt install never has.
    (message.includes("Cannot find module") && message.includes("better_sqlite3"))
  );
};
