// The `SiblingApproval` root (ACCT-PAIR-07): what Badger's approval activity shows when Parrot on this phone asks to
// sign in with Badger's account. Its own React root (the activity is not MainActivity), so it starts the language, the
// API host and the saved session itself, then asks the shared question.
import React, { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileSkyLayer } from "@space/mobile-shell/components";
import { MobileShellThemeProvider } from "@space/mobile-shell/theme";
import { SiblingApprovalScreen } from "@space/mobile-shell/sibling-ui";
import { AuthProvider, useAuth } from "../store/auth";
import { initApiConfig } from "../lib/apiConfig";
import { ensureI18n } from "../lib/uiLanguage";
import { siblingApproveDeps } from "../lib/pairing/pairingDeps";
import { badgerShellTheme } from "../theme/theme";

const MASCOT = require("../assets/mascot.webp");
const SHELL_THEME = { ...badgerShellTheme, mascotSource: MASCOT };

const Question = () => {
  const { token, user, loading } = useAuth();
  if (loading) return null;
  return <SiblingApprovalScreen self="badger" token={token} email={user?.email ?? ""} deps={siblingApproveDeps} />;
};

export const SiblingApprovalRoot = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.all([ensureI18n(), initApiConfig()]).finally(() => setReady(true));
  }, []);
  if (!ready) return null;
  return (
    <MobileShellThemeProvider value={SHELL_THEME}>
      <SafeAreaProvider>
        <AuthProvider>
          <MobileSkyLayer>
            <Question />
          </MobileSkyLayer>
        </AuthProvider>
      </SafeAreaProvider>
    </MobileShellThemeProvider>
  );
};
