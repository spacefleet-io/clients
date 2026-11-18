/**
 * The Playlists page (UX-TOP-01), shared by the Badger desktop app and the web player: the list of playlists on the
 * left (with the app's "new playlist" form and Delete when the app can edit them), the selected playlist's titles on
 * the right. The words and the titles' grid are the app's.
 */
import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";

export type BadgerPlaylistEntry = {
  id: string;
  label: string;
  /** A second line under the name (desktop: "System playlist"). */
  note?: string | null;
  /** Shown as a Delete button when the app can delete this playlist. */
  onDelete?: () => void;
};

export type BadgerPlaylistsLabels = {
  manageTitle: string;
  manageSubtitle: string;
  empty: string;
  delete: string;
  selectTitle: string;
  selectSubtitle: string;
  selectPrompt: string;
  noItems: string;
  /** "{n} items" for the selected playlist. */
  itemsCount: (count: number) => string;
};

export function BadgerPlaylistsView({
  playlists,
  selectedId,
  onSelect,
  itemCount,
  labels,
  create,
  children,
  testId = "playlists-view",
}: {
  playlists: BadgerPlaylistEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** How many titles the selected playlist holds; `children` (its grid) shows only when there is one. */
  itemCount: number;
  labels: BadgerPlaylistsLabels;
  /** The app's "new playlist" form, above the list; absent where playlists cannot be made. */
  create?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const selected = playlists.find((playlist) => playlist.id === selectedId) ?? null;
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]" data-testid={testId}>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{labels.manageTitle}</CardTitle>
          <CardDescription>{labels.manageSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {create}
          <div className="grid gap-2">
            {playlists.length === 0 ? (
              <div className="text-sm text-muted-foreground">{labels.empty}</div>
            ) : (
              playlists.map((playlist) => (
                <div
                  key={playlist.id}
                  role="button"
                  tabIndex={0}
                  aria-current={selectedId === playlist.id ? "true" : undefined}
                  data-testid={`playlist-${playlist.id}`}
                  className={[
                    "flex w-full cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-left transition",
                    selectedId === playlist.id ? "border-primary bg-primary/10" : "border-border hover:border-primary/40 hover:bg-muted/30",
                  ].join(" ")}
                  onClick={() => onSelect(playlist.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(playlist.id);
                    }
                  }}
                >
                  <div>
                    <div className="font-semibold">{playlist.label}</div>
                    {playlist.note ? <div className="text-xs text-muted-foreground">{playlist.note}</div> : null}
                  </div>
                  {playlist.onDelete ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        playlist.onDelete?.();
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {labels.delete}
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{selected ? selected.label : labels.selectTitle}</CardTitle>
          <CardDescription>{selected ? labels.itemsCount(itemCount) : labels.selectSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          {!selected ? (
            <div className="text-sm text-muted-foreground">{labels.selectPrompt}</div>
          ) : itemCount === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="playlist-no-items">
              {labels.noItems}
            </div>
          ) : (
            children
          )}
        </CardContent>
      </Card>
    </div>
  );
}
