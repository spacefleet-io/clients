/**
 * The library key as words (PRIV-KEY-01, ACCT-DEV-04): what the user sees, copies and types is 12 BIP39 words, not
 * the 32-byte key itself. The words carry 128 random bits (plus BIP39's 4-bit checksum, the 12th word's last bits);
 * the 256-bit AES key every app uses is derived from those bits with HKDF-SHA256. Everything past the key screens
 * still works with the 32-byte key as base64, so storage, pairing (PRIV-KEY-05) and encryption are unchanged.
 *
 * Shared by Badger and Parrot on the desktop, phone and TV. Pure code (no DOM, no native import): word lists and
 * checksum from `@scure/bip39` (MIT, audited), HKDF and SHA-256 from `@noble/hashes` (MIT, audited).
 */

import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist as czech } from "@scure/bip39/wordlists/czech.js";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as korean } from "@scure/bip39/wordlists/korean.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** How many words a library key has. */
export const LIBRARY_KEY_WORD_COUNT = 12;
/** Random bytes behind the words (128 bits). */
export const LIBRARY_KEY_SEED_BYTES = 16;
/** Bytes of the AES-256 key derived from them. */
export const LIBRARY_KEY_BYTES = 32;
/** Letters that are enough to name a word (BIP39 lists are unique in their first four letters). */
export const LIBRARY_KEY_PREFIX_LETTERS = 4;

/**
 * HKDF-SHA256 inputs, fixed forever: changing either one changes every account's key. Version 1 of the library key
 * (agent reading, approved by Main (2026-11-12)).
 */
export const LIBRARY_KEY_HKDF_SALT = "spacefleet library key v1";
export const LIBRARY_KEY_HKDF_INFO = "spacefleet library key v1 aes-256-gcm";

/** The official BIP39 word lists, in the order a tie between two lists is settled. */
const WORD_LISTS = {
  english,
  french,
  spanish,
  italian,
  portuguese,
  czech,
  japanese,
  korean,
  "simplified-chinese": simplifiedChinese,
  "traditional-chinese": traditionalChinese,
} as const satisfies Record<string, readonly string[]>;

export type LibraryKeyWordList = keyof typeof WORD_LISTS;

/** The official list for an app language (`fr`, `es-MX`, `zh-Hant`…), English when the language has none (nl, de). */
export const libraryKeyWordListFor = (appLanguage: string | null | undefined): LibraryKeyWordList => {
  const tag = (appLanguage ?? "").toLowerCase();
  const base = tag.split(/[-_]/)[0];
  if (base === "zh") return /hant|tw|hk|mo/.test(tag) ? "traditional-chinese" : "simplified-chinese";
  const byBase: Record<string, LibraryKeyWordList> = {
    fr: "french",
    es: "spanish",
    it: "italian",
    pt: "portuguese",
    cs: "czech",
    ja: "japanese",
    ko: "korean",
  };
  return byBase[base] ?? "english";
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
};

/** The 32-byte AES key (base64, the form every app already stores and uses) that the 16 seed bytes stand for. */
export const libraryKeyFromSeed = (seed: Uint8Array): string => {
  if (seed.length !== LIBRARY_KEY_SEED_BYTES) throw new Error(`library key seed must be ${LIBRARY_KEY_SEED_BYTES} bytes`);
  const encoder = new TextEncoder();
  const key = hkdf(sha256, seed, encoder.encode(LIBRARY_KEY_HKDF_SALT), encoder.encode(LIBRARY_KEY_HKDF_INFO), LIBRARY_KEY_BYTES);
  return bytesToBase64(key);
};

export type NewLibraryKey = {
  /** The 12 words, lowercase, in the list of the app's language. */
  words: string[];
  /** The derived 32-byte key, base64. */
  keyBase64: string;
};

