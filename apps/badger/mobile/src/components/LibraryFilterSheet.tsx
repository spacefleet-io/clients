import React, { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { useTranslation } from "@space/mobile-shell/i18n";
import {
  LIBRARY_SORT_KEYS,
  countActiveLibraryFilters,
  type LibraryFilters,
  type LibrarySortDirection,
  type LibraryTabPrefs,
} from "@space/shared/libraryView";
import type { LibraryFiltersAction } from "../lib/libraryScreenState";
import { theme } from "../theme/theme";
import { BottomSheet } from "./BottomSheet";
import { RIPPLE } from "./PosterCard";
import { ChoiceRow, Divider, MultiPickerRow, SettingsGroup, SwitchRow } from "./SettingsRows";
import type { PickerSheet } from "./usePickerSheet";

const DIRECTIONS: readonly LibrarySortDirection[] = ["asc", "desc"];
/** Actors listed before the user types: the most frequent ones. */
const ACTOR_SUGGESTIONS = 12;
/** Cap while searching so the actor sheet never renders hundreds of rows. */
const ACTOR_MATCH_LIMIT = 30;

export type LibraryFilterOption = { value: string; label: string };

type LibraryFilterSheetProps = {
  sheet: PickerSheet;
  prefs: LibraryTabPrefs;
  onChangePrefs: (patch: Partial<LibraryTabPrefs>) => void;
  filters: LibraryFilters;
  dispatch: (action: LibraryFiltersAction) => void;
  genreOptions: readonly LibraryFilterOption[];
  /** Actor names, most titles first; null while the metadata database is still loading. */
  actorNames: readonly string[] | null;
};

/**
 * "Sort & filter" bottom sheet of the media library: sort key + direction and downloaded-only inline; genres and
 * actors (lists that depend on the library) each one row that opens its own scrolling sheet (UX-LIST-01).
 */
export const LibraryFilterSheet = memo(
  ({ sheet, prefs, onChangePrefs, filters, dispatch, genreOptions, actorNames }: LibraryFilterSheetProps) => {
    const { t } = useTranslation();
    const [actorQuery, setActorQuery] = useState("");
    const activeCount = countActiveLibraryFilters(filters);

    const sortOptions = useMemo(
      () => LIBRARY_SORT_KEYS.map((value) => ({ value, label: t(`library.sort.${value}`) })),
      [t],
    );
    const directionOptions = useMemo(
      () => DIRECTIONS.map((value) => ({ value, label: t(`library.sort.${value}`) })),
      [t],
    );

    const actorOptions = useMemo((): LibraryFilterOption[] => {
      const all = (actorNames ?? []).map((name) => ({ value: name.toLowerCase(), label: name }));
      const selected = all.filter((option) => filters.actors.includes(option.value));
      const needle = actorQuery.trim().toLowerCase();
      const rest = all.filter((option) => !filters.actors.includes(option.value));
      const matches = needle
        ? rest.filter((option) => option.value.includes(needle)).slice(0, ACTOR_MATCH_LIMIT)
        : rest.slice(0, ACTOR_SUGGESTIONS);
      return [...selected, ...matches];
    }, [actorNames, actorQuery, filters.actors]);

    const resetLabel = t("library.sheet.reset");
    return (
      <BottomSheet sheet={sheet} testID="library-filter-sheet">
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">
            {t("library.sheet.title")}
          </Text>
          {activeCount > 0 ? (
            <Pressable
              onPress={() => dispatch({ type: "reset" })}
              android_ripple={RIPPLE}
              accessibilityRole="button"
              accessibilityLabel={resetLabel}
              hitSlop={8}
              style={styles.reset}
            >
              <Text style={styles.resetLabel}>{resetLabel}</Text>
            </Pressable>
          ) : null}
        </View>
        <MobileSheetScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <SettingsGroup title={t("library.sheet.sortBy")}>
            <ChoiceRow
              title={t("library.sheet.sortBy")}
              options={sortOptions}
              value={prefs.sortBy}
              onChange={(sortBy) => onChangePrefs({ sortBy })}
            />
            <ChoiceRow
              title={t("library.sheet.order")}
              options={directionOptions}
              value={prefs.sortDirection}
              onChange={(sortDirection) => onChangePrefs({ sortDirection })}
            />
          </SettingsGroup>

          <SettingsGroup>
            {genreOptions.length > 0 ? (
              <>
                <MultiPickerRow
                  title={t("library.sheet.genres")}
                  options={genreOptions}
                  values={filters.genres}
                  onToggle={(key) => dispatch({ type: "toggleGenre", key })}
                  noneLabel={t("library.sheet.allGenres")}
                  testID="library-genres"
                />
                <Divider />
              </>
            ) : null}
            <MultiPickerRow
              title={t("library.sheet.actors")}
              options={actorOptions}
              values={filters.actors}
              onToggle={(name) => dispatch({ type: "toggleActor", name })}
              noneLabel={t("library.sheet.allActors")}
              header={
                <TextInput
                  style={styles.actorSearch}
                  value={actorQuery}
                  onChangeText={setActorQuery}
                  placeholder={t("library.sheet.actorSearch")}
                  placeholderTextColor={theme.colors.textDim}
                  autoCorrect={false}
                  accessibilityLabel={t("library.sheet.actorSearch")}
                />
              }
              emptyText={actorNames === null ? t("library.sheet.actorsLoading") : t("library.sheet.actorsNone")}
              testID="library-actors"
            />
          </SettingsGroup>

          <SettingsGroup>
            <SwitchRow
              title={t("library.sheet.downloadedOnly")}
              description={t("library.sheet.downloadedOnlyHint")}
              value={filters.downloadedOnly}
              onValueChange={(value) => dispatch({ type: "downloadedOnly", value })}
            />
          </SettingsGroup>
        </MobileSheetScrollView>
      </BottomSheet>
    );
  },
);
LibraryFilterSheet.displayName = "LibraryFilterSheet";

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 36 },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: "800", fontFamily: theme.font.family.display },
  reset: { minHeight: 36, paddingHorizontal: 8, justifyContent: "center", borderRadius: 10, overflow: "hidden" },
  resetLabel: { color: theme.colors.accent, fontSize: 13, fontWeight: "700" },
  content: { gap: 12, paddingBottom: 8 },
  actorSearch: {
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 14,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.colors.controlBorder,
  },
});
