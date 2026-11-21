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
  kinds: { movie: string; tv: string; artist: string; album: string; song: string; playlist: string };
};

const STRINGS: Record<ClientUiLanguage, LanguageStrings> = {
  en: {
    title: "Search",
    empty: "Nothing matches.",
    hint: "Type to search. ↑ ↓ to move, Enter to open, Esc to close.",
    badger: { placeholder: "Search titles and people", matchedVia: "With" },
    parrot: { placeholder: "Search artists, albums, songs and playlists", matchedVia: "By" },
    kinds: { movie: "Movie", tv: "TV show", artist: "Artist", album: "Album", song: "Song", playlist: "Playlist" },
  },
  fr: {
    title: "Rechercher",
    empty: "Aucun résultat.",
    hint: "Tapez pour chercher. ↑ ↓ pour vous déplacer, Entrée pour ouvrir, Échap pour fermer.",
    badger: { placeholder: "Chercher des titres et des personnes", matchedVia: "Avec" },
    parrot: { placeholder: "Chercher des artistes, albums, morceaux et playlists", matchedVia: "Par" },
    kinds: { movie: "Film", tv: "Série", artist: "Artiste", album: "Album", song: "Morceau", playlist: "Playlist" },
  },
  nl: {
    title: "Zoeken",
    empty: "Niets gevonden.",
    hint: "Typ om te zoeken. ↑ ↓ om te bewegen, Enter om te openen, Esc om te sluiten.",
    badger: { placeholder: "Zoek titels en personen", matchedVia: "Met" },
    parrot: { placeholder: "Zoek artiesten, albums, nummers en afspeellijsten", matchedVia: "Door" },
    kinds: { movie: "Film", tv: "Serie", artist: "Artiest", album: "Album", song: "Nummer", playlist: "Afspeellijst" },
  },
  de: {
    title: "Suchen",
    empty: "Nichts gefunden.",
    hint: "Tippen zum Suchen. ↑ ↓ zum Bewegen, Enter zum Öffnen, Esc zum Schließen.",
    badger: { placeholder: "Titel und Personen suchen", matchedVia: "Mit" },
    parrot: { placeholder: "Künstler, Alben, Songs und Playlists suchen", matchedVia: "Von" },
    kinds: { movie: "Film", tv: "Serie", artist: "Künstler", album: "Album", song: "Song", playlist: "Playlist" },
  },
  es: {
    title: "Buscar",
    empty: "No hay resultados.",
    hint: "Escribe para buscar. ↑ ↓ para moverte, Intro para abrir, Esc para cerrar.",
    badger: { placeholder: "Buscar títulos y personas", matchedVia: "Con" },
    parrot: { placeholder: "Buscar artistas, álbumes, canciones y playlists", matchedVia: "De" },
    kinds: { movie: "Película", tv: "Serie", artist: "Artista", album: "Álbum", song: "Canción", playlist: "Playlist" },
  },
};

const languageOf = (language: string | undefined): ClientUiLanguage => {
  const base = (language ?? "en").slice(0, 2).toLowerCase();
  return (base in STRINGS ? base : "en") as ClientUiLanguage;
};

/** The palette's words for `product` in `language` (any code outside the five falls back to English). */
export const searchPaletteStrings = (product: SearchPaletteProduct, language: string | undefined): SearchPaletteStrings => {
  const strings = STRINGS[languageOf(language)];
  return { title: strings.title, empty: strings.empty, hint: strings.hint, ...strings[product], kinds: strings.kinds };
};

/**
 * Words of the phone's search (UX-PHONE-12): the centre button of the bottom bar and the search it opens, with its
 * result groups. `more` holds `{{count}}`, the matches of a group beyond those it shows. The placeholder names only what
 * is searched (the field already shows a magnifier): the desktop's "Search …" sentence does not fit a phone's field.
 */
export type PhoneSearchStrings = {
  button: string;
  placeholder: string;
  hint: string;
  empty: string;
  close: string;
  clear: string;
  more: string;
  groups: Record<string, string>;
};

type PhoneProductStrings<G extends string> = { placeholder: string; groups: Record<G, string> };
type PhoneLanguageStrings = Omit<PhoneSearchStrings, "button" | "empty" | "placeholder" | "groups"> & {
  badger: PhoneProductStrings<"shows" | "movies" | "episodes">;
  parrot: PhoneProductStrings<"artists" | "albums" | "songs">;
};

const PHONE_STRINGS: Record<ClientUiLanguage, PhoneLanguageStrings> = {
  en: {
    hint: "Results show as you type, from your whole library.",
    close: "Close search",
    clear: "Clear",
    more: "{{count}} more",
    badger: { placeholder: "Shows, movies, episodes", groups: { shows: "TV shows", movies: "Movies", episodes: "Episodes" } },
    parrot: { placeholder: "Artists, albums, songs", groups: { artists: "Artists", albums: "Albums", songs: "Songs" } },
  },
  fr: {
    hint: "Les résultats s'affichent pendant la frappe, dans toute votre bibliothèque.",
    close: "Fermer la recherche",
    clear: "Effacer",
    more: "{{count}} autres",
    badger: { placeholder: "Séries, films, épisodes", groups: { shows: "Séries TV", movies: "Films", episodes: "Épisodes" } },
    parrot: { placeholder: "Artistes, albums, titres", groups: { artists: "Artistes", albums: "Albums", songs: "Titres" } },
  },
  nl: {
    hint: "Resultaten verschijnen terwijl je typt, uit je hele bibliotheek.",
    close: "Zoeken sluiten",
    clear: "Wissen",
    more: "nog {{count}}",
    badger: { placeholder: "Series, films, afleveringen", groups: { shows: "Series", movies: "Films", episodes: "Afleveringen" } },
    parrot: { placeholder: "Artiesten, albums, nummers", groups: { artists: "Artiesten", albums: "Albums", songs: "Nummers" } },
  },
  de: {
    hint: "Ergebnisse erscheinen beim Tippen, aus deiner ganzen Bibliothek.",
    close: "Suche schließen",
    clear: "Löschen",
    more: "{{count}} weitere",
    badger: { placeholder: "Serien, Filme, Folgen", groups: { shows: "Serien", movies: "Filme", episodes: "Folgen" } },
    parrot: { placeholder: "Künstler, Alben, Titel", groups: { artists: "Künstler", albums: "Alben", songs: "Titel" } },
  },
  es: {
    hint: "Los resultados aparecen mientras escribes, de toda tu biblioteca.",
    close: "Cerrar la búsqueda",
    clear: "Borrar",
    more: "{{count}} más",
    badger: { placeholder: "Series, películas, episodios", groups: { shows: "Series", movies: "Películas", episodes: "Episodios" } },
    parrot: { placeholder: "Artistas, álbumes, canciones", groups: { artists: "Artistas", albums: "Álbumes", songs: "Canciones" } },
  },
};

/** The phone search's words for `product` in `language` (any code outside the five falls back to English). */
export const phoneSearchStrings = (product: SearchPaletteProduct, language: string | undefined): PhoneSearchStrings => {
  const lang = languageOf(language);
  const palette = STRINGS[lang];
  const { badger, parrot, ...shared } = PHONE_STRINGS[lang];
  const words = product === "badger" ? badger : parrot;
  return { ...shared, button: palette.title, empty: palette.empty, placeholder: words.placeholder, groups: words.groups };
};
