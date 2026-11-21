import React, { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../../../theme/theme";
import type { MediaTracksBlock } from "../../lib/detailsMedia";
import { TV_RADIUS } from "../../lib/tvLook";
import { useTvStyles } from "@space/mobile-shell/tv/tvScale";

type Props = {
  block: MediaTracksBlock | null;
  /** The side panel stacks the three lists; the movie tab puts them side by side. */
  compact?: boolean;
  testID?: string;
};

/**
 * One video's qualities and tracks (UX-TV-07): its original quality with format and size, then the qualities (the original
 * first, marked), the audio and the subtitles. The same block for a movie and for an episode; never "versions".
 */
export const TvMediaTracksBlock = memo(({ block, compact = false, testID }: Props) => {
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  if (!block || !block.original) {
    return (
      <View style={styles.block} testID={testID}>
        <Text style={styles.empty}>{t("tvShell.details.noMedia")}</Text>
      </View>
    );
  }
  const head = [block.original.format, block.original.size].filter(Boolean).join(" · ");
  return (
    <View style={styles.block} testID={testID}>
      <View style={styles.head}>
        <Text style={styles.headQuality}>{block.original.quality}</Text>
        {head ? <Text style={styles.headMeta}>{head}</Text> : null}
      </View>
      <View style={compact ? styles.listsCompact : styles.lists}>
        <TagList
          compact={compact}
          title={t("tvShell.details.qualities")}
          tags={block.qualities.map((chip) => (chip.original ? t("tvShell.details.originalQuality", { quality: chip.label }) : chip.label))}
          none={t("tvShell.details.none")}
        />
        <TagList compact={compact} title={t("tvShell.details.audio")} tags={block.audio} none={t("tvShell.details.none")} />
        <TagList compact={compact} title={t("tvShell.details.subtitles")} tags={block.subtitles} none={t("tvShell.details.none")} />
      </View>
    </View>
  );
});
TvMediaTracksBlock.displayName = "TvMediaTracksBlock";

const TagList = ({ title, tags, none, compact }: { title: string; tags: readonly string[]; none: string; compact: boolean }) => {
  const styles = useTvStyles(baseStyles);
  return (
    <View style={compact ? styles.listCompact : styles.list}>
      <Text style={[styles.listTitle, compact && styles.listTitleCompact]}>{title}</Text>
      <View style={styles.tags}>
        {tags.length > 0 ? (
          tags.map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagLabel}>{tag}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.empty}>{none}</Text>
        )}
      </View>
    </View>
  );
};

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  block: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: TV_RADIUS.picture,
    backgroundColor: "rgba(18, 20, 33, 0.4)",
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.accent,
    gap: 10,
  },
  head: { flexDirection: "row", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  headQuality: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  headMeta: { fontSize: 13, color: theme.colors.textDim },
  lists: { flexDirection: "row", gap: 16 },
  listsCompact: { gap: 8 },
  list: { flex: 1, gap: 6 },
  listCompact: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  listTitle: { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: "800", color: theme.colors.textDim },
  listTitleCompact: { width: 74, paddingTop: 4 },
  tags: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: TV_RADIUS.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(51, 54, 72, 0.4)",
  },
  tagLabel: { fontSize: 12, color: theme.colors.text },
  empty: { fontSize: 13, color: theme.colors.textDim },
});