/** A new library key: 128 random bits from the system's secure random source, as 12 words. */
export const generateLibraryKeyWords = (
  appLanguage: string | null | undefined,
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => globalThis.crypto.getRandomValues(bytes)
): NewLibraryKey => {
  const seed = new Uint8Array(LIBRARY_KEY_SEED_BYTES);
  random(seed);
  const list = WORD_LISTS[libraryKeyWordListFor(appLanguage)];
  const words = entropyToMnemonic(seed, list as string[]).normalize("NFC").split(/[\s\u3000]+/);
  return { words, keyBase64: libraryKeyFromSeed(seed) };
};

/** Lowercase, accents dropped, Unicode normalized: `Élève`, `eleve` and `élève` are one word. */
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

type FoldedList = {
  name: LibraryKeyWordList;
  words: readonly string[];
  folded: string[];
  exact: Map<string, number>;
  /** Shortest and longest folded word, in UTF-16 units. */
  minLength: number;
  maxLength: number;
};

let foldedLists: FoldedList[] | null = null;
const lists = (): FoldedList[] => {
  if (foldedLists) return foldedLists;
  foldedLists = (Object.keys(WORD_LISTS) as LibraryKeyWordList[]).map((name) => {
    const words = WORD_LISTS[name];
    const folded = words.map(fold);
    const lengths = folded.map((word) => word.length);
    return {
      name,
      words,
      folded,
      exact: new Map(folded.map((word, index) => [word, index])),
      minLength: Math.min(...lengths),
      maxLength: Math.max(...lengths),
    };
  });
  return foldedLists;
};

type Resolved = { index: number } | { partial: true } | null;

/** The word `token` names in `list`: the word itself, or (from 4 letters) the one word it starts. */
const resolve = (list: FoldedList, token: string): Resolved => {
  const exact = list.exact.get(token);
  if (exact !== undefined) return { index: exact };
  let found = -1;
  let count = 0;
  for (let i = 0; i < list.folded.length; i += 1) {
    if (list.folded[i].startsWith(token)) {
      count += 1;
      found = i;
      if (count > 1) break;
    }
  }
  if (count === 0) return null;
  if (count === 1 && [...token].length >= LIBRARY_KEY_PREFIX_LETTERS) return { index: found };
  return { partial: true };
};

/** One typed word and what it was read as. */
export type LibraryKeyTypedWord = {
  /** What the user typed. */
  typed: string;
  /** The full word it names, or null. */
  word: string | null;
  /** `ok`: a word; `partial`: the start of several words (still being typed); `unknown`: not a key word. */
  state: "ok" | "partial" | "unknown";
};

export type LibraryKeyInput =
  /** Nothing typed. */
  | { status: "empty" }
  /** Fewer than 12 words so far, all of them fine. */
  | { status: "incomplete"; words: LibraryKeyTypedWord[]; count: number }
  /** Word `position` (from 1) is not one of the key words. */
  | { status: "unknownWord"; words: LibraryKeyTypedWord[]; position: number; typed: string }
  /** More than 12 words. */
  | { status: "tooManyWords"; words: LibraryKeyTypedWord[]; count: number }
  /** 12 real words that are not a key: one is wrong or two are swapped (the BIP39 checksum does not match). */
  | { status: "checksum"; words: LibraryKeyTypedWord[] }
  /** A key. `words` is the canonical phrase, null for an old base64 key. */
  | { status: "ok"; keyBase64: string; words: string[] | null };

const LEGACY_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
/** Spaces, line breaks and the zero-width characters a copy can carry: dropped before an old base64 key is tested. */
const INVISIBLE = /[\s\u200b-\u200d\u2060\ufeff]+/g;
/**
 * What splits words in a typed or pasted key: any run of characters that are not letters (spaces, tabs, line
 * breaks, `- _ . , ; : / | +`, quotes, brackets, bullets, the numbers of a numbered copy, zero-width characters).
 */
const SEPARATOR = /[^\p{L}\p{M}]+/u;

/** The pieces of `text` between separators. */
const piecesOf = (text: string): string[] => text.split(SEPARATOR).filter(Boolean);

/** Most read attempts a pasted run-on text may cost before it is given up as unreadable (a few ms). */
const SEGMENT_BUDGET = 50_000;

