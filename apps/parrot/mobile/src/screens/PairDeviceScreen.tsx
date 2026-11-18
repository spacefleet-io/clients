// Settings → Pair a device, or a scanned pairing link (ACCT-PAIR-06): the shared phone approver with the signed-in
// session, over the sky under the round back button every pushed page floats (UX-SKY-04).
import React, { useMemo } from "react";
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { PairDeviceScreen as SharedPairDeviceScreen } from "@space/mobile-shell/pairing-approve/PairDeviceScreen";
import { createParrotPairingDeps } from "../lib/pairingApprove";
import { useSignedIn } from "../state/session";
import { PageBackButton, usePageTop } from "./pageBack";
import type { RootStack } from "./routes";

export const PairDeviceScreen = ({ navigation, route }: NativeStackScreenProps<RootStack, "PairDevice">) => {
  const { token, libraryKey } = useSignedIn();
  const deps = useMemo(() => createParrotPairingDeps(async () => libraryKey), [libraryKey]);
  const top = usePageTop();
  return (
    <View style={{ flex: 1, paddingTop: top }}>
      <SharedPairDeviceScreen
        // A second link while this screen is open starts over with its code.
        key={route.params?.code ?? "manual"}
        token={token}
        deps={deps}
        framed={false}
        initialCode={route.params?.code}
        onClose={() => navigation.goBack()}
      />
      <PageBackButton onPress={() => navigation.goBack()} />
    </View>
  );
};
