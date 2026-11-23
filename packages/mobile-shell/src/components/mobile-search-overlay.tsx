// The phone's search (UX-PHONE-12): opened by the centre button of the bottom bar, a card in the middle of the screen
// over a dimmed page, like the desktop's search palette (UX-SEARCH-01). The field takes the keyboard at once; results
// come as the user types, from the whole library on the device (the app builds the indexes), with the desktop's fuzzy
// matching (`@space/shared/fuzzySearch`: typos, accents, words in any order), in the app's groups (Badger: TV shows,
// Movies, Episodes; Parrot: Artists, Albums, Songs). A group shows its best few; "N more" opens the rest of it.
import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Search, X } from "lucide-react-native";
import { searchFuzzyGroups, type FuzzyIndex } from "@space/shared/fuzzySearch";
import type { PhoneSearchStrings } from "@space/shared/searchPaletteStrings";
import { useKeyboardInset } from "../keyboard";
import { useMobileShellTheme } from "../theme";

export type MobileSearchGroup<T> = { id: string; index: FuzzyIndex<T> };

/** What a result row says: its title, a second line (year, artist, show and episode number) and its picture. */
export type MobileSearchRow = { key: string; title: string; subtitle?: string; art?: React.ReactNode };

export type MobileSearchOverlayProps<T> = {
  visible: boolean;
  onClose: () => void;
  strings: PhoneSearchStrings;
  /** In the order they show. Empty while the library is still being read (`loading`). */
  groups: readonly MobileSearchGroup<T>[];
  describe: (item: T, groupId: string) => MobileSearchRow;
  /** A result was tapped; the overlay closes itself first. */
  onSelect: (item: T, groupId: string) => void;
  /** The library is still being read: the field works, results come once it is in. */
  loading?: boolean;
};

/** Results a group shows before "N more", and once opened in full. */
export const MOBILE_SEARCH_PER_GROUP = 5;
export const MOBILE_SEARCH_GROUP_OPEN = 50;

/**
 * Opening the card raises the keyboard with the caret in the field (UX-PHONE-12). On Android the Modal is its own
 * window and `onShow` comes a moment before that window has input focus; a keyboard asked for then is refused
 * ("showSoftInput ... is not served") and React Native skips any later `focus()` because the field already counts as
 * focused. So on Android the card asks on show, asks again (blur, then focus) `MOBILE_SEARCH_KEYBOARD_FIRST_RETRY_MS`
 * later, and then every `MOBILE_SEARCH_KEYBOARD_RETRY_MS` (long enough for a keyboard on its way up to report) until
 * the keyboard is up, `MOBILE_SEARCH_KEYBOARD_ASKS` asks at most. iOS asks once: its keyboard reports itself only
 * once it has slid up, so a re-ask there would drop and raise a keyboard already on its way.
 */
export const MOBILE_SEARCH_KEYBOARD_FIRST_RETRY_MS = 100;
export const MOBILE_SEARCH_KEYBOARD_RETRY_MS = 400;
export const MOBILE_SEARCH_KEYBOARD_ASKS = 5;

