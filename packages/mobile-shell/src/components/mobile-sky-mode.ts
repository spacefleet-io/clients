import { createContext, useContext } from "react";

/** UX-SKY-01: the sky flies shooting stars (animated) or shows them frozen (static). The stars themselves never move. */
export type MobileSkyMode = "animated" | "static";

const MobileSkyModeContext = createContext<MobileSkyMode>("animated");

/** The app decides the mode (setting, low-RAM phone); without a provider the sky is animated. */
export const MobileSkyModeProvider = MobileSkyModeContext.Provider;

export const useMobileSkyMode = (): MobileSkyMode => useContext(MobileSkyModeContext);
