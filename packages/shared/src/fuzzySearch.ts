/**
 * Typo-tolerant search used by the search palette of Badger and Parrot (UX-SEARCH-02).
 *
 * Every word of the query must match a word of the text: exactly, as the start of the word (typing in progress),
 * inside it, or with a few typos (one per word of 4 to 7 letters, two from 8 letters, none below 4 so "cat" never
 * finds "car"). A typo in a word still being typed (the start of a longer word) counts only from 6 letters typed:
 * "brekai" finds "Breaking", but "star" never finds "Story" nor "State", "adle" never "Asleep". Accents and case are
 * ignored, and a query typed without spaces ("linkinpark") still finds the spaced name. Library data is decrypted on
 * the device, so this runs in the client, not in the API.
 */

/** Lower-cases and strips accents, so "Beyoncé" and "beyonce" compare equal. */
export const foldSearchText = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const splitWords = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Typos allowed in one query word of this length. */
const allowedTypos = (length: number): number => (length < 4 ? 0 : length < 8 ? 1 : 2);

/**
 * Typos allowed when a query word of this length is compared with only the start of a longer word: none below 6
 * letters, as a short start with one letter changed is a different word far too often ("star" / "stor"y, "back" /
 * "jack"son).
 */
const allowedPrefixTypos = (length: number): number => (length < 6 ? 0 : allowedTypos(length));

/** Optimal string alignment distance (insertions, deletions, substitutions, swaps of two neighbours), or `max + 1` past `max`. */
const typoDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const width = b.length + 1;
  let prevPrev = new Array<number>(width).fill(0);
  let prev = Array.from({ length: width }, (_, j) => j);
  let row = new Array<number>(width).fill(0);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prevPrev[j - 2]! + 1);
      row[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, row] = [prev, row, prevPrev];
  }
  return prev[b.length]!;
};

/** How well one query word matches one text word, 0 when it does not. */
const wordScore = (query: string, word: string): number => {
  if (word === query) return 1;
  if (word.startsWith(query)) return 0.9;
  if (query.length >= 3 && word.includes(query)) return 0.6;
  const max = allowedTypos(query.length);
  if (max === 0) return 0;
  const whole = typoDistance(query, word, max);
  const prefixMax = allowedPrefixTypos(query.length);
  const prefix = prefixMax > 0 && word.length > query.length ? typoDistance(query, word.slice(0, query.length), prefixMax) : max + 1;
  const distance = Math.min(whole, prefix);
  return distance > max ? 0 : 0.75 - 0.15 * distance;
};

/** A searched text folded and cut into words once, so a query typed letter by letter never folds it again. */
type PreparedText = { folded: string; words: readonly string[]; joined: string };

const prepareText = (text: string): PreparedText | null => {
  const folded = foldSearchText(text);
  const words = splitWords(folded);
  return words.length === 0 ? null : { folded, words, joined: words.join("") };
};

type PreparedQuery = { folded: string; words: readonly string[] };

const prepareQuery = (query: string): PreparedQuery | null => {
  const folded = foldSearchText(query).trim();
  const words = splitWords(folded);
  return words.length === 0 ? null : { folded, words };
};

/** Score of a query word found only across the words typed together ("linkinpark"), 0 when it is not. */
const joinedScore = (queryWord: string, joined: string): number => {
  if (joined.includes(queryWord)) return 0.6;
  const max = allowedPrefixTypos(queryWord.length);
  return max > 0 && typoDistance(queryWord, joined.slice(0, queryWord.length), max) <= max ? 0.5 : 0;
};

type QueryMatcher = {
  /** `wordScore` of query word `i` against a text word. */
  word: (i: number, word: string) => number;
  /** `joinedScore` of query word `i` against a text's joined words. */
  joined: (i: number, joined: string) => number;
};

const directMatcher = (query: PreparedQuery): QueryMatcher => ({
  word: (i, word) => wordScore(query.words[i]!, word),
  joined: (i, joined) => joinedScore(query.words[i]!, joined),
});

const scorePrepared = (query: PreparedQuery, text: PreparedText, match: QueryMatcher): number | null => {
  let total = 0;
  for (let i = 0; i < query.words.length; i++) {
    let best = 0;
    for (const word of text.words) {
      const s = match.word(i, word);
      if (s > best) best = s;
      if (best === 1) break;
    }
    if (best === 0 && query.words[i]!.length >= 4) best = match.joined(i, text.joined);
    if (best === 0) return null;
    total += best;
  }
  const coverage = Math.min(1, query.words.length / text.words.length);
  const startsBonus = text.folded.startsWith(query.folded) ? 0.1 : 0;
  return (total / query.words.length) * 0.8 + coverage * 0.2 + startsBonus;
};

