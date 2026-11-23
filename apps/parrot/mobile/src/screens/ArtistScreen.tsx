// One artist's albums, from the library's Artists view (PAR-LOOK-01): the same album grid as the Albums view. The bin
// under the name deletes the artist with every song and stored file of theirs, after asking (PAR-LIB-03). An artist
// with a photo shows it over the name, with its credit line under it when it needs one (PAR-META-15). While the photo
// is first read, or the photo pass still has the artist to ask, it shimmers (PAR-META-20): loading never looks like "no photo".
import React, { useEffect, useRef, useState } from "react";
import { artistPicturesWaiting } from "../lib/picturesWaiting";
import { Linking, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Trash2 } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { ParrotPhotoCredit } from "@space/parrot-library-db-definition/ops";
import { useQuery } from "../state/useQuery";
import { useManage } from "../state/manage";
import { useSession } from "../state/session";
import { listArtistAlbums, readArtistPicture } from "../lib/library";
import { AlbumGrid } from "./AlbumGrid";
import { useOfflineReach } from "./kept";
import { ParrotArt } from "./art";
import { Shimmer } from "./shimmer";
import { ErrorText, IconButton, Title } from "./ui";
import { PageBackButton, usePageTop } from "./pageBack";
import type { RootStack } from "./routes";
import { ParrotSky } from "./sky";
import { colors, spacing } from "../theme";

const LICENCE_SLOT = "\u0000";

/** "Photo: author, licence", the licence opening its text when the photo's source names it. */
const PhotoCredit = ({ credit }: { credit: ParrotPhotoCredit }) => {
  const { t } = useTranslation();
  const [before, after = ""] = t("shell.library.photoCredit", { author: credit.author, licence: LICENCE_SLOT }).split(LICENCE_SLOT);
  const licenceUrl = credit.licenceUrl;
  return (
    <Text testID="artist-photo-credit" style={{ color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: spacing.sm }}>
      {before}
      {licenceUrl ? (
        <Text accessibilityRole="link" style={{ textDecorationLine: "underline" }} onPress={() => void Linking.openURL(licenceUrl)}>
          {credit.licence}
        </Text>
      ) : (
        credit.licence
      )}
      {after}
    </Text>
  );
};

export const ArtistScreen = ({ route }: NativeStackScreenProps<RootStack, "Artist">) => {
  const { artistId, name } = route.params;
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => listArtistAlbums(artistId), [artistId, version]);
  const picture = useQuery(() => readArtistPicture(artistId), [artistId, version]);
  const manage = useManage();
  const reach = useOfflineReach();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const top = usePageTop();
  const photo = picture.data ?? null;
  // Only the first read of this artist's photo shimmers; a re-read after a save keeps what was shown.
  const pictureRead = useRef<string | null>(null);
  if (!picture.loading) pictureRead.current = artistId;
  const pictureFirstRead = picture.loading && pictureRead.current !== artistId;
  // The photo pass still has this artist to ask: a shimmer too, never "no photo" before it answered.
  const [passWaiting, setPassWaiting] = useState(artistPicturesWaiting.has(artistId));
  useEffect(() => {
    setPassWaiting(artistPicturesWaiting.has(artistId));
    return artistPicturesWaiting.onChange(() => setPassWaiting(artistPicturesWaiting.has(artistId)));
  }, [artistId]);
  return (
    <ParrotSky>
    <AlbumGrid
      albums={albums.data ?? []}
      loading={albums.loading}
      empty={t("parrot.library.noAlbums")}
      unavailable={reach ? (album) => !reach.album(album.id) : undefined}
      top={top}
      header={
        <>
          {photo ? (
            <View style={{ alignItems: "center", marginBottom: spacing.lg }}>
              <ParrotArt seed={artistId} size={160} radius={80} coverKey={photo.pictureObjectKey} previewKey={photo.pictureThumbObjectKey} />
              {photo.credit ? <PhotoCredit credit={photo.credit} /> : null}
            </View>
          ) : pictureFirstRead || passWaiting ? (
            <View style={{ alignItems: "center", marginBottom: spacing.lg }}>
              <Shimmer testID="artist-photo-shimmer" style={{ width: 160, height: 160, borderRadius: 80 }} />
            </View>
          ) : null}
          <Title>{name}</Title>
          <View style={{ flexDirection: "row" }}>
            <IconButton
              testID="artist-delete"
              icon={Trash2}
              label={t("shell.manage.delete")}
              onPress={() => manage.remove({ kind: "artist", id: artistId }, name, () => navigation.goBack())}
            />
          </View>
          {albums.error ? <ErrorText>{albums.error}</ErrorText> : null}
        </>
      }
    />
    <PageBackButton onPress={() => navigation.goBack()} />
    </ParrotSky>
  );
};
