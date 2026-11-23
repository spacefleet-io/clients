import React, { memo, useCallback, useMemo } from "react";
import { Dimensions, Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Download } from "lucide-react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { MobileEmptyLibrary, MobileEmptyLibraryAction, useSkyScroll } from "@space/mobile-shell/components";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../store/library";
import { getLastPlayedEpisodeId } from "../lib/resume";
import { continuePlayerParams } from "../tv/lib/continueStart";
import { RootStackParamList } from "../navigation/AppNavigator";
import { PosterRail } from "../components/PosterRail";
import { Panel } from "../components/Panel";
import { PosterRailSkeleton } from "../components/Skeleton";
import { ContinueHero } from "../components/ContinueHero";
import { homeRailEntries, selectHomeRails, type HomeRailId } from "../lib/homeRails";
import { phoneHomeLayout, seeAllTarget, type SeeAllTarget } from "../lib/phoneHome";
import { websiteUrl } from "@space/shared/websiteLinks";
import { useFavoriteIds } from "../lib/useFavoriteIds";
import { usePullRefreshScroll, usePullToRefresh } from "../lib/usePullToRefresh";
import { theme } from "../theme/theme";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const MASCOT = require("../assets/mascot.webp");
const RAIL_CARD_WIDTH = Math.round(Dimensions.get("window").width * 0.34);

type HomeScreenProps = {
  /** A row's "See all": opens the Library tab on that row's scope, or the Playlists tab for Favorites. */
  onSeeAll?: (target: SeeAllTarget) => void;
};

/**
 * Home tab (UX-PHONE-01): no page title (the tab bar names the page), the latest started title as a hero card, then
 * rows of posters (recently added, movies, TV shows, favorites) with "See all". Empty: the computer's empty library on
 * the phone (UX-EMPTY-01, UX-PHONE-03), whose one button opens the download page of Badger for computer.
 */
export const HomeScreen = memo(({ onSeeAll }: HomeScreenProps) => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const { loading, error, refresh } = useLibraryStatus();
  const navigation = useNavigation<Nav>();
  const { getMediaDetails } = useLibraryActions();
  const favoriteIds = useFavoriteIds();
  const pull = usePullToRefresh(refresh);
  const skyScroll = usePullRefreshScroll(pull, useSkyScroll());

  const openMedia = useCallback(
    (mediaId: string) => navigation.navigate("MediaDetails", { mediaId }),
    [navigation],
  );

  const { hero, rails } = useMemo(() => phoneHomeLayout(homeRailEntries(selectHomeRails(media, favoriteIds))), [favoriteIds, media]);

  // Resume plays at once: a film, or the episode of a show its title page's Play would (the one the hero names), at
  // the saved position, as on the TV (UX-TV-05).
  const resume = useCallback(
    (item: MediaRow) => {
      void continuePlayerParams(item, "resume", getMediaDetails, getLastPlayedEpisodeId)
        .then((params) => navigation.navigate("Player", params))
        .catch(() => openMedia(item.id));
    },
    [getMediaDetails, navigation, openMedia],
  );
  const seeAll = useCallback((railId: HomeRailId) => onSeeAll?.(seeAllTarget(railId)), [onSeeAll]);

  const refreshControl = (
    <RefreshControl
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surface}
    />
  );

  if (media.length === 0 && loading) {
    return (
      <View style={styles.skeletonWrap}>
        <Panel>
          <PosterRailSkeleton cardWidth={RAIL_CARD_WIDTH} />
        </Panel>
        <Panel>
          <PosterRailSkeleton cardWidth={RAIL_CARD_WIDTH} />
        </Panel>
      </View>
    );
  }

  if (media.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.emptyScroll} refreshControl={refreshControl} {...skyScroll}>
        <MobileEmptyLibrary
          mascotSource={MASCOT}
          eyebrow={t("home.emptyLibrary.eyebrow")}
          title={t("home.emptyLibrary.title")}
          subtitle={t("home.emptyLibrary.subtitle")}
          actions={
            <MobileEmptyLibraryAction
              label={t("home.emptyLibrary.getDesktop")}
              icon={<Download size={16} color={theme.accentTextHex} />}
              onPress={() => void Linking.openURL(websiteUrl("downloads", getCurrentLanguage())).catch(() => undefined)}
            />
          }
          steps={[
            { title: t("home.emptyLibrary.step1Title"), body: t("home.emptyLibrary.step1Body") },
            { title: t("home.emptyLibrary.step2Title"), body: t("home.emptyLibrary.step2Body") },
            { title: t("home.emptyLibrary.step3Title"), body: t("home.emptyLibrary.step3Body") },
          ]}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
      {...skyScroll}
    >
      {hero ? <ContinueHero item={hero} onOpen={openMedia} onResume={resume} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {rails.map((rail) => (
        <PosterRail
          key={rail.id}
          title={t(rail.titleKey)}
          items={rail.items}
          cardWidth={RAIL_CARD_WIDTH}
          onOpenMedia={openMedia}
          showProgress={rail.showProgress}
          seeAll={onSeeAll ? { label: t("home.seeAll"), onPress: () => seeAll(rail.id) } : undefined}
          testID={`home-rail-${rail.id}`}
        />
      ))}
    </ScrollView>
  );
});
HomeScreen.displayName = "HomeScreen";

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingTop: 12, paddingBottom: 24, gap: 24 },
  error: { fontSize: 12, color: theme.colors.danger },
  skeletonWrap: { paddingTop: 48, gap: 24 },
  emptyScroll: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },
});
