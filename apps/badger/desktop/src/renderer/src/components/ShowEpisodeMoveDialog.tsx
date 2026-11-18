import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@space/ui";
import type { ShowEpisodeSlot } from "@/lib/libraryDb";
import type { ShowEpisodeMoveOffer } from "@/lib/showRefresh";

export type ShowEpisodeMoveDialogProps = {
  showTitle: string;
  episode: ShowEpisodeMoveOffer;
  /** The other parts of a merge (LIB-SHOW-04), for the wording; empty otherwise. */
  otherParts: ShowEpisodeSlot[];
  /** Episodes of the show the user can pick by hand: listed by the catalog and without a file. */
  choices: ShowEpisodeSlot[];
  busy: boolean;
  onMove: (targetEpisodeId: string) => void;
  onKeep: () => void;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "S02E10", or "Special 3" for Season 0. */
export const useEpisodePlace = () => {
  const { t } = useTranslation();
  return (slot: Pick<ShowEpisodeSlot, "seasonNumber" | "episodeNumber">) =>
    slot.seasonNumber === 0
      ? t("library.showDelisting.special", { number: slot.episodeNumber })
      : `S${pad(slot.seasonNumber)}E${pad(slot.episodeNumber)}`;
};

/**
 * LIB-SHOW-04: the catalog stopped listing an episode the user has a file for. The
 * dialog says in plain words what a move would do before the user says yes:
 * with one likely new place it names it (Yes / No); otherwise, and for each
 * part of a merged episode, it offers to keep the episode as it is or to pick
 * its episode by hand. It never offers deleting the file. Closing it counts as
 * "No", which is remembered like "Keep".
 */
export default function ShowEpisodeMoveDialog({
  showTitle,
  episode,
  otherParts,
  choices,
  busy,
  onMove,
  onKeep,
}: ShowEpisodeMoveDialogProps) {
  const { t } = useTranslation();
  const place = useEpisodePlace();
  const [picked, setPicked] = useState("");
  const name = (slot: ShowEpisodeSlot) => (slot.title ? `${place(slot)} '${slot.title}'` : place(slot));
  const move = episode.move;

  let description: string;
  if (move.kind === "move") {
    description = t("library.showDelisting.moveSuggested", { show: showTitle, episode: name(episode), target: place(move.target) });
  } else if (move.kind === "merged") {
    description = t("library.showDelisting.moveMerged", {
      show: showTitle,
      parts: [episode, ...otherParts].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber).map(name).join(" + "),
      target: name(move.into),
      episode: name(episode),
    });
  } else {
    description = t("library.showDelisting.moveNone", { show: showTitle, episode: name(episode) });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onKeep();
      }}
    >
      <DialogContent data-testid="show-episode-move-dialog">
        <DialogHeader>
          <DialogTitle>{t("library.showDelisting.moveTitle")}</DialogTitle>
          <DialogDescription data-testid="show-episode-move-description">{description}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("library.showDelisting.moveCarries")}</p>
        {move.kind !== "move" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("library.showDelisting.pickLabel")}</span>
            <select
              data-testid="show-episode-move-pick"
              className="rounded-md border border-input bg-background px-2 py-1"
              value={picked}
              disabled={busy || choices.length === 0}
              onChange={(event) => setPicked(event.target.value)}
            >
              <option value="">{choices.length === 0 ? t("library.showDelisting.pickNone") : t("library.showDelisting.pickPlaceholder")}</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {name(choice)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="outline" data-testid="show-episode-move-keep" disabled={busy} onClick={onKeep}>
            {move.kind === "move" ? t("library.showDelisting.moveNo") : t("library.showDelisting.keepAsIs")}
          </Button>
          {move.kind === "move" ? (
            <Button data-testid="show-episode-move-yes" disabled={busy} onClick={() => onMove(move.target.id)}>
              {busy ? t("library.showDelisting.moving") : t("library.showDelisting.moveYes")}
            </Button>
          ) : (
            <Button data-testid="show-episode-move-picked" disabled={busy || picked === ""} onClick={() => onMove(picked)}>
              {busy ? t("library.showDelisting.moving") : t("library.showDelisting.movePicked")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
