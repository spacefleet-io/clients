// UX-NOTICE-04 / UX-NOTICE-12: the phone's bell, in a thin row above every tab page as on Badger's phone, with the
// number of unread entries on it; it opens the history full screen (`MobileNoticeBell`). Parrot's phone has no page of
// its own for devices, payments or storage: every entry's button opens Settings, where the account is, as Parrot desktop
// opens Settings ▸ Account.
import React from "react";
import { StyleSheet, View } from "react-native";
import { MobileNoticeBell } from "@space/mobile-shell/notice-bell";
import { useParrotNoticeHistory } from "../state/notices";

export const ParrotNoticeBell = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const history = useParrotNoticeHistory();
  return (
    <View style={styles.row} testID="parrot-notice-bell-row">
      <MobileNoticeBell
        history={history}
        onOpenTarget={(target) => {
          console.info("notify.history.open", JSON.stringify({ target }));
          onOpenSettings();
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", paddingHorizontal: 8 },
});
