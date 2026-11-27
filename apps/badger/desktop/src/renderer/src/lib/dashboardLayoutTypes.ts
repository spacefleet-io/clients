export type SectionType = "continue" | "recent" | "unwatched" | "rewatch" | "favorites" | "playlist" | "genre";
export type LibraryScope = "movies" | "tv";

export type DashboardSectionConfig = {
  id: string;
  type: SectionType;
  playlistId?: string | null;
  genreId?: number | null;
  genreType?: "movie" | "tv" | null;
  libraries: LibraryScope[];
  styleId: number;
};
