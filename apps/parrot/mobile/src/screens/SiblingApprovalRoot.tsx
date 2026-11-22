// The `SiblingApproval` root (ACCT-PAIR-07): what Parrot's approval activity shows when Badger on this phone asks to
// sign in with Parrot's account. Its own React root (the activity is not MainActivity), so it starts the API identity,
// the language and the saved session itself, then asks the shared question.
import "../config";
import React, { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileSkyLayer } from "@space/mobile-shell/components";
import { MobileShellThemeProvider } from "@space/mobile-shell/theme";
import { SiblingApprovalScreen } from "@space/mobile-shell/sibling-ui";
import { SessionProvider, useSession } from "../state/session";
import { createParrotSiblingDeps } from "../lib/pairingApprove";
import { startI18n } from "../lib/i18n";
import { parrotShellTheme } from "../theme";
import { PARROT_MASCOT } from "../brand";

const SHELL_THEME = { ...parrotShellTheme, mascotSource: PARROT_MASCOT };

const Question = () => {
  const { booting, session, libraryKey } = useSession();
  if (booting) return null;
  return (
    <SiblingApprovalScreen
      self="parrot"
      token={session?.token ?? null}
      email={session?.user.email ?? ""}
      deps={createParrotSiblingDeps(async () => libraryKey)}
    />
  );
};

export const SiblingApprovalRoot = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void startI18n().finally(() => setReady(true));
  }, []);
  if (!ready) return null;
  return (
    <MobileShellThemeProvider value={SHELL_THEME}>
      <SafeAreaProvider>
        <SessionProvider>
          <MobileSkyLayer>
            <Question />
          </MobileSkyLayer>
        </SessionProvider>
      </SafeAreaProvider>
    </MobileShellThemeProvider>
  );
};
