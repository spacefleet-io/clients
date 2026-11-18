import React, { memo, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Tv } from "lucide-react-native";
import { CastContext } from "react-native-google-cast";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useAuth } from "../store/auth";
import { createAppRelay } from "../lib/playOnTv/appRelay";
import type { PeerListFailure } from "../lib/playOnTv/channel";
import { tvTargets } from "../lib/playOnTv/phoneRemote";
import type { CastDeviceInfo } from "../lib/cast/castPicker";
import type { CastTarget } from "../lib/cast/castFlow";
import { theme } from "../theme/theme";
import { BottomSheet } from "./BottomSheet";
import { CastTargetRows } from "./CastTargetRows";
import type { PickerSheet } from "./usePickerSheet";

export type TvTarget = { peerId: string; name: string };

type Failure = PeerListFailure | { reason: "no_key" };
type Listing = { state: "searching" } | { state: "ready"; tvs: TvTarget[] } | { state: "failed"; failure: Failure };

/** The sentence for a failed search: a relay that could not answer is never shown as "no TV found". */
export const playOnTvFailureKey = (failure: Failure): string =>
  failure.reason === "offline"
    ? "playOnTv.errors.offline"
    : failure.reason === "server"
      ? "playOnTv.errors.server"
      : failure.reason === "no_key"
        ? "playOnTv.errors.noKey"
        : "playOnTv.errors.signedOut";

type Props = {
  sheet: PickerSheet;
  /** Cast devices found on the Wi-Fi (`useDevices()`). */
  devices: readonly CastDeviceInfo[];
  onPick: (tv: TvTarget) => void;
  onCast: (target: CastTarget) => void;
};

/**
 * "Play on TV" picker (UX-TV-02, UX-TV-03): first the Google Cast / AirPlay rows the Play button's picker shows (the same
 * component), then the account's Badger TV apps running right now, by the name given at pairing. The list scrolls in its
 * own sheet (UX-LIST-01). The Badger TV part alone says when none is found (a hint to open the TV app, and a retry) or
 * why the relay failed (no connection, server error with its code), with the same retry.
 */
export const PlayOnTvSheet = memo(({ sheet, devices, onPick, onCast }: Props) => {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [listing, setListing] = useState<Listing>({ state: "searching" });

  const search = useCallback(async () => {
    setListing({ state: "searching" });
    const relay = await createAppRelay("mobile", () => token);
    if (!relay) {
      console.warn("tv.cast.phone.picker", JSON.stringify({ relay: false, failure: "no_key" }));
      setListing({ state: "failed", failure: { reason: "no_key" } });
      return;
    }
    const listed = await relay.transport.listPeers();
    if (!listed.ok) {
      const { ok: _ok, ...failure } = listed;
      console.warn("tv.cast.phone.picker", JSON.stringify({ relay: true, failure }));
      setListing({ state: "failed", failure });
      return;
    }
    const tvs = tvTargets(listed.peers, t("playOnTv.unnamedTv"));
    console.info("tv.cast.phone.picker", JSON.stringify({ relay: true, peers: listed.peers.length, tvs: tvs.length }));
    setListing({ state: "ready", tvs });
  }, [t, token]);

  useEffect(() => {
    if (!sheet.visible) return;
    void search();
    // Same as the Play button (INTG-CAST-01): iOS only discovers Cast devices once asked, and they appear as found.
    void CastContext.getDiscoveryManager().startDiscovery().catch(() => undefined);
  }, [search, sheet.visible]);

  return (
    <BottomSheet sheet={sheet} testID="play-on-tv-picker">
      <Text style={styles.title} accessibilityRole="header">
        {t("playOnTv.pickerTitle")}
      </Text>
      <MobileSheetScrollView contentContainerStyle={styles.list}>
        <CastTargetRows visible={sheet.visible} devices={devices} onTarget={onCast} />
        {listing.state === "searching" ? (
          <View style={styles.status}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.muted}>{t("playOnTv.searching")}</Text>
          </View>
        ) : listing.state === "failed" || listing.tvs.length === 0 ? (
          <View style={styles.status}>
            <Text style={styles.muted} testID={listing.state === "failed" ? "play-on-tv-error" : "play-on-tv-empty"}>
              {listing.state === "failed"
                ? t(playOnTvFailureKey(listing.failure), { status: listing.failure.reason === "server" ? listing.failure.status : "" })
                : t("playOnTv.empty")}
            </Text>
            <Pressable testID="play-on-tv-retry" onPress={() => void search()} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.action}>{t("playOnTv.retry").toUpperCase()}</Text>
            </Pressable>
          </View>
        ) : (
          listing.tvs.map((tv) => (
            <Pressable
              key={tv.peerId}
              style={styles.row}
              onPress={() => sheet.close(() => onPick(tv))}
              accessibilityRole="button"
              accessibilityLabel={tv.name}
            >
              <Tv size={18} color={theme.colors.text} />
              <Text style={styles.rowName} numberOfLines={1}>
                {tv.name}
              </Text>
            </Pressable>
          ))
        )}
      </MobileSheetScrollView>
    </BottomSheet>
  );
});
PlayOnTvSheet.displayName = "PlayOnTvSheet";

const styles = StyleSheet.create({
  title: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display, marginBottom: 12 },
  status: { alignItems: "center", gap: 12, paddingVertical: 16 },
  muted: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  action: { color: theme.colors.accent, fontSize: 12, letterSpacing: 1.1, fontWeight: "800" },
  list: { gap: 8, paddingBottom: 8 },
  row: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  rowName: { color: theme.colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
});
