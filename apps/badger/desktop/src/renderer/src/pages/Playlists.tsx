import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import TopNav from "@/components/TopNav";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { Button } from "@space/ui";
import { BadgerPlaylistsView } from "@space/ui/badger";
import { Input } from "@space/ui";
import MediaImage from "@/components/MediaImage";
import { mediaDetailPath } from "@/lib/mediaDetailRoute";
import PlayPosterOverlay from "@/components/PlayPosterOverlay";
import { useInlinePlayback, type InlinePlaybackControls } from "@/lib/useInlinePlayback";
import { X } from "lucide-react";

export function PlaylistsManager({ playback }: { playback: InlinePlaybackControls }) {
  const { t } = useTranslation();
  const { media, playlists } = useLibraryData();
  const { listPlaylistItems, createPlaylist, deletePlaylist, removeFromPlaylist } = useLibraryActions();
  // Hover-Play controls are owned by the host page (Library or the standalone
  // Playlists page) and passed in, so a single useInlinePlayback() instance —
  // and a single mpv controller — backs every grid on the page.
  const { handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible } = playback;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const [newName, setNewName] = useState("");
  const [nonce, setNonce] = useState(0);
  const listSentinelRef = useRef<HTMLDivElement | null>(null);
  const [renderCount, setRenderCount] = useState(24);

  const playlistLabel = (name: string, slug: string | null) => {
    if (slug === "favorites") return t("playlists.systemFavorites");
    return name;
  };

  useEffect(() => {
    if (!selectedId && playlists.length > 0) {
      setSelectedId(playlists[0].id);
    }
  }, [playlists, selectedId]);

  const selected = playlists.find((playlist) => playlist.id === selectedId) ?? null;

  const playlistItems = useMemo(() => {
    if (!selected) return [];
    const ids = new Set(listPlaylistItems(selected.id));
    return media.filter((item) => ids.has(item.id));
  }, [listPlaylistItems, media, selected, nonce]);

  useEffect(() => {
    setRenderCount(24);
  }, [selectedId, playlistItems.length]);

  useEffect(() => {
    const target = listSentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRenderCount((prev) => Math.min(prev + 24, playlistItems.length));
      },
      { rootMargin: "300px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [playlistItems.length]);

  const visibleItems = playlistItems.slice(0, renderCount);
  const hasMore = visibleItems.length < playlistItems.length;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    await createPlaylist(name);
    setNewName("");
    setNonce((prev) => prev + 1);
  };

  const handleDelete = async (id: string) => {
    await deletePlaylist(id);
    setNonce((prev) => prev + 1);
    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  const handleRemove = async (mediaId: string) => {
    if (!selected) return;
    await removeFromPlaylist(selected.id, mediaId);
    setNonce((prev) => prev + 1);
  };

  return (
    <BadgerPlaylistsView
      playlists={playlists.map((playlist) => ({
        id: playlist.id,
        label: playlistLabel(playlist.name, playlist.slug),
        note: playlist.isSystem ? t("playlists.system") : null,
        onDelete: playlist.isSystem ? undefined : () => void handleDelete(playlist.id),
      }))}
      selectedId={selected ? selected.id : null}
      onSelect={setSelectedId}
      itemCount={playlistItems.length}
      labels={{
        manageTitle: t("playlists.manageTitle"),
        manageSubtitle: t("playlists.manageSubtitle"),
        empty: t("playlists.empty"),
        delete: t("playlists.delete"),
        selectTitle: t("playlists.selectTitle"),
        selectSubtitle: t("playlists.selectSubtitle"),
        selectPrompt: t("playlists.selectPrompt"),
        noItems: t("playlists.noItems"),
        itemsCount: (count) => t("playlists.itemsCount", { count }),
      }}
      create={
        <div className="flex gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("playlists.newPlaceholder")} />
          <Button type="button" onClick={() => void handleCreate()} disabled={!newName.trim()}>
            {t("playlists.create")}
          </Button>
        </div>
      }
    >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {visibleItems.map((item) => {
                const disabled = !item.hasFiles;
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={[
                      "space-tile group relative rounded-2xl p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ffaa54]/40 cursor-pointer",
                      disabled ? "opacity-60 grayscale" : ""
                    ].join(" ")}
                    onClick={() => navigate(mediaDetailPath(item.id))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(mediaDetailPath(item.id));
                      }
                    }}
                  >
                    <div className="absolute right-2 top-2 z-30 opacity-0 transition group-hover:opacity-100">
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        className="border border-[#30363d] bg-[#1a1416] text-[#ff7b72] hover:bg-[#221517]"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleRemove(item.id);
                        }}
                        title={t("playlists.remove")}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted">
                      <MediaImage
                        path={item.posterPath}
                        alt={item.title}
                        className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                      />
                      {!disabled ? (
                        <PlayPosterOverlay
                          mediaId={item.id}
                          pending={pendingPlayId === item.id && playPending}
                          spinnerVisible={pendingPlayId === item.id && playPending && playSpinnerVisible}
                          onPlay={handlePlayMedia}
                        />
                      ) : null}
                    </div>
                    <div className="mt-3 space-y-1">
                      <div className="font-semibold leading-tight line-clamp-2">{item.title}</div>
                      <div className="text-xs text-[#8b949e]">
                        {item.year ?? "—"}
                        {!item.hasFiles ? ` · ${t("playlists.missing")}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              {hasMore ? <div ref={listSentinelRef} className="h-1" /> : null}
            </div>
    </BadgerPlaylistsView>
  );
}

export default function Playlists() {
  const { handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible, playbackMount } =
    useInlinePlayback();

  return (
    <div className="min-h-screen">
      <TopNav />
      {/* Chris 2026-11-20: no page title or sentence; the top bar's lit Playlists tab says where the user is. */}
      <main className="container py-10 space-y-8">
        <PlaylistsManager
          playback={{ handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible }}
        />
      </main>
      {playbackMount}
    </div>
  );
}
