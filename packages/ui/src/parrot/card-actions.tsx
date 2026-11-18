/**
 * The hover controls of a Parrot card (PAR-CARD-01), shared by the desktop renderer and the web player: the round Play in
 * the middle of the cover (the same {@link PosterPlayOverlay} as Badger's posters) and a "..." menu in the corner with
 * the other ways to play the item. Texts come in already translated; what each action does stays with the app.
 */
import { useState, type ReactNode } from "react";
import { Disc3, ListEnd, ListPlus, ListStart, MicVocal, Pencil, Play, Shuffle } from "lucide-react";
import {
  parrotAlbumPageActions,
  parrotCardActionList,
  type ParrotCardAction,
  type ParrotCardActionId,
  type ParrotCardLinks,
  type ParrotCardPlayer,
  type ParrotCardStringKey,
} from "@space/parrot-core";
import { PosterPlayOverlay } from "../poster-play-overlay";
import { cn } from "../utils";
import { ParrotMenu, type ParrotMenuItem } from "./menu";

export type ParrotCardControls = {
  /** "Play" (button name and tooltip). */
  playLabel: string;
  /** Replaces the queue with the item and starts it. */
  onPlay: () => void;
  /** "More" (the "..." button's name). */
  moreLabel: string;
  /** The "..." menu: the shared `parrotCardActionList` (@space/parrot-core), then any other actions (edit, delete) after a separator. */
  actions: ParrotMenuItem[];
};

/**
 * Drawn over a tile's cover: put it inside the tile's `group relative` box, after the button that opens the item. The
 * veil lets clicks through to that button, and Play and "..." catch them only while they show (pointer over the card,
 * keyboard inside it, or the menu open): a tap or click before they appear opens the item instead of hitting an
 * invisible Play. Both stay visible while the menu is open.
 */
export function ParrotCardOverlay({ controls, rounded = "rounded-[calc(var(--radius)-2px)]", testId }: { controls: ParrotCardControls; rounded?: string; testId: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 aspect-square transition-transform duration-200 group-hover:-translate-y-0.5",
        menuOpen ? "[&_button]:pointer-events-auto" : "group-hover:[&_button]:pointer-events-auto group-focus-within:[&_button]:pointer-events-auto"
      )}
      data-card-controls
      data-menu-open={menuOpen}
    >
      <PosterPlayOverlay label={controls.playLabel} onPlay={controls.onPlay} pinned={menuOpen} rounded={rounded} testId={`${testId}-play`}>
        {controls.actions.length > 0 && (
          <div className="absolute right-1.5 top-1.5">
            <ParrotMenu
              label={controls.moreLabel}
              items={controls.actions}
              align="end"
              onOpenChange={setMenuOpen}
              triggerClassName="h-9 w-9 bg-[#161b22]/90 text-white hover:bg-[#1a212a] hover:text-white"
              testId={`${testId}-more`}
            />
          </div>
        )}
      </PosterPlayOverlay>
    </div>
  );
}

const ICONS: Record<ParrotCardActionId, ReactNode> = {
  play: <Play className="h-4 w-4" />,
  shuffle: <Shuffle className="h-4 w-4" />,
  "play-next": <ListStart className="h-4 w-4" />,
  "add-to-queue": <ListEnd className="h-4 w-4" />,
  "go-to-album": <Disc3 className="h-4 w-4" />,
  "go-to-artist": <MicVocal className="h-4 w-4" />,
  "add-to-playlist": <ListPlus className="h-4 w-4" />,
  edit: <Pencil className="h-4 w-4" />,
};

/** The shared card list (`parrotCardActionList` in @space/parrot-core) as menu items, each with its icon. */
const withIcons = (actions: ParrotCardAction[]): ParrotMenuItem[] => actions.map((action) => ({ ...action, icon: ICONS[action.id] }));

/**
 * The album page's "…" (PAR-LOOK-05, the design's button after the heart): the album card's menu without Play and
 * Shuffle, which the page shows as buttons beside it, so the page and the card list the same actions in the same order.
 */
export function ParrotAlbumMenu({ controls }: { controls: ParrotCardControls }) {
  return <ParrotMenu label={controls.moreLabel} items={parrotAlbumPageActions(controls.actions)} testId="album-menu" />;
}

export type { ParrotCardPlayer, ParrotCardStringKey };

/**
 * A card's controls for an album, an artist or a playlist, the same on every Parrot surface: `songs` gives the item's
 * songs in their order when an action runs, `more` (keep, delete…) comes last in the menu.
 */
export function parrotCardControls<T>(
  t: (key: ParrotCardStringKey) => string,
  songs: () => T[],
  player: ParrotCardPlayer<T>,
  links: ParrotCardLinks<T> = {},
  more: ParrotMenuItem[] = []
): ParrotCardControls {
  return {
    playLabel: t("card.play"),
    onPlay: () => player.play(songs()),
    moreLabel: t("card.more"),
    actions: [...withIcons(parrotCardActionList(t, songs, player, links)), ...more],
  };
}