/**
 * The 12-word keys (word indexes in `list`, checksum valid) that the folded `tokens` spell when each token is one word
 * (or its first 4 letters) or several whole words written together. Stops at 2: more than one is ambiguous.
 */
const segmentInList = (list: FoldedList, tokens: readonly string[]): number[][] | null => {
  const { minLength, maxLength } = list;
  const lettersAfter = tokens.map((_, i) => tokens.slice(i + 1).reduce((sum, token) => sum + token.length, 0));
  const found = new Map<string, number[]>();
  let steps = 0;
  const phrase: number[] = [];
  const visit = (tokenIndex: number, at: number): boolean => {
    if ((steps += 1) > SEGMENT_BUDGET) return false;
    if (tokenIndex === tokens.length) {
      if (phrase.length !== LIBRARY_KEY_WORD_COUNT) return true;
      try {
        mnemonicToEntropy(phrase.map((index) => list.words[index]).join(" "), list.words as string[]);
        found.set(phrase.join(","), [...phrase]);
      } catch {
        // Not a key: the checksum does not match.
      }
      return found.size < 2;
    }
    const token = tokens[tokenIndex];
    const wordsLeft = LIBRARY_KEY_WORD_COUNT - phrase.length;
    const lettersLeft = token.length - at + lettersAfter[tokenIndex];
    if (wordsLeft < tokens.length - tokenIndex || lettersLeft < wordsLeft * minLength || lettersLeft > wordsLeft * maxLength) {
      return true;
    }
    const next = (index: number, end: number) => {
      phrase.push(index);
      const go = end === token.length ? visit(tokenIndex + 1, 0) : visit(tokenIndex, end);
      phrase.pop();
      return go;
    };
    // The whole token as the first 4 letters (or more) of one word.
    if (at === 0 && !list.exact.has(token)) {
      const resolved = resolve(list, token);
      if (resolved && "index" in resolved && !next(resolved.index, token.length)) return false;
    }
    for (let length = minLength; length <= maxLength && at + length <= token.length; length += 1) {
      const index = list.exact.get(token.slice(at, at + length));
      if (index !== undefined && !next(index, at + length)) return false;
    }
    return true;
  };
  const complete = visit(0, 0);
  if (!complete && found.size < 2) return null; // over budget: not read rather than guessed
  return [...found.values()];
};

/** What a pasted copy of the key reads as (`splitPastedLibraryKey`). */
export type PastedLibraryKey =
  /** A key: its 12 words as in their list, or null for an old base64 key. */
  | { status: "ok"; keyBase64: string; words: string[] | null }
  /** Not a key (fewer or more than 12 words, a wrong word, a bad checksum, ambiguous): the pieces between separators. */
  | { status: "pieces"; pieces: string[] };

/**
 * Reads a library key pasted or autofilled from anywhere (a text file, a password manager, a note), for the 12 boxes
 * to fill at once (UX-KEY-01). The old 44-character base64 key wins first. Otherwise the words may be separated by
 * anything that is not a letter (spaces, line breaks, hyphens, underscores, commas, slashes, a numbered list…) or not
 * separated at all (`abandonability…`), in any case, accents or not, in any official list: the text is read as 12
 * whole words whose BIP39 checksum holds. When it spells two different keys, the one in `preferred` (the app's list)
 * wins; two keys otherwise is ambiguous and nothing is guessed. A text that is not one key gives its pieces, lowercase,
 * for the boxes to show as they are.
 */
