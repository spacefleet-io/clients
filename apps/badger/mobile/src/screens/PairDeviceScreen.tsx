// Badger's PairDevice route: the shared phone approver (`@space/mobile-shell/pairing-approve/PairDeviceScreen`) with
// Badger's session, its pairing side effects (push device id, ACCT-PAIR-03) and the device-list memory of the new session.
import React from "react";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { PairDeviceScreen as SharedPairDeviceScreen } from "@space/mobile-shell/pairing-approve/PairDeviceScreen";
import { useAuth } from "../store/auth";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { pairingDeps } from "../lib/pairing/pairingDeps";
import { rememberSession } from "../lib/pairing/deviceWatch";

export const PairDeviceScreen = () => {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, "PairDevice">>();
  const { token } = useAuth();
  return (
    <SharedPairDeviceScreen
      token={token}
      deps={pairingDeps}
      initialCode={route.params?.code}
      onApproved={rememberSession}
      onClose={() => navigation.goBack()}
    />
  );
};