/** Score of `text` for `query` (higher is better), or null when it does not match. */
export const fuzzyScore = (query: string, text: string): number | null => {
  const preparedQuery = prepareQuery(query);
  const preparedText = preparedQuery ? prepareText(text) : null;
  if (!preparedQuery || !preparedText) return null;
  return scorePrepared(preparedQuery, preparedText, directMatcher(preparedQuery));
};

export type FuzzyHit<T> = {
  item: T;
  score: number;
  /** Index, in the list `fields` returned, of the text that matched best (0 = the main name). */
  field: number;
};

/** Weight of a match in a secondary field (a person, an artist) against one in the main name. */
const SECONDARY_FIELD_WEIGHT = 0.85;

export type FuzzyIndex<T> = {
  /** Items that match `query`, best first (ties keep the input order), at most `limit`. */
  search: (query: string, limit?: number) => FuzzyHit<T>[];
};

/**
 * Folds and splits every searched text once, then answers each query by scoring every distinct word of the library
 * once per query word: a big library repeats the same words (artists on every song, show names on every episode), so
 * each keystroke costs one pass over the items instead of re-folding and re-matching every text. Gives exactly the
 * scores of `fuzzyScore`. `fields` lists the searched texts of an item, its main name first.
 */
export const createFuzzyIndex = <T>(items: readonly T[], fields: (item: T) => readonly string[]): FuzzyIndex<T> => {
  const prepared = items.map((item) => fields(item).map(prepareText));
  const search = (query: string, limit = Infinity): FuzzyHit<T>[] => {
    const preparedQuery = prepareQuery(query);
    if (!preparedQuery) return [];
    // Libraries repeat their words (and their names: an artist on every song), so each answer is worked out once.
    const direct = directMatcher(preparedQuery);
    const memo = (score: (i: number, text: string) => number) => {
      const seen = preparedQuery.words.map(() => new Map<string, number>());
      return (i: number, text: string): number => {
        let s = seen[i]!.get(text);
        if (s === undefined) seen[i]!.set(text, (s = score(i, text)));
        return s;
      };
    };
    const match: QueryMatcher = { word: memo(direct.word), joined: memo(direct.joined) };
    const hits: Array<FuzzyHit<T> & { order: number }> = [];
    prepared.forEach((texts, order) => {
      let score = -1;
      let field = -1;
      texts.forEach((text, f) => {
        if (!text) return;
        const raw = scorePrepared(preparedQuery, text, match);
        if (raw === null) return;
        const weighted = f === 0 ? raw : raw * SECONDARY_FIELD_WEIGHT;
        if (weighted > score) [score, field] = [weighted, f];
      });
      if (field >= 0) hits.push({ item: items[order]!, order, score, field });
    });
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return hits.slice(0, limit).map(({ item, score, field }) => ({ item, score, field }));
  };
  return { search };
};

/**
 * Items that match `query`, best first; `fields` lists the searched texts of an item, its main name first.
 * Ties keep the input order. For many queries over the same items, build a `createFuzzyIndex` once instead.
 */
export const fuzzyRank = <T>(items: readonly T[], query: string, fields: (item: T) => readonly string[], limit = Infinity): FuzzyHit<T>[] =>
  createFuzzyIndex(items, fields).search(query, limit);

export type FuzzyGroupHits<T> = {
  id: string;
  /** The best matches of this group, at most the limit asked for. */
  hits: FuzzyHit<T>[];
  /** How many items of the group match in all. */
  total: number;
};

/**
 * Searches several indexes for the same query (the phone search's groups), keeping their order and dropping empty
 * ones. `limit` is how many hits a group keeps: one number for all, or per group id (a group opened in full).
 */
export const searchFuzzyGroups = <T>(
  groups: readonly { id: string; index: FuzzyIndex<T> }[],
  query: string,
  limit: number | ((id: string) => number),
): FuzzyGroupHits<T>[] =>
  groups.flatMap(({ id, index }) => {
    const all = index.search(query);
    const keep = typeof limit === "number" ? limit : limit(id);
    return all.length === 0 ? [] : [{ id, hits: all.slice(0, keep), total: all.length }];
  });
