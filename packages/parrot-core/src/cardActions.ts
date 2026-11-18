// The "..." actions of a Parrot album, artist or playlist card (PAR-CARD-01) and of the album page (PAR-LOOK-05): which
// ones, in which order, and what each asks of the app's player. Shared by every Parrot surface (REL-FAM-02): the
// desktop renderer and the web player draw it with icons in packages/ui, the phone in its own sheet; texts come in
// already translated and what each action does stays with the app.
import type { SHELL_EN } from "./shellStrings";

export type ParrotCardActionId =
  | "play"
  | "shuffle"
  | "play-next"
  | "add-to-queue"
  | "go-to-album"
  | "go-to-artist"
  | "add-to-playlist"
  | "edit";

export type ParrotCardAction = {
  id: ParrotCardActionId;
  label: string;
  onSelect: () => void;
  /** A thin line above this action, to set a group apart. */
  separatorBefore?: boolean;
};

export type ParrotPlayActionLabels = {
  play: string;
  shuffle: string;
  playNext: string;
  addToQueue: string;
  goToAlbum: string;
  goToArtist: string;
  addToPlaylist: string;
  edit: string;
};

export type ParrotPlayActionHandlers = {
  onPlay: () => void;
  /** Clears the queue and plays the item's songs in a random order. */
  onShuffle: () => void;
  /** Puts the item's songs right after the song playing. */
  onPlayNext: () => void;
  /** Puts the item's songs at the end of the queue. */
  onAddToQueue: () => void;
  /** Left out where the card is the album itself. */
  onGoToAlbum?: () => void;
  /** Left out where the card is the artist itself, or the item has no single artist (a playlist). */
  onGoToArtist?: () => void;
  onAddToPlaylist?: () => void;
  /**
   * Edit details (PAR-META-16): only where the app can edit. Lookups run on their own; the edit panel holds the manual
   * "Look it up again" and the lyrics section (PAR-META-18, PAR-LYR-05), so the card has no lookup entry.
   */
  onEdit?: () => void;
};

/**
 * A card's "..." list, in the order every Parrot card uses: Play, Shuffle, Play next, Add to queue, then the go-to and
 * playlist entries, then Edit details where the app offers it.
 */
export function parrotPlayActionList(labels: ParrotPlayActionLabels, handlers: ParrotPlayActionHandlers): ParrotCardAction[] {
  const items: ParrotCardAction[] = [
    { id: "play", label: labels.play, onSelect: handlers.onPlay },
    { id: "shuffle", label: labels.shuffle, onSelect: handlers.onShuffle },
    { id: "play-next", label: labels.playNext, onSelect: handlers.onPlayNext },
    { id: "add-to-queue", label: labels.addToQueue, onSelect: handlers.onAddToQueue },
  ];
  if (handlers.onGoToAlbum) items.push({ id: "go-to-album", label: labels.goToAlbum, onSelect: handlers.onGoToAlbum, separatorBefore: true });
  if (handlers.onGoToArtist) items.push({ id: "go-to-artist", label: labels.goToArtist, onSelect: handlers.onGoToArtist, separatorBefore: !handlers.onGoToAlbum });
  if (handlers.onAddToPlaylist) items.push({ id: "add-to-playlist", label: labels.addToPlaylist, onSelect: handlers.onAddToPlaylist });
  if (handlers.onEdit) items.push({ id: "edit", label: labels.edit, onSelect: handlers.onEdit, separatorBefore: true });
  return items;
}

/** The card texts of the shared shell strings (`card.*`, plus Edit details' `manage.edit`). */
export type ParrotCardStringKey = Extract<keyof typeof SHELL_EN, `card.${string}` | "manage.edit">;

/** What a card asks of the app's player; each app maps these onto its queue (startQueue, shuffleQueue, playNext, addToQueue). */
export type ParrotCardPlayer<T> = {
  play: (songs: T[]) => void;
  shuffle: (songs: T[]) => void;
  playNext: (songs: T[]) => void;
  addToQueue: (songs: T[]) => void;
};

export type ParrotCardLinks<T> = {
  onGoToAlbum?: () => void;
  onGoToArtist?: () => void;
  onAddToPlaylist?: (songs: T[]) => void;
  onEdit?: () => void;
};

/**
 * The "..." list of an album, an artist or a playlist, the same on every Parrot surface: `songs` gives the item's
 * songs in their order when an action runs.
 */
export function parrotCardActionList<T>(t: (key: ParrotCardStringKey) => string, songs: () => T[], player: ParrotCardPlayer<T>, links: ParrotCardLinks<T> = {}): ParrotCardAction[] {
  const onAddToPlaylist = links.onAddToPlaylist;
  return parrotPlayActionList(
    {
      play: t("card.play"),
      shuffle: t("card.shuffle"),
      playNext: t("card.playNext"),
      addToQueue: t("card.addToQueue"),
      goToAlbum: t("card.goToAlbum"),
      goToArtist: t("card.goToArtist"),
      addToPlaylist: t("card.addToPlaylist"),
      edit: t("manage.edit"),
    },
    {
      onPlay: () => player.play(songs()),
      onShuffle: () => player.shuffle(songs()),
      onPlayNext: () => player.playNext(songs()),
      onAddToQueue: () => player.addToQueue(songs()),
      onGoToAlbum: links.onGoToAlbum,
      onGoToArtist: links.onGoToArtist,
      onAddToPlaylist: onAddToPlaylist && (() => onAddToPlaylist(songs())),
      onEdit: links.onEdit,
    }
  );
}

/**
 * The album page's "…" (PAR-LOOK-05): the album card's list without Play and Shuffle, which the page shows as buttons
 * beside it, so the page and the card list the same actions in the same order.
 */
export const parrotAlbumPageActions = <A extends { id: string }>(actions: readonly A[]): A[] => actions.filter((action) => action.id !== "play" && action.id !== "shuffle");
