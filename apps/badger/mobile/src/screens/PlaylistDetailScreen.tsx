import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { MobileEmptyState } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../store/library";
import { RootStackParamList } from "../navigation/AppNavigator";
import { PosterGrid } from "../components/PosterGrid";
import { IconButton } from "../components/IconButton";
import { usePullToRefresh } from "../lib/usePullToRefresh";
import { theme } from "../theme/theme";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const EMPTY_STATE_IMAGE = require("../assets/empty-state.webp");

export const PlaylistDetailScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute();
  const { playlistId, title } = route.params as { playlistId: string; title: string };
  const { media } = useLibraryData();
  const { refresh } = useLibraryStatus();
  const { listPlaylistItems } = useLibraryActions();
  const [itemIds, setItemIds] = useState<ReadonlySet<string> | null>(null);
  const pull = usePullToRefresh(refresh);

  useEffect(() => {
    void listPlaylistItems(playlistId).then((ids) => setItemIds(new Set(ids)));
  }, [listPlaylistItems, playlistId, media]);

  const visible = useMemo(
    () => (itemIds ? media.filter((item) => itemIds.has(item.id)) : []),
    [itemIds, media],
  );
  const openMedia = useCallback(
    (mediaId: string) => navigation.navigate("MediaDetails", { mediaId }),
    [navigation],
  );
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("playlists.detail.back")} onPress={goBack}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header" testID="playlist-detail-title">
          {title}
        </Text>
      </View>
      <View style={styles.grid}>
        <PosterGrid
          items={visible}
          onOpenMedia={openMedia}
          pull={pull}
          loading={itemIds === null}
          containerPadding={32}
          empty={
            <MobileEmptyState
              title={t("playlists.detail.emptyTitle")}
              subtitle={t("playlists.detail.emptySubtitle")}
              imageSource={EMPTY_STATE_IMAGE}
            />
          }
        />
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  grid: { flex: 1, paddingTop: 8 },
});
