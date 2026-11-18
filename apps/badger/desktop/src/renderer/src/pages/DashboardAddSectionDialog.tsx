import { useTranslation } from "react-i18next";
import { Clock, EyeOff, Heart, ListPlus, PlayCircle, Repeat } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@space/ui";

type GenreOption = {
  key: string;
  id: number;
  name: string;
  Icon: React.ComponentType<{ className?: string }>;
};

type PlaylistOption = {
  id: string;
  name: string;
};

type DashboardAddSectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  matchesQuery: (value: string) => boolean;
  onAddSystemSection: (type: "continue" | "recent" | "unwatched" | "rewatch" | "favorites") => void;
  movieGenreOptions: GenreOption[];
  tvGenreOptions: GenreOption[];
  onAddGenreSection: (genreType: "movie" | "tv", genreId: number) => void;
  playlists: PlaylistOption[];
  onAddPlaylistSection: (playlistId: string) => void;
};

const SYSTEM_SECTION_OPTIONS = [
  { type: "continue", icon: PlayCircle, labelKey: "dashboard.sections.continue" },
  { type: "recent", icon: Clock, labelKey: "dashboard.sections.recent" },
  { type: "unwatched", icon: EyeOff, labelKey: "dashboard.sections.unwatched" },
  { type: "rewatch", icon: Repeat, labelKey: "dashboard.sections.rewatch" },
  { type: "favorites", icon: Heart, labelKey: "dashboard.sections.favorites" },
] as const;

export default function DashboardAddSectionDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  matchesQuery,
  onAddSystemSection,
  movieGenreOptions,
  tvGenreOptions,
  onAddGenreSection,
  playlists,
  onAddPlaylistSection,
}: DashboardAddSectionDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl border border-[#30363d] bg-[#161b22] text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard.edit.pickSection")}</DialogTitle>
          <DialogDescription className="text-[#8b949e]">{t("dashboard.edit.pickSectionSubtitle")}</DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("dashboard.edit.search")}
          className="border-[#30363d] bg-[#0f141b] text-white placeholder:text-[#8b949e]"
        />
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
              {t("dashboard.edit.systemSections")}
            </div>
            <div className="flex flex-wrap gap-2">
              {SYSTEM_SECTION_OPTIONS.filter((option) => matchesQuery(t(option.labelKey))).map((option) => (
                <Button
                  key={option.type}
                  type="button"
                  variant="secondary"
                  className="border border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/70 hover:bg-[#151b23]"
                  onClick={() => onAddSystemSection(option.type)}
                >
                  <option.icon className="mr-2 h-4 w-4" />
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
              {t("dashboard.edit.genreMovies")}
            </div>
            <div className="flex flex-wrap gap-2">
              {movieGenreOptions.filter((genre) => matchesQuery(genre.name)).map((genre) => (
                <Button
                  key={genre.key}
                  type="button"
                  variant="secondary"
                  className="border border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/70 hover:bg-[#151b23]"
                  onClick={() => onAddGenreSection("movie", genre.id)}
                >
                  <genre.Icon className="mr-2 h-4 w-4" />
                  {genre.name}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
              {t("dashboard.edit.genreTv")}
            </div>
            <div className="flex flex-wrap gap-2">
              {tvGenreOptions.filter((genre) => matchesQuery(genre.name)).map((genre) => (
                <Button
                  key={genre.key}
                  type="button"
                  variant="secondary"
                  className="border border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/70 hover:bg-[#151b23]"
                  onClick={() => onAddGenreSection("tv", genre.id)}
                >
                  <genre.Icon className="mr-2 h-4 w-4" />
                  {genre.name}
                </Button>
              ))}
            </div>
          </div>
          {playlists.length ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
                {t("dashboard.edit.playlists")}
              </div>
              <div className="flex flex-wrap gap-2">
                {playlists.filter((playlist) => matchesQuery(playlist.name)).map((playlist) => (
                  <Button
                    key={playlist.id}
                    type="button"
                    variant="secondary"
                    className="border border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/70 hover:bg-[#151b23]"
                    onClick={() => onAddPlaylistSection(playlist.id)}
                  >
                    <ListPlus className="mr-2 h-4 w-4" />
                    {playlist.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
