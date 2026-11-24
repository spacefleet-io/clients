/**
 * Badger's name and Electron userData dir, resolved per OS by the shared `resolveAppIdentity` (REL-FAM-03).
 *
 * The product is "Badger" on every OS. Linux and Windows keep their data in
 * `<appData>/@sf/desktop` (the dir existing installs use; the Linux safeStorage
 * keyring entry "<name> Safe Storage" is keyed by the app name). macOS keeps it
 * in `~/Library/Application Support/Badger` (REL-MAC-05, PLAT-DESK-07); Macs that
 * ran a pre-2026-11-12 "SpaceBadger" test build sign in again (no Mac release
 * existed before). A development build (`electron-vite dev`, test builds) keeps its data next to it, in the same dir
 * with `-dev` appended (`@sf/desktop-dev`, `Badger-dev`): it talks to another server than the release build, and
 * sharing the dir mixed the two servers' sessions and libraries (PLAT-DESK-14). `SF_USER_DATA_PATH` overrides the dir
 * on every OS (lanes, e2e).
 */
import type { AppIdentitySpec } from "@space/desktop-shell/main-shell";

export const BADGER_IDENTITY: AppIdentitySpec = {
  names: { productName: "Badger", legacyName: "Badger" },
  userData: { legacyDir: ["@sf", "desktop"] },
};
