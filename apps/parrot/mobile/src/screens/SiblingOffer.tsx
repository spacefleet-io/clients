// "Continue with your Badger account" (ACCT-PAIR-07): Badger signed in on this phone signs Parrot in, no typing. The
// offer and its run are the shared ones (`@space/mobile-shell/sibling-ui`, Badger's too); the sign-in ends exactly as
// after "Sign in with another device" (`MobilePairSignIn`): same pairing client, same completion, same key step skipped.
import React from "react";
import { completePairing } from "@space/mobile-shell/pairing";
import { MobileSiblingOffer } from "@space/mobile-shell/sibling-ui";
import { useSession } from "../state/session";
import { createParrotCompletionDeps, createParrotPairingClient } from "../setup/pairing";

export const SiblingOffer = ({ onPaired }: { onPaired: () => Promise<void> }) => {
  const { signIn } = useSession();
  return (
    <MobileSiblingOffer
      app="parrot"
      createClient={() => createParrotPairingClient()}
      complete={(approved) =>
        completePairing(
          createParrotCompletionDeps(async (token, user) => {
            // The key is already stored: mark it so the key step is skipped, then sign in.
            await onPaired();
            await signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } });
          }),
          approved
        )
      }
      logTag="parrot.sibling"
    />
  );
};
