import { SPACE_APP_NAMES } from "@space/shared/appScope";
import { mobileNebulaSpots } from "@space/shared/skyNebula";
import { mergeMobileShellTheme } from "@space/mobile-shell/theme";

// Re-export the shell's default theme for backward compatibility.
// All shell components read from the MobileShellThemeProvider context instead.
export { defaultMobileShellTheme as theme } from "@space/mobile-shell/theme";

/** Badger's shell theme on phone and TV: the default theme with Badger's name (the crash screen's "Badger needs to
 * restart this screen.", UX-CRASH-01) and yellow nebula (UX-SKY-03). */
export const badgerShellTheme = mergeMobileShellTheme({ brandName: SPACE_APP_NAMES.badger, nebula: mobileNebulaSpots("badger") });