export const splitPastedLibraryKey = (text: string, preferred?: LibraryKeyWordList): PastedLibraryKey => {
  const compact = text.replace(INVISIBLE, "");
  if (LEGACY_BASE64.test(compact)) return { status: "ok", keyBase64: compact, words: null };
  const pieces = piecesOf(text.normalize("NFC")).map((piece) => piece.toLowerCase());
  const tokens = piecesOf(fold(text));
  if (tokens.length > 0 && tokens.length <= LIBRARY_KEY_WORD_COUNT) {
    const ordered = [...lists()].sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred));
    const keys = new Map<string, string[]>();
    for (const list of ordered) {
      const phrases = segmentInList(list, tokens);
      if (phrases === null) return { status: "pieces", pieces };
      for (const phrase of phrases) {
        const words = phrase.map((index) => list.words[index].normalize("NFC"));
        keys.set(libraryKeyFromSeed(mnemonicToEntropy(words.join(" "), list.words as string[])), words);
      }
      if (list.name === preferred && keys.size > 0) break;
      if (keys.size > 1) break;
    }
    if (keys.size === 1) {
      const [[keyBase64, words]] = [...keys];
      return { status: "ok", keyBase64, words };
    }
  }
  return { status: "pieces", pieces };
};

/** The typed words read in one list. */
type Reading = { list: FoldedList; resolved: Resolved[]; score: number; exact: number; checksum: boolean };

const readIn = (list: FoldedList, tokens: readonly string[]): Reading => {
  const resolved = tokens.map((token) => resolve(list, token));
  const score = resolved.reduce((sum, r) => sum + (r && "index" in r ? 2 : r ? 1 : 0), 0);
  const exact = tokens.filter((token) => list.exact.has(token)).length;
  const phrase = resolved.flatMap((r) => (r && "index" in r ? [list.words[r.index]] : []));
  let checksum = false;
  if (tokens.length === LIBRARY_KEY_WORD_COUNT && phrase.length === LIBRARY_KEY_WORD_COUNT) {
    try {
      mnemonicToEntropy(phrase.join(" "), list.words as string[]);
      checksum = true;
    } catch {
      // Not a key in this list.
    }
  }
  return { list, resolved, score, exact, checksum };
};

/** Which of two readings of the same words is the key's list: positive when `a` is, 0 when nothing tells them apart. */
const compareReadings = (a: Reading, b: Reading): number =>
  a.score - b.score || a.exact - b.exact || Number(a.checksum) - Number(b.checksum);

/**
 * The lists the typed words are best read in. A key is made in one list, so the list is decided once for the whole
 * key from every word typed so far (UX-KEY-01): the list that names the most of them; then the one where more of them
 * are whole words rather than starts of a word (`engin` is a French word and only the start of English `engine`); then
 * the one where 12 words make a key (checksum). A word that is a key word in two lists counts for both, so only the
 * words of one list decide; until one does, every list still in the running is returned (first list first).
 */
const leadingReadings = (tokens: readonly string[]): Reading[] => {
  let leaders: Reading[] = [];
  for (const list of lists()) {
    const reading = readIn(list, tokens);
    const order = leaders.length ? compareReadings(reading, leaders[0]) : 1;
    if (order > 0) leaders = [reading];
    else if (order === 0) leaders.push(reading);
  }
  return leaders;
};

/**
 * The list the words typed so far (`text`, every box) decide for the key, or null while none does: nothing typed yet,
 * no key word, or only words that read as well in another list (`engi`, the start of French `engin` and English
 * `engine`). Screens that read one box at a time pass it to `readLibraryKeyInput` so every box is read in that list.
 */
export const libraryKeyWordListOf = (text: string): LibraryKeyWordList | null => {
  if (LEGACY_BASE64.test(text.replace(INVISIBLE, ""))) return null;
  const tokens = piecesOf(fold(text));
  if (tokens.length === 0) return null;
  const leaders = leadingReadings(tokens);
  return leaders.length === 1 && leaders[0].score > 0 ? leaders[0].list.name : null;
};

/**
 * The 12 boxes with each box that holds one word replaced by the full word it names in the key's list (decided from
 * every box, `libraryKeyWordListOf`), or, while no list is decided, only when every list still in the running names
 * the same word. Any other box (empty, the start of several words, not a key word, the old base64 key, a word whose
 * list is not decided yet) is returned as it is, so a word left before the key's list is known is never written in
 * the wrong list: it becomes its full word once a later word decides.
 */
