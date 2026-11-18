import { getDesktopPlatform } from "./index";

/** Module the conformance helper processes import: `export const platform` of the host OS. */
export const platform = getDesktopPlatform();
