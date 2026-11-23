// Parrot's playlist pieces (PAR-PL-02, PAR-PL-04), shared by every Parrot app that shows playlists: the tile, the page
// cover, the heart, the name and delete dialogs, the "Add to playlist" picker, and `useParrotPlaylistEditor`, which
// wires them to the edits of @space/parrot-core. They take translated text and callbacks only; saving the edits is
// the app's job.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Heart, ListMusic, ListPlus, Pencil, Plus, Trash2, X } from "lucide-react";
import { areAllLiked, isLikedPlaylist, newPlaylistEdit, toggleLikeAllEdits, toggleLikeEdit, type ParrotPlaylist, type ParrotPlaylistEdit } from "@space/parrot-core";
import { Button } from "../button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { Input } from "../input";
import { cn } from "../utils";
import { ParrotCardOverlay, type ParrotCardControls } from "./card-actions";
import { ParrotCover } from "./components";
import { UNAVAILABLE_CLASS } from "../unavailable";

/** Liked songs' picture: the green heart, as in the design's filled heart (PAR-PL-04). */
function LikedArt({ className, rounded = "rounded-[calc(var(--radius)-2px)]" }: { className?: string; rounded?: string }) {
  return (
    <div
      className={cn("relative grid aspect-square place-items-center overflow-hidden", rounded, className)}
      style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.45) 55%, #1b1f3b 100%)" }}
      aria-hidden
    >
      <Heart className="h-1/3 w-1/3 fill-current text-primary-foreground drop-shadow" />
    </div>
  );
}

/** A playlist's picture: its own drawn cover with the playlist mark, or the heart for Liked songs. */
export function ParrotPlaylistArt({ id, liked, className, mark = true }: { id: string; liked: boolean; className?: string; mark?: boolean }) {
  if (liked) return <LikedArt className={className} />;
  return (
    <div className={cn("relative", className)}>
      <ParrotCover seed={id} className="w-full" />
      {mark && (
        <span className="absolute bottom-2 right-2 grid size-8 place-items-center rounded-full bg-background/80 text-primary" aria-hidden>
          <ListMusic className="size-4" />
        </span>
      )}
    </div>
  );
}

/** One playlist in the grid: its picture, its name, then its song count. */
export function ParrotPlaylistTile({
  id,
  name,
  detail,
  liked,
  onOpen,
  controls,
  unavailable = false,
  testId = "playlist-tile",
}: {
  id: string;
  name: string;
  detail: string;
  liked: boolean;
  onOpen: () => void;
  /** Play in the middle of the picture on hover or focus, and the "..." menu (PAR-CARD-01). */
  controls?: ParrotCardControls;
  /** Offline with no song kept here: greyed out, does not open, no card controls (PAR-OFFL-04). */
  unavailable?: boolean;
  testId?: string;
}) {
  return (
    <li className="group relative">
      <button type="button" className={cn("w-full text-left", unavailable && UNAVAILABLE_CLASS)} onClick={onOpen} disabled={unavailable} data-testid={testId} data-liked={liked} data-unavailable={unavailable || undefined}>
        <ParrotPlaylistArt id={id} liked={liked} className="w-full transition-transform duration-200 group-hover:-translate-y-0.5" />
        <p className="mt-2.5 truncate text-sm font-semibold">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </button>
      {controls && !unavailable && <ParrotCardOverlay controls={controls} testId={testId} />}
    </li>
  );
}

/** The "New playlist" tile at the end of the grid. */
export function ParrotNewPlaylistTile({ label, onClick, testId = "playlist-new" }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <li>
      <button type="button" className="group w-full text-left" onClick={onClick} data-testid={testId}>
        <div className="grid aspect-square w-full place-items-center rounded-[calc(var(--radius)-2px)] border-2 border-dashed border-border text-muted-foreground transition group-hover:border-primary group-hover:text-primary">
          <Plus className="size-10" aria-hidden />
        </div>
        <p className="mt-2.5 truncate text-sm font-semibold">{label}</p>
      </button>
    </li>
  );
}