export const completeLibraryKeyWords = (boxes: readonly string[]): string[] => {
  const tokensOf = boxes.map((box) => piecesOf(fold(box)));
  const tokens = tokensOf.flat();
  if (tokens.length === 0 || boxes.some((box) => LEGACY_BASE64.test(box.replace(INVISIBLE, "")))) return [...boxes];
  const leaders = leadingReadings(tokens);
  return boxes.map((box, index) => {
    const own = tokensOf[index];
    if (own.length !== 1) return box;
    const named = new Set(
      leaders.map((reading) => {
        const r = resolve(reading.list, own[0]);
        return r && "index" in r ? reading.list.words[r.index].normalize("NFC") : null;
      })
    );
    const [word] = named;
    return named.size === 1 && word ? word : box;
  });
};

/**
 * Reads what the user typed or pasted as a library key, word by word as they type, so a wrong word shows at once.
 * Case, accents, extra spaces and line breaks do not matter, and each word can be cut to its first 4 letters. The
 * words may be in any official BIP39 list (a key made in French opens on an English phone), all in one: the list is
 * decided from all of them (`libraryKeyWordListOf`), or is `list` when given (a box read within the whole key's list).
 * The old 44-character base64 form of the key is still read (keys shown before the words, and on devices that got the
 * key by pairing).
 */
export const readLibraryKeyInput = (text: string, list?: LibraryKeyWordList | null): LibraryKeyInput => {
  const compact = text.replace(INVISIBLE, "");
  if (!compact) return { status: "empty" };
  if (LEGACY_BASE64.test(compact)) return { status: "ok", keyBase64: compact, words: null };

  const tokens = piecesOf(fold(text));
  if (tokens.length === 0) return { status: "empty" };
  const stillTyping = !/[\s\u3000]$/.test(text);

  const given = list ? lists().find((folded) => folded.name === list) : undefined;
  // Lists still tied (nothing tells them apart): the first one (English first).
  const reading = given ? readIn(given, tokens) : leadingReadings(tokens)[0];
  const { resolved } = reading;
  const words: LibraryKeyTypedWord[] = tokens.map((typed, i) => {
    const r = resolved[i];
    if (r && "index" in r) return { typed, word: reading.list.words[r.index], state: "ok" };
    // A start of several words is fine only for the last word while it is still being typed.
    if (r && i === tokens.length - 1 && stillTyping) return { typed, word: null, state: "partial" };
    return { typed, word: null, state: "unknown" };
  });

  const unknown = words.findIndex((word) => word.state === "unknown");
  if (unknown >= 0) return { status: "unknownWord", words, position: unknown + 1, typed: words[unknown].typed };
  if (words.length > LIBRARY_KEY_WORD_COUNT) return { status: "tooManyWords", words, count: words.length };
  if (words.length < LIBRARY_KEY_WORD_COUNT || words.some((word) => word.state !== "ok")) {
    return { status: "incomplete", words, count: words.filter((word) => word.state === "ok").length };
  }
  if (!reading.checksum) return { status: "checksum", words };
  const phrase = words.map((word) => word.word as string);
  const seed = mnemonicToEntropy(phrase.join(" "), reading.list.words as string[]);
  return { status: "ok", keyBase64: libraryKeyFromSeed(seed), words: phrase.map((word) => word.normalize("NFC")) };
};

/**
 * Whether the text in one word box is a whole key word that starts no other key word in any list ("coconut", not
 * "act", which starts "action"): the box is then done and the caret can move on by itself (UX-KEY-01). Case and
 * accents do not matter.
 */
export const isCompleteLibraryKeyWord = (typed: string): boolean => {
  const text = fold(typed.trim());
  if (!text) return false;
  let whole = false;
  for (const list of lists()) {
    for (const word of list.folded) {
      if (!word.startsWith(text)) continue;
      if (word !== text) return false;
      whole = true;
    }
  }
  return whole;
};

/** The words as one line to copy or keep: single spaces, lowercase. */
export const libraryKeyWordsText = (words: readonly string[]): string => words.join(" ");