export const MobileSearchOverlay = <T,>({ visible, onClose, strings, groups, describe, onSelect, loading = false }: MobileSearchOverlayProps<T>) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset(visible);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const input = useRef<TextInputInstance>(null);
  // Typing never waits for the search: React answers the field first and the results follow.
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (visible) return;
    setQuery("");
    setOpened(null);
    setShown(false);
  }, [visible]);

  useEffect(() => {
    if (!shown) return undefined;
    const started = Date.now();
    let asks = 1;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const up = Keyboard.isVisible();
      if (up || asks >= MOBILE_SEARCH_KEYBOARD_ASKS) {
        console.info("search-overlay.keyboard", JSON.stringify({ up, asks, ms: Date.now() - started }));
        return;
      }
      asks += 1;
      input.current?.blur();
      input.current?.focus();
      timer = setTimeout(check, MOBILE_SEARCH_KEYBOARD_RETRY_MS);
    };
    input.current?.focus();
    if (Platform.OS !== "android") return undefined;
    timer = setTimeout(check, MOBILE_SEARCH_KEYBOARD_FIRST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const results = useMemo(() => {
    if (!visible || deferredQuery.trim() === "") return [];
    const started = Date.now();
    const found = searchFuzzyGroups(groups, deferredQuery, (id) => (id === opened ? MOBILE_SEARCH_GROUP_OPEN : MOBILE_SEARCH_PER_GROUP));
    console.info(
      "search-overlay.results",
      JSON.stringify({ length: deferredQuery.length, ms: Date.now() - started, groups: found.map(({ id, total }) => ({ id, total })) }),
    );
    return found;
  }, [deferredQuery, groups, opened, visible]);

  const close = () => {
    console.info("search-overlay.close", JSON.stringify({ length: query.length }));
    onClose();
  };
  const select = (item: T, groupId: string, rank: number) => {
    console.info("search-overlay.select", JSON.stringify({ group: groupId, rank, length: query.length }));
    onClose();
    onSelect(item, groupId);
  };

  const trimmed = query.trim();
  const message = trimmed === "" ? strings.hint : loading && groups.length === 0 ? null : results.length === 0 && deferredQuery === query ? strings.empty : null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={close} onShow={() => setShown(true)}>
      <View style={[styles.layer, { paddingTop: insets.top + 48, paddingBottom: Math.max(keyboard, insets.bottom) + 16 }]}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={strings.close} testID="search-overlay-backdrop" />
        <View
          testID="search-overlay"
          style={[styles.card, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderRadius: theme.radius.lg }]}
        >
          <View style={[styles.field, { borderBottomColor: theme.colors.border }]}>
            <Search size={20} color={theme.colors.textMuted} />
            <TextInput
              ref={input}
              testID="search-overlay-input"
              // No autoFocus: the card focuses the field itself once the Modal is shown (see MOBILE_SEARCH_KEYBOARD_ASKS).
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setOpened(null);
              }}
              placeholder={strings.placeholder}
              placeholderTextColor={theme.colors.textDim}
              accessibilityLabel={strings.placeholder}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={[styles.input, { color: theme.colors.text, fontFamily: theme.font.family.sans }]}
            />
            {query.length > 0 ? (
              <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityRole="button" accessibilityLabel={strings.clear} testID="search-overlay-clear">
                <X size={18} color={theme.colors.textMuted} />
              </Pressable>
            ) : (
              <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={strings.close} testID="search-overlay-close">
                <X size={20} color={theme.colors.textMuted} />
              </Pressable>
            )}
          </View>
          {message !== null ? (
            <Text style={[styles.message, { color: theme.colors.textMuted, fontFamily: theme.font.family.sans }]} testID="search-overlay-message">
              {message}
            </Text>
          ) : null}
          {results.length > 0 ? (
            <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={styles.results} testID="search-overlay-results">
              {results.map((group) => (
                <View key={group.id} testID={`search-group-${group.id}`}>
                  <Text style={[styles.groupTitle, { color: theme.colors.textMuted, fontFamily: theme.font.family.sans }]}>
                    {strings.groups[group.id] ?? group.id}
                  </Text>
                  {group.hits.map((hit, rank) => {
                    const row = describe(hit.item, group.id);
                    return (
                      <Pressable
                        key={row.key}
                        testID={`search-result-${group.id}-${rank}`}
                        accessibilityRole="button"
                        accessibilityLabel={row.subtitle ? `${row.title}, ${row.subtitle}` : row.title}
                        onPress={() => select(hit.item, group.id, rank)}
                        style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surface }]}
                      >
                        {row.art !== undefined ? <View style={styles.art}>{row.art}</View> : null}
                        <View style={styles.rowText}>
                          <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.text, fontFamily: theme.font.family.sans }]}>
                            {row.title}
                          </Text>
                          {row.subtitle ? (
                            <Text numberOfLines={1} style={[styles.rowSubtitle, { color: theme.colors.textMuted, fontFamily: theme.font.family.sans }]}>
                              {row.subtitle}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                  {group.total > group.hits.length ? (
                    <Pressable
                      testID={`search-more-${group.id}`}
                      accessibilityRole="button"
                      onPress={() => setOpened(group.id)}
                      style={styles.more}
                    >
                      <Text style={[styles.moreText, { color: theme.colors.accent, fontFamily: theme.font.family.sans }]}>
                        {strings.more.replace("{{count}}", String(group.total - group.hits.length))}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  layer: {
    flex: 1,
    paddingHorizontal: 16,
    justifyContent: "flex-start",
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(6, 7, 14, 0.72)",
  },
  card: {
    flexShrink: 1,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 16,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    minHeight: 56,
    borderBottomWidth: 1,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 12,
  },
  message: {
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  results: {
    flexGrow: 0,
  },
  groupTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 56,
  },
  art: {
    width: 40,
    height: 40,
    borderRadius: 6,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  more: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: "center",
  },
  moreText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
