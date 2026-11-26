import React, { memo, useCallback, useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MobileLibraryLoading, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaRow } from "@space/shared/libraryTypes";
import { libraryContent } from "@space/shared/libraryContent";
import { phoneHomeLayout } from "../../lib/phoneHome";
import { getLastPlayedEpisodeId } from "../../lib/resume";
import { useHomeRails } from "../../lib/useHomeRails";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../../store/library";
import { TvContinueHero, type TvHeroAction } from "../components/TvContinueHero";
import { TvEmptyLibrary } from "../components/TvEmptyLibrary";
import { TvRail } from "../components/TvRail";
import { continuePlayerParams } from "../lib/continueStart";
import { TV_SAFE_MARGIN_Y, TV_SCREEN_X, tvHomeCardWidth } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TV_COLOR } from "../ui/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const MASCOT = require("../../assets/mascot.webp");

/**
 * TV Home (UX-TV-05, UX-HOME-06): the Continue watching card (Resume takes the focus), then the rows of the Home layout
 * set on the computer, in its order, on the sky (the same rows as the phone; the card's title is left out of the
 * Continue watching row). Without a title in progress, the first poster takes the focus (UX-TV-01). An empty library
 * shows the freestanding Badger and "Check again" (UX-TV-18), only once it is known to be empty; until then the app's
 * opening screen says "Loading library" (UX-WAIT-04).
 */
export const TvHomeScreen = memo(() => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const { settled, error, loadStatus, reload } = useLibraryStatus();
  const { getMediaDetails } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const homeRails = useHomeRails(media);
  const skyScroll = useSkyScroll();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const cardWidth = tvHomeCardWidth(scale);

  const openMedia = useCallback((mediaId: string) => navigation.navigate("MediaDetails", { mediaId }), [navigation]);

  const { hero, rails } = useMemo(() => phoneHomeLayout(media, homeRails), [homeRails, media]);

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

  const content = libraryContent({ itemCount: media.length, settled });
  if (content === "loading") return <MobileLibraryLoading app="badger" source={MASCOT} label={t("nav.loadingLibrary")} size={180} />;
  if (content === "empty") {
    return (
      <View style={styles.empty}>
        <TvEmptyLibrary onCheckAgain={reload} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} {...skyScroll}>
      {/* Offline is the top bar's notice alone (UX-TV-14): no second line that pushes the card down. */}
      {error && loadStatus.kind !== "offline" ? <Text style={styles.error}>{error}</Text> : null}
      {hero ? <TvContinueHero item={hero} onAction={onHeroAction} /> : null}
      {rails.map((rail, railIndex) => (
        <View key={rail.id} style={styles.row}>
          <TvRail
            title={rail.title}
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
