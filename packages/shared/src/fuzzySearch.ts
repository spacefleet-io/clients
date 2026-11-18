/**
 * Typo-tolerant search used by the search palette of Badger and Parrot (UX-SEARCH-02).
 *
 * Every word of the query must match a word of the text: exactly, as the start of the word (typing in progress),
 * inside it, or with a few typos (one per word of 4 to 7 letters, two from 8 letters, none below 4 so "cat" never
 * finds "car"). Accents and case are ignored, and a query typed without spaces ("linkinpark") still finds the
 * spaced name. Library data is decrypted on the device, so this runs in the client, not in the API.
 */

/** Lower-cases and strips accents, so "Beyoncé" and "beyonce" compare equal. */
export const foldSearchText = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const splitWords = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Typos allowed in one query word of this length. */
const allowedTypos = (length: number): number => (length < 4 ? 0 : length < 8 ? 1 : 2);

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
  const prefix = word.length > query.length ? typoDistance(query, word.slice(0, query.length), max) : whole;
  const distance = Math.min(whole, prefix);
  return distance > max ? 0 : 0.75 - 0.15 * distance;
};

/** Score of `text` for `query` (higher is better), or null when it does not match. */
export const fuzzyScore = (query: string, text: string): number | null => {
  const foldedQuery = foldSearchText(query).trim();
  const queryWords = splitWords(foldedQuery);
  if (queryWords.length === 0) return null;
  const foldedText = foldSearchText(text);
  const textWords = splitWords(foldedText);
  if (textWords.length === 0) return null;
  const joined = textWords.join("");

  let total = 0;
  for (const queryWord of queryWords) {
    let best = 0;
    for (const word of textWords) {
      const s = wordScore(queryWord, word);
      if (s > best) best = s;
      if (best === 1) break;
    }
    if (best === 0 && queryWord.length >= 4) {
      if (joined.includes(queryWord)) best = 0.6;
      else if (typoDistance(queryWord, joined.slice(0, queryWord.length), allowedTypos(queryWord.length)) <= allowedTypos(queryWord.length)) {
        best = 0.5;
      }
    }
    if (best === 0) return null;
    total += best;
  }
  const coverage = Math.min(1, queryWords.length / textWords.length);
  const startsBonus = foldedText.startsWith(foldedQuery) ? 0.1 : 0;
  return (total / queryWords.length) * 0.8 + coverage * 0.2 + startsBonus;
};

export type FuzzyHit<T> = {
  item: T;
  score: number;
  /** Index, in the list `fields` returned, of the text that matched best (0 = the main name). */
  field: number;
};

/** Weight of a match in a secondary field (a person, an artist) against one in the main name. */
const SECONDARY_FIELD_WEIGHT = 0.85;

/**
 * Items that match `query`, best first; `fields` lists the searched texts of an item, its main name first.
 * Ties keep the input order.
 */
export const fuzzyRank = <T>(items: readonly T[], query: string, fields: (item: T) => readonly string[], limit = Infinity): FuzzyHit<T>[] => {
  if (splitWords(foldSearchText(query)).length === 0) return [];
  const hits: Array<FuzzyHit<T> & { order: number }> = [];
  items.forEach((item, order) => {
    let best: { score: number; field: number } | null = null;
    fields(item).forEach((text, field) => {
      const raw = fuzzyScore(query, text);
      if (raw === null) return;
      const score = field === 0 ? raw : raw * SECONDARY_FIELD_WEIGHT;
      if (!best || score > best.score) best = { score, field };
    });
    if (best) hits.push({ item, order, ...(best as { score: number; field: number }) });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ item, score, field }) => ({ item, score, field }));
};
