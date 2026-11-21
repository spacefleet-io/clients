import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, type TextInputInstance, View, useWindowDimensions } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import type { MediaRow } from "@space/shared/libraryTypes";
import { filterLibraryItems } from "@space/shared/libraryView";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryData } from "../../store/library";
import { theme } from "../../theme/theme";
import { TvPosterCard } from "../components/TvPosterCard";
import { TV_CARD_GAP, TV_PANEL_CONTENT_X, TV_SAFE_MARGIN_Y, tvGridColumns, tvRailCardWidth } from "@space/mobile-shell/tv/layout";
import { TV_RADIUS } from "../lib/tvLook";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const keyExtractor = (item: MediaRow) => item.id;

/**
 * Titles whose name holds the query, matched like every Badger library search (`filterLibraryItems`, REL-FAM-02);
 * an empty query finds nothing.
 */
export const searchTitles = (media: MediaRow[], query: string): MediaRow[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return filterLibraryItems({ items: media, query: needle, selectedGenres: [], selectedActors: [], castLookup: new Map() });
};

/**
 * TV Search (UX-TV-19): one field (the TV's own keyboard opens on it, and it takes the focus) and, under it, the posters
 * of the titles whose name holds what was typed. DOWN goes from the field to the first poster.
 *
 * Opening Search from the top bar moves the focus from the Search tab into the field: `hasTVPreferredFocus` alone
 * leaves it on the tab, which already holds the focus when this screen mounts.
 */
export const TvSearchScreen = memo(() => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const navigation = useNavigation<Nav>();
  const { width } = useWindowDimensions();
  const skyScroll = useSkyScroll();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const columns = tvGridColumns(width, scale);
  const cardWidth = tvRailCardWidth(width, scale);
  const [query, setQuery] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [gridHeight, setGridHeight] = useState(0);
  const inputRef = useRef<TextInputInstance>(null);

  useEffect(() => {
    // After the tab's press settles, so the native focus move is not undone by the tab keeping it.
    const timer = setTimeout(() => {
      console.info("tv.search.focus_field", JSON.stringify({ hasInput: inputRef.current !== null }));
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const results = useMemo(() => searchTitles(media, query), [media, query]);
  const openMedia = useCallback((mediaId: string) => navigation.navigate("MediaDetails", { mediaId }), [navigation]);
  const renderItem = useCallback(
    ({ item }: { item: MediaRow }) => (
      <SkyCover>
        {/* UX-CRASH-01: a poster that throws shows a placeholder in its place; the rest of the list stays. */}
        <MobileRenderBoundary name={`search-result:${item.id}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
          {() => <TvPosterCard item={item} width={cardWidth} onPress={openMedia} showType />}
        </MobileRenderBoundary>
      </SkyCover>
    ),
    [cardWidth, openMedia],
  );

  return (
    <View style={styles.screen}>
      <SkyCover style={styles.fieldSlot}>
        {/* A plain field, not wrapped in a focusable: the wrapper would take the focus and the keyboard would not open
            (UX-TV-16). Its own ring shows the focus. */}
        <TextInput
          ref={inputRef}
          testID="tv-search-input"
          style={[styles.field, inputFocused && styles.fieldFocused]}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            console.info("tv.search.query", JSON.stringify({ length: text.length }));
          }}
          placeholder={t("library.search.placeholder")}
          placeholderTextColor={theme.colors.textDim}
          accessibilityLabel={t("library.search.label")}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          hasTVPreferredFocus
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
      </SkyCover>
      {query.trim().length > 0 && results.length === 0 ? (
        <Text style={styles.empty} testID="tv-search-empty">
          {t("library.empty.noMatches")}
        </Text>
      ) : (
        <View style={styles.grid} testID="tv-search-results" onLayout={(e) => setGridHeight(e.nativeEvent.layout.height)}>
          <FlatList
            key={columns}
            style={{ height: gridHeight }}
            removeClippedSubviews={false}
            {...skyScroll}
            data={results}
            numColumns={columns}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            columnWrapperStyle={columns > 1 ? styles.row : undefined}
            contentContainerStyle={styles.gridContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        </View>
      )}
    </View>
  );
});
TvSearchScreen.displayName = "TvSearchScreen";

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 8, gap: 14 },
  fieldSlot: { marginHorizontal: TV_PANEL_CONTENT_X, maxWidth: 560 },
  field: {
    fontSize: 18,
    color: theme.colors.text,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: TV_RADIUS.button,
    borderWidth: 3,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  // The accent ring every focusable TV control has (UX-A11Y-04).
  fieldFocused: { borderColor: theme.colors.accent },
  empty: { paddingHorizontal: TV_PANEL_CONTENT_X, fontSize: 16, color: theme.colors.textMuted },
  grid: { flex: 1, marginBottom: TV_SAFE_MARGIN_Y },
  gridContent: { paddingHorizontal: TV_PANEL_CONTENT_X, paddingVertical: 8, gap: TV_CARD_GAP },
  row: { gap: TV_CARD_GAP },
});
