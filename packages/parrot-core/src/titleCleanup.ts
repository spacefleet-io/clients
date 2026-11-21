/**
 * PAR-META-23: the clean-ups the import review proposes for a file album's names (Chris 2026-11-21). Each is one rule
 * the user sees and can undo on its own; nothing here touches a name the rule does not clearly fit, and a rule never
 * leaves a name empty.
 */
export type ParrotTitleCleanupRule = "artist-prefix" | "video-tail" | "shared-suffix" | "full-album";

/** The order the rules apply in: an ending every song shares goes before the video tails, which may sit in front of it. */
export const PARROT_TITLE_CLEANUP_RULES: readonly ParrotTitleCleanupRule[] = ["artist-prefix", "shared-suffix", "video-tail", "full-album"];

export interface ParrotTitleCleanupInput {
  /** The album artist (else the artist) the album's files name. */
  artist: string;
  album: string;
  /** Every song title of the album, in any order. */
  titles: readonly string[];
}

export interface ParrotTitleCleanupApplied {
  rule: ParrotTitleCleanupRule;
  /** What came off, as the first name it came off spelled it (the most common one for video tails). */
  text: string;
  /** How many song names it changed; 0 for "full-album", which changes the album name. */
  count: number;
}

export interface ParrotTitleCleanupResult {
  album: string;
  /** The cleaned titles, in the input's order. */
  titles: string[];
  /** The rules that changed something, in the order they applied. */
  applied: ParrotTitleCleanupApplied[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A video site's tag at the end of a title: "(Official Audio)", "[Official Music Video]", "(Lyrics)", "(Visualizer)". */
const VIDEO_TAIL =
  /\s*[([]\s*(?:official\s+)?(?:(?:music|lyrics?|audio)\s+video|video|audio|lyrics?|visuali[sz]er|official)\s*[)\]]\s*$/iu;
/** The separators a shared ending may start at: " | ", " - ", " – ", " — ", " // ", " ~ ". */
const SEPARATOR = /\s+(?:\||-|\u2013|\u2014|\/\/|~)\s+/gu;
const FULL_ALBUM = /(?:\s*[([]\s*full\s+album\s*[)\]]|\s+[-\u2013\u2014|]\s+full\s+album)\s*$/iu;

/** "Artist - Title" → "Title" when the front is the album artist and a spaced dash follows. */
const stripArtist = (artist: string) => {
  const name = artist.trim();
  const front = name ? new RegExp(`^\\s*${escape(name)}\\s+[-\\u2013\\u2014]\\s+(?=\\S)`, "iu") : null;
  return (title: string) => {
    const hit = front?.exec(title);
    return hit ? { title: title.slice(hit[0].length).trim(), text: hit[0].trimStart() } : null;
  };
};

/** Takes every video tail off the end ("Song (Official Video) [Lyrics]" → "Song"); null when none or nothing would be left. */
const stripVideoTail = (title: string) => {
  let rest = title;
  let first = "";
  for (let hit = VIDEO_TAIL.exec(rest); hit && hit.index > 0; hit = VIDEO_TAIL.exec(rest)) {
    first = hit[0].trim();
    rest = rest.slice(0, hit.index);
  }
  return rest !== title && rest.trim() ? { title: rest.trim(), text: first } : null;
};

/** The longest ending, starting at a separator, that every title has and that leaves each something before it. */
const sharedSuffix = (titles: readonly string[]): string | null => {
  if (titles.length < 2) return null;
  const [first] = titles;
  for (const hit of first!.matchAll(SEPARATOR)) {
    const ending = first!.slice(hit.index);
    if (titles.every((title) => title.endsWith(ending) && title.slice(0, title.length - ending.length).trim())) return ending;
  }
  return null;
};

const commonest = (texts: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
};

/**
 * Cleans one file album's names with every rule but the `skipped` ones (the ones the user undid). An album proposes
 * the rules in `applied` of a run with nothing skipped.
 */
export const cleanParrotTitles = (input: ParrotTitleCleanupInput, skipped: ReadonlySet<ParrotTitleCleanupRule> = new Set()): ParrotTitleCleanupResult => {
  let titles = [...input.titles];
  let album = input.album;
  const applied: ParrotTitleCleanupApplied[] = [];
  const perTitle = (rule: ParrotTitleCleanupRule, strip: (title: string) => { title: string; text: string } | null) => {
    const texts: string[] = [];
    titles = titles.map((title) => {
      const hit = strip(title);
      if (!hit) return title;
      texts.push(hit.text);
      return hit.title;
    });
    if (texts.length > 0) applied.push({ rule, text: rule === "video-tail" ? commonest(texts) : texts[0]!, count: texts.length });
  };
  for (const rule of PARROT_TITLE_CLEANUP_RULES) {
    if (skipped.has(rule)) continue;
    if (rule === "artist-prefix") perTitle(rule, stripArtist(input.artist));
    else if (rule === "video-tail") perTitle(rule, stripVideoTail);
    else if (rule === "shared-suffix") {
      const ending = sharedSuffix(titles);
      if (ending) {
        titles = titles.map((title) => title.slice(0, title.length - ending.length).trim());
        applied.push({ rule, text: ending.trim(), count: titles.length });
      }
    } else {
      const hit = FULL_ALBUM.exec(album);
      if (hit && album.slice(0, hit.index).trim()) {
        applied.push({ rule, text: hit[0].trim(), count: 0 });
        album = album.slice(0, hit.index).trim();
      }
    }
  }
  return { album, titles, applied };
};
