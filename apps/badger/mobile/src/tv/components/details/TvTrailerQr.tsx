import React, { useEffect } from "react";
import { BackHandler, Platform, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { QrCode } from "@space/mobile-shell/pairing-qr";
import { theme } from "../../../theme/theme";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { youtubeWatchUrl } from "../../../lib/youtubeWatchUrl";

/**
 * Whether this TV shows a trailer as a QR code (UX-TV-06): Android TV and Fire TV do. Apple TV hands the trailer to the
 * YouTube app instead.
 */
export const trailerShownAsQr = (): boolean => Platform.OS === "android";

type Props = {
  mediaId: string;
  videoKey: string;
  onClose: () => void;
};

/**
 * A title's trailer on Android TV (UX-TV-06, META-TRAILER-01): full screen, "Watch on YouTube" with a QR code of the
 * trailer's YouTube page, for a phone. YouTube's embed loaded from its real page never starts on a TV WebView and ignores
 * the remote, and the TV never fakes a referrer or origin to make it start, so nothing plays on the TV and it opens
 * neither the YouTube app nor a browser. OK or Back closes it and the title page comes back.
 */
export const TvTrailerQr = ({ mediaId, videoKey, onClose }: Props) => {
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  const scale = useTvScale();
  const url = youtubeWatchUrl(videoKey);

  useEffect(() => {
    console.info("tv.details.trailer.open", JSON.stringify({ mediaId, key: videoKey, via: "qr", url }));
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      console.info("tv.details.trailer.back", JSON.stringify({ mediaId, key: videoKey }));
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [mediaId, onClose, url, videoKey]);

  return (
    <View style={styles.layer} testID="tv-details-trailer-qr">
      <View style={styles.panel}>
        <Text style={styles.title}>{t("tvShell.details.trailerOnYouTube")}</Text>
        <View style={styles.qrFrame}>
          <QrCode payload={url} size={Math.round(220 * scale)} label={t("tvShell.details.trailerQrHint")} />
        </View>
        <Text style={styles.hint}>{t("tvShell.details.trailerQrHint")}</Text>
      </View>
      {/* The remote never reaches the page behind: OK lands here and closes, like Back. */}
      <TVFocusGuideView style={StyleSheet.absoluteFill} autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight>
        <TvFocusable
          style={StyleSheet.absoluteFill}
          focusedStyle={styles.closeFocused}
          scale={1}
          hasTVPreferredFocus
          onPress={() => {
            console.info("tv.details.trailer.ok", JSON.stringify({ mediaId, key: videoKey }));
            onClose();
          }}
          testID="tv-details-trailer-close"
          accessibilityLabel={t("tvShell.details.trailerOnYouTube")}
        />
      </TVFocusGuideView>
    </View>
  );
};

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  panel: { alignItems: "center", gap: 16, paddingHorizontal: 48 },
  title: { color: theme.colors.text, fontSize: 28, fontWeight: "700" },
  qrFrame: { padding: 10, borderRadius: 12, backgroundColor: "#ffffff" },
  hint: { color: theme.colors.text, fontSize: 16, textAlign: "center", maxWidth: 420 },
  // The focus target covers the whole screen: no ring, no fill.
  closeFocused: { borderWidth: 0, backgroundColor: "transparent" },
});
