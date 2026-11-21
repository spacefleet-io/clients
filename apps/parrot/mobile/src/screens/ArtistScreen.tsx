// One artist's page, from the library's Artists view (PAR-LOOK-06). Badger's title page (MediaDetailsScreen,
// UX-PHONE-04) for an artist, so the two apps read as one fleet: the photo edge to edge fading into the sky, with its
// credit line (PAR-META-15), shimmering while it may still come (PAR-META-20) and giving way to the artist's drawn
// picture with their initials when there is none; the ARTIST chip, the name and the counts over the fade; a full-width
// Play, then round Shuffle, Keep on this phone (each album), Play next and More. Two tabs, Albums first: the
// discography timeline, then every song. Delete is only in the More sheet, last, in red, after asking (PAR-LIB-03).
import React, { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDownToLine, ChevronLeft, CircleCheck, Ellipsis, ListStart, Play, Shuffle } from "lucide-react-native";
import { colors, parrotShellTheme, spacing } from "../theme";
import { Discography } from "./artist/Discography";
import { ArtistHero, ArtistTopBar, PhotoCredit, SongRows, useTopBarScroll } from "./artist/pieces";
import { useArtistPage } from "./artist/useArtistPage";
import { PAGE_BACK_ROW, PageBackButton } from "./pageBack";
import type { RootStack } from "./routes";
import { ParrotSky } from "./sky";
import { ErrorText } from "./ui";

/** The page's tabs, in order; the first is open when the page opens. No Overview: it only repeated these two. */
export const ARTIST_TABS = ["albums", "songs"] as const;
type Tab = (typeof ARTIST_TABS)[number];

const HERO = 360;

/** Where the page's top bar and floating back button take over: the hero's own back button has gone, and the name is
 * about to slide under the status bar. */
const BAR_FROM = HERO - 240;

