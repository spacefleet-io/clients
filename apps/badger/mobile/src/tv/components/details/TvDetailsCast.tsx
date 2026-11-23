import React, { memo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { TvViewInstance } from "../../lib/tvViewInstance";
import type { MediaCastMember } from "@space/shared/libraryTypes";
import { MediaArtwork } from "../../../components/MediaArtwork";
import { initials } from "../../lib/detailsMedia";
import { useTvStyles } from "../../lib/tvScale";
import { TV_COLOR, TV_FONT } from "../../ui";
import { TvFocusable } from "../TvFocusable";

type Props = {
  cast: readonly MediaCastMember[];
  /** Receives the first person, the target of DOWN from the tabs. */
  firstRef: (view: TvViewInstance | null) => void;
};

/**
 * Cast & crew tab (UX-TV-06, mockup `.cast`): one row of cards, each a rounded tile with the person's photo or initials,
 * then the name and the role. The row scrolls sideways as the focus moves along it. The screen passes the director and
 * writers first, their job as role (LIB-CREW-01), then the cast with the character as role.
 */
export const TvDetailsCast = memo(({ cast, firstRef }: Props) => {
  const styles = useTvStyles(baseStyles);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} testID="tv-details-cast">
      {cast.map((member, index) => (
        <Person key={member.id} member={member} viewRef={index === 0 ? firstRef : undefined} />
      ))}
    </ScrollView>
  );
});
TvDetailsCast.displayName = "TvDetailsCast";

const Person = memo(({ member, viewRef }: { member: MediaCastMember; viewRef?: (view: TvViewInstance | null) => void }) => {
  const styles = useTvStyles(baseStyles);
  return (
    <TvFocusable
      ref={viewRef}
      style={styles.person}
      accessibilityLabel={member.role ? `${member.name}, ${member.role}` : member.name}
      testID={`tv-details-person-${member.id}`}
    >
      <View style={styles.tile}>
        {/* Initials while there is no photo, or for good when the library has none. */}
        <MediaArtwork path={member.profilePath} kind="profile" style={styles.faceImage} fallback={<Text style={styles.initials}>{initials(member.name)}</Text>} />
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {member.name}
      </Text>
      {member.role ? (
        <Text style={styles.role} numberOfLines={1}>
          {member.role}
        </Text>
      ) : null}
    </TvFocusable>
  );
});
Person.displayName = "TvDetailsPerson";

/** Sizes in design dp: the mockup's px halved (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  row: { gap: 13, paddingVertical: 6 },
  person: { width: 85, borderRadius: 6 },
  tile: {
    height: 60,
    borderRadius: 6,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: TV_COLOR.secondary,
    borderWidth: 0.5,
    borderColor: TV_COLOR.borderSoft,
  },
  faceImage: { width: "100%", height: "100%" },
  initials: { fontFamily: TV_FONT.display, fontSize: 20, fontWeight: "600", color: "rgba(222, 226, 242, 0.8)" },
  name: { marginTop: 5, fontFamily: TV_FONT.body, fontSize: 9.5, fontWeight: "700", color: TV_COLOR.text },
  role: { fontFamily: TV_FONT.body, fontSize: 8, color: TV_COLOR.muted },
});
