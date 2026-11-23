import type { ClientUiLanguage } from "./i18n";

/**
 * Words of the search palette (UX-SEARCH-01), in the five client languages, kept here once for Badger desktop,
 * the Badger web player, Parrot desktop and the Parrot web player (REL-FAM-02). Shaped as `SearchPaletteLabels`
 * of `@space/ui`.
 */
export type SearchPaletteProduct = "badger" | "parrot";

export type SearchPaletteStrings = {
  title: string;
  placeholder: string;
  empty: string;
  hint: string;
  matchedVia: string;
  kinds: Record<string, string>;
};

type LanguageStrings = {
  title: string;
  empty: string;
  hint: string;
  badger: { placeholder: string; matchedVia: string };
  parrot: { placeholder: string; matchedVia: string };
  kinds: { movie: string; tv: string; artist: string; album: string; song: string };
};

const STRINGS: Record<ClientUiLanguage, LanguageStrings> = {
  en: {
    title: "Search",
    empty: "Nothing matches.",
    hint: "Type to search. ↑ ↓ to move, Enter to open, Esc to close.",
    badger: { placeholder: "Search titles and people", matchedVia: "With" },
    parrot: { placeholder: "Search artists, albums and songs", matchedVia: "By" },
    kinds: { movie: "Movie", tv: "TV show", artist: "Artist", album: "Album", song: "Song" },
  },
  fr: {
    title: "Rechercher",
    empty: "Aucun résultat.",
    hint: "Tapez pour chercher. ↑ ↓ pour vous déplacer, Entrée pour ouvrir, Échap pour fermer.",
    badger: { placeholder: "Chercher des titres et des personnes", matchedVia: "Avec" },
    parrot: { placeholder: "Chercher des artistes, albums et morceaux", matchedVia: "Par" },
    kinds: { movie: "Film", tv: "Série", artist: "Artiste", album: "Album", song: "Morceau" },
  },
  nl: {
    title: "Zoeken",
    empty: "Niets gevonden.",
    hint: "Typ om te zoeken. ↑ ↓ om te bewegen, Enter om te openen, Esc om te sluiten.",
    badger: { placeholder: "Zoek titels en personen", matchedVia: "Met" },
    parrot: { placeholder: "Zoek artiesten, albums en nummers", matchedVia: "Door" },
    kinds: { movie: "Film", tv: "Serie", artist: "Artiest", album: "Album", song: "Nummer" },
  },
  de: {
    title: "Suchen",
    empty: "Nichts gefunden.",
    hint: "Tippen zum Suchen. ↑ ↓ zum Bewegen, Enter zum Öffnen, Esc zum Schließen.",
    badger: { placeholder: "Titel und Personen suchen", matchedVia: "Mit" },
    parrot: { placeholder: "Künstler, Alben und Songs suchen", matchedVia: "Von" },
    kinds: { movie: "Film", tv: "Serie", artist: "Künstler", album: "Album", song: "Song" },
  },
  es: {
    title: "Buscar",
    empty: "No hay resultados.",
    hint: "Escribe para buscar. ↑ ↓ para moverte, Intro para abrir, Esc para cerrar.",
    badger: { placeholder: "Buscar títulos y personas", matchedVia: "Con" },
    parrot: { placeholder: "Buscar artistas, álbumes y canciones", matchedVia: "De" },
    kinds: { movie: "Película", tv: "Serie", artist: "Artista", album: "Álbum", song: "Canción" },
  },
};

/** The palette's words for `product` in `language` (any code outside the five falls back to English). */
export const searchPaletteStrings = (product: SearchPaletteProduct, language: string | undefined): SearchPaletteStrings => {
  const base = (language ?? "en").slice(0, 2).toLowerCase();
  const strings = STRINGS[(base in STRINGS ? base : "en") as ClientUiLanguage];
  return { title: strings.title, empty: strings.empty, hint: strings.hint, ...strings[product], kinds: strings.kinds };
};