export const ArtistScreen = ({ route, navigation }: NativeStackScreenProps<RootStack, "Artist">) => {
  const { artistId, name } = route.params;
  const page = useArtistPage(artistId, name);
  const { t } = page;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bar = useTopBarScroll(BAR_FROM);
  const [tab, setTab] = useState<Tab>(ARTIST_TABS[0]);
  const scroll = useRef<ScrollViewInstance | null>(null);
  const discographyTop = useRef(0);
  const back = () => navigation.goBack();
  const actions = [
    { id: "shuffle", icon: Shuffle, label: t("shell.card.shuffle"), onPress: page.shuffleAll, on: false },
    {
      id: page.allKept ? "unkeep" : "keep",
      icon: page.allKept ? CircleCheck : ArrowDownToLine,
      label: page.allKept ? t("parrot.kept.remove") : t("parrot.kept.keep"),
      onPress: page.toggleKeep,
      on: page.allKept,
    },
    { id: "play-next", icon: ListStart, label: t("shell.card.playNext"), onPress: page.playNextAll, on: false },
    { id: "more", icon: Ellipsis, label: t("shell.card.more"), onPress: page.openMenu, on: false },
  ];
  return (
    <ParrotSky>
      <ScrollView ref={scroll} onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingBottom: spacing.xl * 2 }} testID="artist-page">
        <View style={{ height: HERO }}>
          <ArtistHero artistId={artistId} name={name} page={page} width={width} height={HERO} />
          <View style={[styles.heroTopRow, { paddingTop: insets.top + spacing.sm }]}>
            <Pressable testID="page-back" style={styles.heroRoundButton} onPress={back} accessibilityRole="button" accessibilityLabel={t("parrot.nav.back")} hitSlop={8}>
              <ChevronLeft size={28} color={colors.text} strokeWidth={2.75} />
            </Pressable>
          </View>
          <View style={styles.heroMetaWrap}>
            <View style={styles.chipRow}>
              <View style={styles.chip}>
                <Text style={styles.chipText}>{t("parrot.artist.label").toUpperCase()}</Text>
              </View>
            </View>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.6}>
              {name}
            </Text>
            <Text style={styles.metaLine} numberOfLines={2}>
              {page.counts}
            </Text>
          </View>
        </View>
        <View style={styles.headBlock}>
          {page.photo?.credit ? <PhotoCredit credit={page.photo.credit} /> : null}
          <Pressable
            testID="artist-play"
            accessibilityRole="button"
            accessibilityLabel={t("shell.card.play")}
            disabled={page.songs.length === 0}
            onPress={page.playAll}
            style={({ pressed }) => [styles.playButton, (pressed || page.songs.length === 0) && { opacity: 0.6 }]}
          >
            <Play size={17} color={colors.accentText} fill={colors.accentText} />
            <Text style={styles.playLabel}>{t("shell.card.play")}</Text>
          </Pressable>
          <View style={styles.actionsGrid}>
            {actions.map((action) => (
              <Pressable
                key={action.id}
                testID={`artist-${action.id}`}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={action.onPress}
                style={({ pressed }) => [styles.actionCell, pressed && { opacity: 0.6 }]}
              >
                <View style={styles.roundAction}>
                  <action.icon size={19} color={action.on ? colors.accent : colors.text} />
                </View>
                <Text style={styles.actionLabel} numberOfLines={3}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {page.error ? <ErrorText>{page.error}</ErrorText> : null}
        </View>
        <View style={styles.segmentWrap}>
          <View style={styles.segmentedControl} accessibilityRole="tablist">
            {ARTIST_TABS.map((id) => (
              <Pressable
                key={id}
                testID={`artist-tab-${id}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === id }}
                onPress={() => setTab(id)}
                style={[styles.segment, tab === id && styles.segmentActive]}
              >
                <Text style={[styles.segmentLabel, tab === id && styles.segmentLabelActive]} numberOfLines={1}>
                  {t(`parrot.library.view.${id}`).toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        {tab === "albums" ? (
          <View onLayout={(event) => (discographyTop.current = event.nativeEvent.layout.y)}>
            <Discography
              page={page}
              onJump={(y) => scroll.current?.scrollTo({ y: discographyTop.current + y - insets.top - PAGE_BACK_ROW, animated: true })}
            />
          </View>
        ) : (
          <View style={styles.songs} testID="artist-songs">
            <SongRows list={page.songs} page={page} />
          </View>
        )}
      </ScrollView>
      {bar.shown ? (
        <>
          <ArtistTopBar name={name} />
          <PageBackButton onPress={() => navigation.goBack()} />
        </>
      ) : null}
    </ParrotSky>
  );
};

// Badger's MediaDetailsScreen styles, kept as they are there so the two pages match.
const styles = StyleSheet.create({
  heroTopRow: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", paddingHorizontal: 14 },
  heroRoundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.62)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.28)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroMetaWrap: { position: "absolute", left: 20, right: 20, bottom: 0 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6 },
  chip: { height: 22, borderRadius: 6, paddingHorizontal: 8, justifyContent: "center", backgroundColor: parrotShellTheme.colors.accentSoft },
  chipText: { color: colors.accent, fontSize: 11.5, fontWeight: "700" },
  title: {
    color: colors.text,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: "800",
    textAlign: "center",
    marginTop: 8,
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  metaLine: { color: colors.textMuted, fontSize: 13.5, textAlign: "center", marginTop: 4 },
  headBlock: { paddingHorizontal: 20, paddingTop: 8, marginBottom: 20, alignItems: "stretch" },
  playButton: {
    height: 50,
    borderRadius: 14,
    marginTop: 16,
    backgroundColor: colors.accent,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  playLabel: { color: colors.accentText, fontSize: 15, fontWeight: "800" },
  actionsGrid: { flexDirection: "row", marginTop: 14 },
  actionCell: { flex: 1, alignItems: "center", gap: 6, paddingHorizontal: 2 },
  roundAction: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" },
  actionLabel: { color: colors.textMuted, fontSize: 11.5, lineHeight: 14, fontWeight: "600", textAlign: "center" },
  segmentWrap: { paddingHorizontal: 16, marginBottom: 22 },
  segmentedControl: { flexDirection: "row", borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)", backgroundColor: colors.surface, padding: 5 },
  segment: { flex: 1, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: "rgba(255,255,255,0.08)" },
  segmentLabel: { color: colors.textMuted, fontSize: 11, letterSpacing: 1.1, fontWeight: "800" },
  segmentLabelActive: { color: colors.text },
  songs: { paddingHorizontal: 16, marginBottom: 22 },
});
