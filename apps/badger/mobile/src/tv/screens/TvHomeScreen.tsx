import React, { memo, useCallback, useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaRow } from "@space/shared/libraryTypes";
import { homeRailEntries, selectHomeRails, type HomeRailEntry } from "../../lib/homeRails";
import { getLastPlayedEpisodeId } from "../../lib/resume";
import { useFavoriteIds } from "../../lib/useFavoriteIds";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../../store/library";
import { TvContinueHero, type TvHeroAction } from "../components/TvContinueHero";
import { TvEmptyLibrary } from "../components/TvEmptyLibrary";
import { TvRail } from "../components/TvRail";
import { continuePlayerParams } from "../lib/continueStart";
import { TV_SAFE_MARGIN_Y, TV_SCREEN_X, tvHomeCardWidth } from "../lib/layout";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TV_COLOR } from "../ui/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * The one row under the Continue watching card (UX-TV-05, Chris 2026-11-12 (chat)): "Recently added", or nothing when
 * the library is empty. The other phone rows (movies, TV shows, favorites) live in Library on TV.
 */
export const homeRows = (rails: readonly HomeRailEntry[]): HomeRailEntry[] =>
  rails.filter((rail) => rail.id === "recent" && rail.items.length > 0);

/**
 * TV Home (UX-TV-05): the Continue watching card (Resume takes the focus), then one "Recently added" row of posters on
 * the sky. Without a title in progress, the first poster takes the focus (UX-TV-01). An empty library shows the
 * freestanding Badger and "Check again" (UX-TV-18).
 */
export const TvHomeScreen = memo(() => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const { loading, error, loadStatus, reload } = useLibraryStatus();
  const { getMediaDetails } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const favoriteIds = useFavoriteIds();
  const skyScroll = useSkyScroll();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const cardWidth = tvHomeCardWidth(scale);

  const openMedia = useCallback((mediaId: string) => navigation.navigate("MediaDetails", { mediaId }), [navigation]);

  const homeRails = useMemo(() => selectHomeRails(media, favoriteIds), [favoriteIds, media]);
  const hero = homeRails.continueWatching[0] ?? null;
  const rails = useMemo(() => homeRows(homeRailEntries(homeRails)), [homeRails]);

  const onHeroAction = useCallback(
    (action: TvHeroAction, item: MediaRow) => {
      if (action === "details") {
        openMedia(item.id);
        return;
      }
      void continuePlayerParams(item, action, getMediaDetails, getLastPlayedEpisodeId)
        .then((params) => navigation.navigate("Player", params))
        .catch((err: unknown) => {
          console.warn("tv.home.hero.failed", JSON.stringify({ mediaId: item.id, error: String(err) }));
          openMedia(item.id);
        });
    },
    [getMediaDetails, navigation, openMedia],
  );

  useEffect(() => {
    console.info(
      "tv.home.rails",
      JSON.stringify({
        media: media.length,
        cardWidth,
        scale,
        hero: hero?.id ?? null,
        rails: rails.map((rail) => `${rail.id}:${rail.items.length}`),
      }),
    );
  }, [cardWidth, hero, media.length, rails, scale]);

  if (media.length === 0) {
    return <View style={styles.empty}>{loading ? null : <TvEmptyLibrary onCheckAgain={reload} />}</View>;
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} {...skyScroll}>
      {/* Offline is the top bar's notice alone (UX-TV-14): no second line that pushes the card down. */}
      {error && loadStatus.kind !== "offline" ? <Text style={styles.error}>{error}</Text> : null}
      {hero ? <TvContinueHero item={hero} onAction={onHeroAction} /> : null}
      {rails.map((rail, railIndex) => (
        <View key={rail.id} style={styles.row}>
          <TvRail
            title={t(rail.titleKey)}
            titleTestID={`tv-rail-title-${rail.id}`}
            items={rail.items}
            cardWidth={cardWidth}
            onOpenMedia={openMedia}
            // The watched check and the bar inside started posters (UX-TV-11).
            showProgress
            preferredFocusIndex={!hero && railIndex === 0 ? 0 : null}
          />
        </View>
      ))}
    </ScrollView>
  );
});
TvHomeScreen.displayName = "TvHomeScreen";

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: TV_SAFE_MARGIN_Y },
  // Mockup `.rows`: 48 px between the card and the row's heading.
  row: { paddingTop: 24 },
  error: { paddingHorizontal: TV_SCREEN_X, paddingTop: 12, fontSize: 14, color: TV_COLOR.danger },
  empty: { flex: 1, justifyContent: "center" },
});