/** The heart (PAR-PL-04): outlined, or filled green when the song is in Liked songs. */
export function ParrotHeartButton({ liked, labels, onToggle, size = "md", testId = "like-button" }: { liked: boolean; labels: { like: string; unlike: string }; onToggle: () => void; size?: "sm" | "md"; testId?: string }) {
  const label = liked ? labels.unlike : labels.like;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("shrink-0 rounded-full", size === "sm" ? "size-8" : "size-10", liked ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground")}
      aria-label={label}
      aria-pressed={liked}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      data-testid={testId}
      data-liked={liked}
    >
      <Heart className={cn(size === "sm" ? "size-4" : "size-5", liked && "fill-current")} aria-hidden />
    </Button>
  );
}

type NameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  submitLabel: string;
  cancelLabel: string;
  initial?: string;
  onSubmit: (name: string) => void;
};

/** Asks for a playlist's name, to make one or to rename it. */
export function ParrotPlaylistNameDialog({ open, onOpenChange, title, label, submitLabel, cancelLabel, initial = "", onSubmit }: NameDialogProps) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim());
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={cancelLabel} data-testid="playlist-name-dialog">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={label} placeholder={label} maxLength={100} autoFocus data-testid="playlist-name-input" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={!name.trim()} data-testid="playlist-name-submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Asks before a playlist is deleted. */
export function ParrotConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  testId = "playlist-confirm",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** `{testId}-dialog` on the dialog, `testId` on the confirm button. */
  testId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={cancelLabel} data-testid={`${testId}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid={testId}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type ParrotPlaylistChoice = { id: string; name: string; detail: string; liked: boolean };

/** "Add to playlist": every playlist (Liked songs first) and "New playlist", which makes one with the song in it. */
export function ParrotAddToPlaylistDialog({
  open,
  onOpenChange,
  title,
  newLabel,
  cancelLabel,
  playlists,
  onPick,
  onNew,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  newLabel: string;
  cancelLabel: string;
  playlists: ParrotPlaylistChoice[];
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const row = "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-secondary/60";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={cancelLabel} data-testid="add-to-playlist-dialog">
        <DialogHeader>
          <DialogTitle className="pr-6">{title}</DialogTitle>
        </DialogHeader>
        <ul className="-mx-2 max-h-[60vh] overflow-y-auto">
          <li>
            <button
              type="button"
              className={row}
              onClick={() => {
                onOpenChange(false);
                onNew();
              }}
              data-testid="add-to-playlist-new"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-md border-2 border-dashed border-border text-muted-foreground" aria-hidden>
                <Plus className="size-5" />
              </span>
              <span className="font-semibold">{newLabel}</span>
            </button>
          </li>
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <button
                type="button"
                className={row}
                onClick={() => {
                  onOpenChange(false);
                  onPick(playlist.id);
                }}
                data-testid="add-to-playlist-choice"
                data-playlist-id={playlist.id}
              >
                <ParrotPlaylistArt id={playlist.id} liked={playlist.liked} mark={false} className="size-10 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{playlist.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{playlist.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** The app's translation of the shared `playlists.*` words (`@space/parrot-core/shell-strings`). */
export type ParrotPlaylistText = (key: string, vars?: Record<string, string>) => string;

export type ParrotPlaylistSaveResult = { ok: true } | { ok: false; error: string };

type NameDialog = { mode: "new"; trackIds: string[] } | { mode: "rename"; id: string; name: string };

/** What `useParrotPlaylistEditor` gives the page: the pieces it places where the app's layout wants them. */
export type ParrotPlaylistEditor<Song extends { id: string; title: string }> = {
  /** A playlist's shown name: Liked songs in the app's language. */
  name: (playlist: Pick<ParrotPlaylist, "id" | "name">) => string;
  /** Saves edits; false when the save failed (the tray already says so). */
  save: (edits: ParrotPlaylistEdit[]) => Promise<boolean>;
  heart: (trackId: string, options?: { size?: "sm" | "md"; testId?: string }) => ReactNode;
  /** An album page's heart (PAR-LOOK-05): filled when all its songs are liked; likes them all, or unlikes them all. */
  heartAll: (songs: readonly { id: string }[], options?: { testId?: string }) => ReactNode;
  /** A song row's heart and "Add to playlist", and "Remove" when given. */
  songActions: (remove?: (song: Song, index: number) => void) => (song: Song, index: number) => ReactNode;
  removeSong: (playlist: ParrotPlaylist, trackId: string, position: number) => void;
  /** Rename and delete, for a playlist's page (not for Liked songs). */
  pageActions: (playlist: ParrotPlaylist) => ReactNode;
  newTile: ReactNode;
  addTo: (songs: Song[]) => void;
  dialogs: ReactNode;
};

/**
 * Playlist editing as every Parrot app does it: the heart, "Add to playlist", new, rename, delete and remove, with
 * their dialogs. `save` shows the edits at once and saves them (PAR-PL-03); a failed save lands in the notification
 * tray. Render `dialogs` once in the page.
 */
export function useParrotPlaylistEditor<Song extends { id: string; title: string }>({
  playlists,
  save,
  t,
  detail,
  notify,
  onCreated,
  onDeleted,
}: {
  playlists: readonly ParrotPlaylist[];
  save: (edits: ParrotPlaylistEdit[]) => Promise<ParrotPlaylistSaveResult>;
  t: ParrotPlaylistText;
  /** The line under a playlist's name ("12 songs"). */
  detail: (playlist: ParrotPlaylist) => string;
  /** `titleKey`/`titleVars`: the string `title` was made from, so an app can show it again in another language. */
  notify: (notification: { level: "success" | "error"; title: string; message: string; titleKey?: string; titleVars?: Record<string, string | number> }) => void;
  /** A new playlist made without songs: the app opens it. */
  onCreated?: (id: string) => void;
  /** A playlist was deleted: the app leaves its page. */
  onDeleted?: (id: string) => void;
}): ParrotPlaylistEditor<Song> {
  const [addSongs, setAddSongs] = useState<Song[] | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [deleting, setDeleting] = useState<ParrotPlaylist | null>(null);
  // The heart reads the playlists of the last render, not of the render that drew it.
  const current = useRef(playlists);
  current.current = playlists;
  // #3350 C4: one set for every heart on the page, rather than a scan of Liked songs per song row.
  const likedIds = useMemo(() => new Set(playlists.find((playlist) => isLikedPlaylist(playlist.id))?.trackIds ?? []), [playlists]);

  const name = (playlist: Pick<ParrotPlaylist, "id" | "name">) => (isLikedPlaylist(playlist.id) ? t("playlists.liked") : playlist.name);
  const saveEdits = async (edits: ParrotPlaylistEdit[]) => {
    const result = await save(edits);
    if (!result.ok) notify({ level: "error", title: t("playlists.saveFailed"), message: result.error, titleKey: "playlists.saveFailed" });
    return result.ok;
  };
  const toggleLike = (trackId: string) => void saveEdits([toggleLikeEdit(current.current, trackId)]);
  const heart = (trackId: string, options: { size?: "sm" | "md"; testId?: string } = {}) => (
    <ParrotHeartButton
      size={options.size}
      liked={likedIds.has(trackId)}
      labels={{ like: t("playlists.like"), unlike: t("playlists.unlike") }}
      onToggle={() => toggleLike(trackId)}
      testId={options.testId}
    />
  );
  const heartAll = (songs: readonly { id: string }[], options: { testId?: string } = {}) => {
    const ids = songs.map((song) => song.id);
    return (
      <ParrotHeartButton
        liked={areAllLiked(playlists, ids, (trackId) => likedIds.has(trackId))}
        labels={{ like: t("playlists.like"), unlike: t("playlists.unlike") }}
        onToggle={() => {
          const edits = toggleLikeAllEdits(current.current, ids);
          if (edits.length > 0) void saveEdits(edits);
        }}
        testId={options.testId}
      />
    );
  };
  /** The buttons at the end of a song row: the heart and "Add to playlist" (and, in a playlist, remove). */
  const songActions = (remove?: (song: Song, index: number) => void) => (song: Song, index: number) => (
    <>
      {heart(song.id, { size: "sm", testId: "song-like" })}
      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("playlists.addTo")} title={t("playlists.addTo")} onClick={() => setAddSongs([song])} data-testid="song-add-to-playlist">
        <ListPlus className="size-4" aria-hidden />
      </Button>
      {remove && (
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("playlists.remove")} title={t("playlists.remove")} onClick={() => remove(song, index)} data-testid="song-remove">
          <X className="size-4" aria-hidden />
        </Button>
      )}
    </>
  );
  /** Removes the song at `position` of the playlist's own order. */
  const removeSong = (playlist: ParrotPlaylist, trackId: string, position: number) => void saveEdits([{ kind: "remove", id: playlist.id, position, trackId }]);
  /** Rename and delete on a playlist's page; Liked songs has neither. */
  const pageActions = (playlist: ParrotPlaylist): ReactNode =>
    isLikedPlaylist(playlist.id) ? null : (
      <>
        <Button variant="ghost" size="icon" aria-label={t("playlists.rename")} title={t("playlists.rename")} onClick={() => setNameDialog({ mode: "rename", id: playlist.id, name: playlist.name })} data-testid="playlist-rename">
          <Pencil className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("playlists.delete")} title={t("playlists.delete")} onClick={() => setDeleting(playlist)} data-testid="playlist-delete">
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </>
    );
  const newTile = <ParrotNewPlaylistTile label={t("playlists.new")} onClick={() => setNameDialog({ mode: "new", trackIds: [] })} />;

  const dialogs = (
    <>
      <ParrotAddToPlaylistDialog
        open={addSongs !== null}
        onOpenChange={(next) => !next && setAddSongs(null)}
        title={addSongs?.length === 1 ? t("playlists.addSongTo", { title: addSongs[0]!.title }) : t("playlists.addTo")}
        newLabel={t("playlists.new")}
        cancelLabel={t("playlists.cancel")}
        playlists={playlists.map((playlist) => ({ id: playlist.id, name: name(playlist), liked: isLikedPlaylist(playlist.id), detail: detail(playlist) }))}
        onPick={(id) => {
          const songs = addSongs ?? [];
          const target = playlists.find((playlist) => playlist.id === id);
          void saveEdits([{ kind: "add", id, trackIds: songs.map((song) => song.id) }]).then((saved) => {
            if (saved && target) {
              const titleVars = { name: name(target) };
              notify({ level: "success", title: t("playlists.added", titleVars), message: songs.map((song) => song.title).join(", "), titleKey: "playlists.added", titleVars });
            }
          });
        }}
        onNew={() => setNameDialog({ mode: "new", trackIds: (addSongs ?? []).map((song) => song.id) })}
      />
      <ParrotPlaylistNameDialog
        open={nameDialog !== null}
        onOpenChange={(next) => !next && setNameDialog(null)}
        title={nameDialog?.mode === "rename" ? t("playlists.renameTitle") : t("playlists.newTitle")}
        label={t("playlists.name")}
        submitLabel={nameDialog?.mode === "rename" ? t("playlists.save") : t("playlists.create")}
        cancelLabel={t("playlists.cancel")}
        initial={nameDialog?.mode === "rename" ? nameDialog.name : ""}
        onSubmit={(value) => {
          if (!nameDialog) return;
          if (nameDialog.mode === "rename") {
            void saveEdits([{ kind: "rename", id: nameDialog.id, name: value }]);
            return;
          }
          const edit = newPlaylistEdit(value, () => crypto.randomUUID(), nameDialog.trackIds);
          void saveEdits([edit]);
          if (nameDialog.trackIds.length === 0) onCreated?.(edit.id);
        }}
      />
      <ParrotConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t("playlists.deleteTitle", { name: deleting?.name ?? "" })}
        body={t("playlists.deleteBody")}
        confirmLabel={t("playlists.delete")}
        cancelLabel={t("playlists.cancel")}
        onConfirm={() => {
          if (!deleting) return;
          void saveEdits([{ kind: "delete", id: deleting.id }]);
          onDeleted?.(deleting.id);
        }}
      />
    </>
  );

  return { name, save: saveEdits, heart, heartAll, songActions, removeSong, pageActions, newTile, addTo: (songs: Song[]) => setAddSongs(songs), dialogs };
}
