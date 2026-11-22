import type { ImageSourcePropType } from "react-native";
import badger from "./assets/badger.png";
import parrot from "./assets/parrot.png";

/** The real app icons (the desktop installers' artwork, 192 px), shown on the same-device sign-in screens (ACCT-PAIR-07). */
export const SIBLING_APP_ICONS: Record<"badger" | "parrot", ImageSourcePropType> = { badger, parrot };

/** Product names are never translated. */
export const SIBLING_APP_NAMES: Record<"badger" | "parrot", string> = { badger: "Badger", parrot: "Parrot" };
