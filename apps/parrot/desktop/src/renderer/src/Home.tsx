import { homeAlbumDetail, type HistoryAlbum, type ListeningHistory } from "@space/parrot-core";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { ParrotCardControls } from "@space/ui/parrot/card-actions";
import { ParrotAlbumTile } from "@space/ui/parrot/library";
import { ParrotHome } from "@space/ui/parrot/screens";
import { EmptyLibrary } from "@space/ui";
import mascotUrl from "@space/parrot-core/mascot.webp";
import type { LibraryContent } from "@space/shared/libraryContent";
import type { ParrotDesktopAlbum, ParrotDesktopArtist, ParrotLanguage } from "../../shared/ipc";
import { countText, type Translate } from "./i18n";
import { LibraryLoading } from "./LoadingMascot";

type HomeProps = {
  t: Translate;
  language: ParrotLanguage;
  albums: ParrotDesktopAlbum[];
  artists: ParrotDesktopArtist[];
  /** What the library holds (UX-WAIT-04): its songs, nothing yet known (the loading screen), or nothing (the empty library). */
  content: LibraryContent;
  tracks: ParrotLibraryTrack[];
  history: ListeningHistory;
  playingTrack: ParrotLibraryTrack | undefined;
  playing: boolean;
  /** Where the playing song stands, so the card's Resume names the live place (PAR-HOME-01). */
  positionMs: number;
  /** Pauses or continues the playing song: the card's Pause and Resume while its album is queued. */
  onToggle: () => void;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string) => void;
  /** Plays the album: from the history's song and position when there is one, else from its first song. */
  onPlayAlbum: (albumId: string, entry: HistoryAlbum | null, shuffle: boolean) => void;
  onSeeAll: (view: "albums" | "artists") => void;
  /** Each card's Play and "..." menu (PAR-CARD-01). */
  albumControls?: (album: ParrotDesktopAlbum) => ParrotCardControls;
  artistControls?: (artist: ParrotDesktopArtist) => ParrotCardControls;
  /** PAR-UP-07: an import is still adding songs to the album, or still fetching the artist's photo. */
  albumImporting?: (album: ParrotDesktopAlbum) => boolean;
  /** PAR-META-20: the album's cover is still on its way (the import or the automatic cover pass): it shimmers. */
  albumCoverFetching?: (albumId: string) => boolean;
  artistFetching?: (artist: ParrotDesktopArtist) => boolean;
  /** The empty library's buttons (PAR-EMPTY-01): the add-music dialog, and the system folder picker. */
  onAddMusic: () => void;
  onAddFolder: () => void;
};

/** The empty library (PAR-EMPTY-01) on Home and on the library page: the parrot, the two add buttons and three steps. */
export function EmptyMusicLibrary({ t, onAddMusic, onAddFolder }: { t: Translate; onAddMusic: () => void; onAddFolder: () => void }) {
  return (
    <EmptyLibrary
      kind="music"
      mascotSrc={mascotUrl}
      mascotAlt=""
      eyebrow={t("empty.eyebrow")}
      title={t("empty.title")}
      subtitle={t("empty.subtitle")}
      primary={{ label: t("empty.addMusic"), onClick: onAddMusic, testId: "empty-library-add-music" }}
      secondary={{ label: t("empty.addFolder"), onClick: onAddFolder, testId: "empty-library-add-folder" }}
      steps={[
        { title: t("empty.step1Title"), body: t("empty.step1Body") },
        { title: t("empty.step2Title"), body: t("empty.step2Body") },
        { title: t("empty.step3Title"), body: t("empty.step3Body") },
      ]}
    />
  );
}

/** Home (PAR-HOME-01, PAR-HOME-02), drawn by the shared `ParrotHome` with this computer's history and covers. */
export default function Home({
  t,
  language,
  albums,
  artists,
  content,
  tracks,
  history,
  playingTrack,
  playing,
  positionMs,
  onToggle,
  onOpenAlbum,
  onOpenArtist,
  onPlayAlbum,
  onSeeAll,
  albumControls,
  artistControls,
  albumImporting,
  albumCoverFetching,
  artistFetching,
  onAddMusic,
  onAddFolder,
}: HomeProps) {
  if (content === "loading") return <LibraryLoading label={t("library.loading")} />;
  if (content === "empty") return <EmptyMusicLibrary t={t} onAddMusic={onAddMusic} onAddFolder={onAddFolder} />;
  return (
    <ParrotHome
      history={history}
      albums={albums}
      artists={artists}
      tracks={tracks}
      now={playingTrack ? { albumId: playingTrack.albumId, trackId: playingTrack.id, positionMs, playing } : null}
      onToggle={onToggle}
      labels={{
        jumpBackIn: t("home.jumpBackIn"),
        startListening: t("home.startListening"),
        resume: (time) => t("home.resume", { time }),
        play: t("player.play"),
        pause: t("player.pause"),
        shuffle: t("home.shuffle"),
        recentlyPlayed: t("home.recentlyPlayed"),
        albums: t("library.albums"),
        yourArtists: t("home.yourArtists"),
        seeAll: t("home.seeAll"),
        unknownArtist: t("library.unknownArtist"),
      }}
      albumDetail={(album) => homeAlbumDetail(album, t("library.unknownArtist"), countText(language, t, "song", album.trackCount))}
      useJumpCover={(album) => (album ? (album.coverUrl ?? (albumCoverFetching?.(album.id) ? undefined : null)) : null)}
      albumTile={(album) => {
        const here = playingTrack?.albumId === album.id;
        return (
          <ParrotAlbumTile
            key={album.id}
            album={album}
            src={album.coverThumbUrl}
            unknownArtist={t("library.unknownArtist")}
            playing={here}
            animated={here && playing}
            onOpen={() => onOpenAlbum(album.id)}
            onOpenArtist={album.artistId ? () => onOpenArtist(album.artistId) : undefined}
            controls={albumControls?.(album)}
            importing={albumImporting?.(album) ? t("addMusic.importingAlbum") : null}
            fetching={Boolean(albumCoverFetching?.(album.id))}
            testId="home-album"
          />
        );
      }}
      onOpenAlbum={onOpenAlbum}
      onOpenArtist={onOpenArtist}
      onPlayAlbum={onPlayAlbum}
      artistSrc={(artist) => artist.pictureThumbUrl}
      artistFetching={artistFetching}
      artistControls={artistControls}
      onSeeAll={onSeeAll}
    />
  );
}
