/**
 * Parrot's declarations for the main-process pieces it shares with Badger (REL-FAM-03).
 *
 * userData (PLAT-DESK-14): every release keeps `<appData>/spaceparrot`, the dir existing installs use, on every OS
 * (macOS included: moving it would sign every Mac user out); a development build keeps its own `spaceparrot-dev` next
 * to it, so it never reads the installed app's production sign-in or library. `SF_USER_DATA_PATH` overrides both.
 * The name is "Parrot" (package.json productName); Parrot never calls `app.setName`, the Linux keyring entry
 * "Parrot Safe Storage" stays as installs have it.
 *
 * Links: `parrot://` carries the payment return (ACCT-PAY-05) and the provider sign-in return (ACCT-SIGNIN-05).
 */
import { createAppLinks, type AppIdentitySpec } from "@space/desktop-shell/main-shell";

export const PARROT_IDENTITY: AppIdentitySpec = {
  names: { productName: "Parrot", legacyName: "Parrot" },
  userData: { everyOs: "spaceparrot" },
};

export const parrotLinks = createAppLinks("parrot");
