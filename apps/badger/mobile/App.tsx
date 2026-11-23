import React, { useEffect, useState } from "react";
import { StatusBar, Text, TextInput } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { enableScreens } from "react-native-screens";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { AuthProvider } from "./src/store/auth";
import { LibraryProvider } from "./src/store/library";
import { initApiConfig } from "./src/lib/apiConfig";
import { loadAppSettings } from "./src/lib/appSettings";
import { loadLowRamDevice, useSkyMode } from "./src/lib/skyMode";
import { ensureI18n } from "./src/lib/uiLanguage";
import { LoadingModalProvider } from "./src/components/LoadingModalProvider";
import { MetadataTicketsController } from "./src/components/MetadataTicketsController";
import { MobileSkyLayer, MobileSkyModeProvider } from "@space/mobile-shell/components";
import { MobileShellThemeProvider } from "@space/mobile-shell/theme";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { AccountLanguagePromptHost } from "@space/mobile-shell/account-language-prompt";
import { badgerShellTheme, theme } from "./src/theme/theme";

// The sign-in screen's mascot, floated by the window crash screen too (UX-CRASH-01).
const MASCOT = require("./src/assets/mascot.webp");
// The shell's screens show it too: over the setup card (UX-SETUP-08).
const SHELL_THEME = { ...badgerShellTheme, mascotSource: MASCOT };

enableScreens();

function App() {
  const [i18nReady, setI18nReady] = useState(false);
  const skyMode = useSkyMode();

  useEffect(() => {
    // Every screen reads the saved language through i18next: start rendering only once it is set (no English flash).
    // The "Animated background" setting and the low-RAM flag load with it so the sky never flips after the first frame.
    void Promise.all([ensureI18n(), loadAppSettings(), loadLowRamDevice()]).finally(() => setI18nReady(true));
    void initApiConfig();

    const TextAny = Text as any;
    const TextInputAny = TextInput as any;

    if (!TextAny.defaultProps) {
      TextAny.defaultProps = {};
    }
    if (!TextInputAny.defaultProps) {
      TextInputAny.defaultProps = {};
    }
    TextAny.defaultProps.style = [{ fontFamily: theme.font.family.sans }, TextAny.defaultProps.style];
    TextInputAny.defaultProps.style = [{ fontFamily: theme.font.family.sans }, TextInputAny.defaultProps.style];
  }, []);

  if (!i18nReady) return null;

  return (
    <MobileShellThemeProvider value={SHELL_THEME}>
      {/* The sky mode sits above the window guard, so a weak phone's crash screen keeps the still sky too. */}
      <MobileSkyModeProvider value={skyMode}>
      {/* UX-CRASH-01: the last guard (phone and TV); a crash outside every screen shows the sign-in screen's sky and
          mascot with one "Try again" button, not a blank app. */}
      <MobileRenderBoundary name="window" variant="window" mascotSource={MASCOT}>
        <SafeAreaProvider>
          <StatusBar barStyle="light-content" />
          <AuthProvider>
            <MetadataTicketsController />
            <LibraryProvider>
              <LoadingModalProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                  {/* UX-SKY-04: the desktop's sky behind every screen, the loading and sign-in gates included. */}
                  <MobileSkyLayer>
                    <AppNavigator />
                  </MobileSkyLayer>
                  {/* "Which language do you want?" right after a sign-in or pairing (UX-I18N-07). */}
                  <AccountLanguagePromptHost />
                </GestureHandlerRootView>
              </LoadingModalProvider>
            </LibraryProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </MobileRenderBoundary>
      </MobileSkyModeProvider>
    </MobileShellThemeProvider>
  );
}

export default App;
