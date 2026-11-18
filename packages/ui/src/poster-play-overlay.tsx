import type { ReactNode } from "react";
import { PlayCircle } from "lucide-react";
import { Button } from "./button";
import { cn } from "./utils";

type PosterPlayOverlayProps = {
  /** The button's name and tooltip ("Play"). */
  label: string;
  onPlay: () => void;
  /** Pinned visible whatever the pointer does: the item is launching, or the card's menu is open. */
  pinned?: boolean;
  /** Turns the button into a spinner while a slow launch runs. */
  spinnerVisible?: boolean;
  spinnerLabel?: string;
  /** `rounded-full` for a round picture (an artist). */
  rounded?: string;
  testId?: string;
  /** Extra data attributes the e2e tests key on (Badger's `data-media-id`). */
  mediaId?: string;
  /** More controls drawn over the picture, such as the card's "..." menu in a corner. */
  children?: ReactNode;
};

/**
 * The hover Play affordance over a poster or a cover, shared by Badger and Parrot (REL-FAM-02): a dark veil and a round
 * Play button in the middle, shown when the pointer is over the card or the keyboard is inside it. Render it inside the
 * picture's `relative` box, and give the card the `group` class.
 */
export function PosterPlayOverlay({ label, onPlay, pinned = false, spinnerVisible = false, spinnerLabel, rounded = "rounded-lg", testId = "card-play-overlay", mediaId, children }: PosterPlayOverlayProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex items-center justify-center bg-black/25 transition",
        rounded,
        pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      )}
      data-pinned={pinned}
    >
      <Button
        type="button"
        variant="secondary"
        pending={spinnerVisible}
        spinnerLabel={spinnerLabel}
        className="h-14 w-14 rounded-full border border-primary/70 bg-[#161b22]/95 text-white shadow-lg hover:border-primary hover:bg-[#1a212a]"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPlay();
        }}
        title={label}
        aria-label={label}
        data-testid={testId}
        data-media-id={mediaId}
      >
        <PlayCircle className="h-7 w-7" aria-hidden />
      </Button>
      {children}
    </div>
  );
}
