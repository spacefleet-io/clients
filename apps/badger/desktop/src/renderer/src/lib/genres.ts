import type { GenreCategory, Genre } from "@space/shared";
import { GENRES_BY_CATEGORY } from "@space/shared";
import { localizedGenreName } from "@space/shared/genreNames";
import type { LucideIcon } from "lucide-react";
import { genreIcon } from "@space/ui/badger/genre-icons";

export type GenreOption = Genre & {
  category: GenreCategory;
  key: string;
  Icon: LucideIcon;
};

/** Names come from the shared `@space/shared/genreNames`, which the web player uses too. */
export const getGenreOptions = (category?: GenreCategory, language?: string): GenreOption[] => {
  const categories: GenreCategory[] = category ? [category] : ["movie", "tv"];
  return categories.flatMap((entry) =>
    GENRES_BY_CATEGORY[entry].map((genre) => ({
      ...genre,
      name: localizedGenreName(entry, genre.id, language) ?? genre.name,
      category: entry,
      key: `${entry}:${genre.id}`,
      Icon: genreIcon(entry, genre.id),
    }))
  );
};

export const getGenreName = (category: GenreCategory, id: number, language?: string) => localizedGenreName(category, id, language);
