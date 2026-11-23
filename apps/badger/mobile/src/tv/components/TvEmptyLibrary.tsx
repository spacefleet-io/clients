import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Monitor, RefreshCw } from "lucide-react-native";
import { MobileEmptyLibrary } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { QrCode } from "@space/mobile-shell/pairing-qr";
import { websiteUrl } from "@space/shared/websiteLinks";
import { TV_SCREEN_X } from "../lib/layout";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TvPillButton } from "../ui/TvPillButton";
import { TV_COLOR, TV_RADII } from "../ui/tokens";

const MASCOT = require("../../assets/mascot.webp");

/**
 * The TV's empty library (UX-EMPTY-01, UX-TV-18), on Home and Library alike: the computer's screen (the shared
 * `MobileEmptyLibrary` in its TV layout), the Badger standing free beside "Your library", then the three steps.
 * "Get Badger for computer" takes the focus and shows the download page as a QR code in the badger's place, since a TV
 * cannot install the desktop app itself; "Check again" reads the library again.
 */
export const TvEmptyLibrary = ({ onCheckAgain }: { onCheckAgain: () => void }) => {
  const { t, i18n } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const [showDownload, setShowDownload] = useState(false);
  const url = websiteUrl("downloads", i18n.language);

  return (
    <View style={styles.screen} testID="tv-empty-library">
      <MobileEmptyLibrary
        layout="tv"
        scale={scale}
        mascotSource={MASCOT}
        eyebrow={t("tvShell.empty.eyebrow")}
        title={t("tvShell.empty.title")}
        subtitle={t("tvShell.empty.subtitle")}
        aside={
          showDownload ? (
            <View style={styles.side} testID="tv-empty-download">
              <View style={styles.qrFrame}>
                <QrCode payload={url} size={Math.round(136 * scale)} label={t("tvShell.empty.downloadQr")} />
              </View>
              <Text style={styles.url} numberOfLines={1} adjustsFontSizeToFit>
                {url.replace("https://", "")}
              </Text>
            </View>
          ) : undefined
        }
        actions={
          <>
            <TvPillButton
              variant="primary"
              icon={Monitor}
              label={t("tvShell.empty.getDesktop")}
              hasTVPreferredFocus
              onPress={() => {
                console.info("tv.empty.getDesktop", JSON.stringify({ show: !showDownload }));
                setShowDownload((shown) => !shown);
              }}
              accessibilityState={{ expanded: showDownload }}
              testID="tv-empty-get-desktop"
            />
            <TvPillButton
              icon={RefreshCw}
              label={t("tvShell.empty.checkAgain")}
              onPress={() => {
                console.info("tv.empty.checkAgain");
                onCheckAgain();
              }}
              testID="tv-empty-check-again"
            />
          </>
        }
        steps={[
          { title: t("tvShell.empty.step1Title"), body: t("tvShell.empty.step1Body") },
          { title: t("tvShell.empty.step2Title"), body: t("tvShell.empty.step2Body") },
          { title: t("tvShell.empty.step3Title"), body: t("tvShell.empty.step3Body") },
        ]}
      />
    </View>
  );
};

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13); the buttons are the family's pills (`TvPillButton`). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", paddingHorizontal: TV_SCREEN_X },
  side: { alignItems: "center", gap: 8 },
  qrFrame: { borderRadius: TV_RADII.control, overflow: "hidden" },
  url: { fontSize: 11, color: TV_COLOR.muted, maxWidth: 148 },
});
