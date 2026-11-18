import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist as czech } from "@scure/bip39/wordlists/czech.js";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import {
  LIBRARY_KEY_HKDF_INFO,
  LIBRARY_KEY_HKDF_SALT,
  generateLibraryKeyWords,
  libraryKeyFromSeed,
  libraryKeyWordListFor,
  libraryKeyWordListOf,
  completeLibraryKeyWords,
  isCompleteLibraryKeyWord,
  readLibraryKeyInput,
  splitPastedLibraryKey,
  type NewLibraryKey,
} from "../src/libraryKeyWords";

const seedOf = (fill: number) => new Uint8Array(16).fill(fill);
const fixedRandom = (fill: number) => (bytes: Uint8Array) => bytes.fill(fill);

// @req UX-KEY-01
describe("library key words (UX-KEY-01, PRIV-KEY-01)", () => {
  it("derives the AES key from the 128-bit seed with HKDF-SHA256 (fixed vectors)", () => {
    // Independent check against Node's own HKDF with the documented salt and info.
    for (const fill of [0x00, 0x7f, 0xff]) {
      const expected = Buffer.from(
        hkdfSync("sha256", seedOf(fill), Buffer.from(LIBRARY_KEY_HKDF_SALT), Buffer.from(LIBRARY_KEY_HKDF_INFO), 32)
      ).toString("base64");
      console.log(`[hkdf] seed=${fill.toString(16).padStart(2, "0")}x16 key=${expected}`);
      expect(libraryKeyFromSeed(seedOf(fill))).toBe(expected);
    }
    // Pinned so a change to the salt, info or encoding cannot slip through: it would re-key every account.
    expect(libraryKeyFromSeed(seedOf(0))).toMatchInlineSnapshot(`"z8jMiwk1uggL5TIKfuVBPuvjLQIzvJr/AzVibL82ADs="`);
    expect(LIBRARY_KEY_HKDF_SALT).toBe("spacefleet library key v1");
    expect(LIBRARY_KEY_HKDF_INFO).toBe("spacefleet library key v1 aes-256-gcm");
  });

  it("makes 12 lowercase words that read back to the same key", () => {
    for (let run = 0; run < 50; run += 1) {
      const made = generateLibraryKeyWords("en");
      expect(made.words).toHaveLength(12);
      for (const word of made.words) expect(word).toBe(word.toLowerCase());
      const read = readLibraryKeyInput(made.words.join(" "));
      expect(read).toEqual({ status: "ok", keyBase64: made.keyBase64, words: made.words });
      expect(Buffer.from(made.keyBase64, "base64")).toHaveLength(32);
    }
  });

  it("uses the app language's official list, English when there is none", () => {
    expect(libraryKeyWordListFor("fr")).toBe("french");
    expect(libraryKeyWordListFor("es-MX")).toBe("spanish");
    expect(libraryKeyWordListFor("nl")).toBe("english");
    expect(libraryKeyWordListFor("de")).toBe("english");
    expect(libraryKeyWordListFor(undefined)).toBe("english");
    // Seed bytes 0x01…: the first 11 bits are 8, the 9th word of each list.
    expect(generateLibraryKeyWords("fr", fixedRandom(1)).words[0]).toBe("abrasif");
    expect(generateLibraryKeyWords("de", fixedRandom(1)).words[0]).toBe(english[8]);
  });

  it("ignores case, extra spaces, line breaks and a numbered copy", () => {
    const made = generateLibraryKeyWords("en", fixedRandom(9));
    const messy = `  ${made.words.map((w, i) => (i % 2 ? w.toUpperCase() : w)).join("   \n")}  `;
    expect(readLibraryKeyInput(messy)).toMatchObject({ status: "ok", keyBase64: made.keyBase64 });
    const numbered = made.words.map((w, i) => `${i + 1}. ${w}`).join("\n");
    expect(readLibraryKeyInput(numbered)).toMatchObject({ status: "ok", keyBase64: made.keyBase64 });
  });

  it("accepts the first 4 letters of each word", () => {
    const made = generateLibraryKeyWords("en", fixedRandom(200));
    const short = made.words.map((w) => w.slice(0, 4)).join(" ");
    console.log(`[prefix] ${made.words.join(" ")} <- ${short}`);
    expect(readLibraryKeyInput(short)).toEqual({ status: "ok", keyBase64: made.keyBase64, words: made.words });
  });

  it("every Latin-script list names each word by its first 4 letters, accents ignored", () => {
    for (const lang of ["en", "fr", "es", "it", "pt", "cs"]) {
      const made = generateLibraryKeyWords(lang);
      const fold = (w: string) => w.normalize("NFKD").replace(/\p{M}+/gu, "");
      const short = made.words.map((w) => fold(w).slice(0, 4).toUpperCase()).join(" ");
      expect(readLibraryKeyInput(short), `${lang}: ${short}`).toMatchObject({ status: "ok", keyBase64: made.keyBase64 });
    }
  });

  it("in every Latin-script list, the first 4 letters (accents ignored) name exactly one word", () => {
    const fold = (w: string) => w.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
    const latinLists = { english, french, spanish, italian, portuguese, czech };
    for (const [name, wordlist] of Object.entries(latinLists)) {
      const folded = wordlist.map(fold);
      expect(new Set(folded).size, name).toBe(2048);
      const clashes = folded.filter((word) => {
        const start = word.slice(0, 4);
        return folded.includes(start) ? start !== word : folded.filter((other) => other.startsWith(start)).length !== 1;
      });
      console.log(`[prefix4] ${name}: ${clashes.length} clashes`);
      expect(clashes, name).toEqual([]);
    }
  });

  it("reads French words typed without accents, on any app language", () => {
    const made = generateLibraryKeyWords("fr", fixedRandom(1));
    const typed = made.words.map((w) => w.normalize("NFKD").replace(/\p{M}+/gu, "")).join(" ");
    expect(readLibraryKeyInput(typed)).toEqual({ status: "ok", keyBase64: made.keyBase64, words: made.words });
  });

  it("flags a wrong word at once, while the rest is still being typed", () => {
    expect(readLibraryKeyInput("abandon zzzz")).toMatchObject({ status: "unknownWord", position: 2, typed: "zzzz" });
    expect(readLibraryKeyInput("abandon abil")).toMatchObject({ status: "incomplete", count: 2 });
    // A start of several words is fine while typing; once the space is typed it must name one word.
    expect(readLibraryKeyInput("abandon ab")).toMatchObject({ status: "incomplete", count: 1 });
    expect(readLibraryKeyInput("abandon ab ")).toMatchObject({ status: "unknownWord", position: 2 });
    expect(readLibraryKeyInput("")).toEqual({ status: "empty" });
    expect(readLibraryKeyInput("   ")).toEqual({ status: "empty" });
  });

  it("reports a bad checksum and a wrong word count", () => {
    const words = entropyToMnemonic(seedOf(3), english).split(" ");
    const swapped = [...words.slice(0, 10), words[11], words[10]];
    const bad = [...words.slice(0, 11), words[11] === "zoo" ? "abandon" : "zoo"];
    const results = [swapped, bad].map((list) => readLibraryKeyInput(list.join(" ")).status);
    console.log(`[checksum] ${results.join(",")}`);
    expect(readLibraryKeyInput(bad.join(" ")).status).toBe("checksum");
    expect(readLibraryKeyInput([...words, "abandon"].join(" "))).toMatchObject({ status: "tooManyWords", count: 13 });
    expect(readLibraryKeyInput(words.slice(0, 11).join(" ") + " ")).toMatchObject({ status: "incomplete", count: 11 });
  });

  it("still opens an old 44-character base64 key, grouped or not", () => {
    const old = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
    expect(readLibraryKeyInput(old)).toEqual({ status: "ok", keyBase64: old, words: null });
    const grouped = old.match(/.{1,4}/g)!.join(" ");
    expect(readLibraryKeyInput(` ${grouped}\n`)).toEqual({ status: "ok", keyBase64: old, words: null });
  });

  it("knows a box is done when it holds a whole word that starts no other word", () => {
    const cases = { coconut: true, COCONUT: true, act: false, action: true, aban: false, abandon: true, eleve: true, zzzz: false, "": false };
    const seen = Object.fromEntries(Object.keys(cases).map((text) => [text, isCompleteLibraryKeyWord(text)]));
    console.log(`[complete] ${JSON.stringify(seen)}`);
    expect(seen).toEqual(cases);
  });

  // A key is made in one list, so it is read in one list, decided from every word typed so far: a word that is a key
  // word in two lists (French `engin`, which also starts English `engine`) never pulls the key into the other list.
  const frenchKey = "engin ancien balcon favori futur volcan univers tissu abandon amateur angle badge".split(" ");
  const englishKey = "engine absurd alarm animal balance cabin camera canal carbon civil bronze correct".split(" ");
  const keyOf = (words: string[], wordlist: readonly string[]) =>
    libraryKeyFromSeed(mnemonicToEntropy(words.join(" "), wordlist as string[]));
  /**
   * The 12 boxes as the user types `words` one box at a time: each word left is completed with every box typed so far
   * (`completeLibraryKeyWords`), and every box must read as a key word in the list those boxes decide.
   */
  const typeBoxes = (words: string[]) => {
    let boxes: string[] = [];
    for (const word of words) {
      boxes = completeLibraryKeyWords([...boxes, word]);
      const list = libraryKeyWordListOf(boxes.join(" "));
      const states = boxes.map((box) => {
        const read = readLibraryKeyInput(`${box} `, list);
        return read.status === "incomplete" ? read.words[0].state : read.status;
      });
      console.log(`[boxes] list=${list} ${boxes.map((box, i) => `${box}:${states[i]}`).join(" ")}`);
      expect(states.every((state) => state === "ok")).toBe(true);
    }
    return boxes;
  };

  it("@bugfix @regression-proof keeps a French key with `engin` and words also in English as typed", () => {
    // Every one of these words is also an English key word (or the start of one): `engin` -> `engine`.
    expect(readLibraryKeyInput(frenchKey.join(" "))).toEqual({ status: "ok", keyBase64: keyOf(frenchKey, french), words: frenchKey });
    expect(typeBoxes(frenchKey)).toEqual(frenchKey);
    // Typed as first 4 letters, the 12 words still read and complete as the French key.
    const starts = frenchKey.map((word) => word.slice(0, 4));
    expect(readLibraryKeyInput(starts.join(" "))).toEqual({ status: "ok", keyBase64: keyOf(frenchKey, french), words: frenchKey });
    expect(typeBoxes(starts)).toEqual(frenchKey);
  });

  it("@bugfix @regression-proof keeps an English key with `engine` English", () => {
    expect(readLibraryKeyInput(englishKey.join(" "))).toEqual({ status: "ok", keyBase64: keyOf(englishKey, english), words: englishKey });
    expect(typeBoxes(englishKey)).toEqual(englishKey);
    const starts = englishKey.map((word) => word.slice(0, 4));
    expect(readLibraryKeyInput(starts.join(" "))).toEqual({ status: "ok", keyBase64: keyOf(englishKey, english), words: englishKey });
    expect(typeBoxes(starts)).toEqual(englishKey);
  });

  it("@bugfix @regression-proof decides the list from the words that are in one list only", () => {
    // A whole French word decides French; its start shared with English (`engi`) decides nothing.
    expect(libraryKeyWordListOf("engin")).toBe("french");
    expect(libraryKeyWordListOf("engine")).toBe("english");
    expect(libraryKeyWordListOf("engi")).toBeNull();
    expect(completeLibraryKeyWords(["engi"])).toEqual(["engi"]);
    // A later French-only word decides, and the box left before it becomes its French word.
    expect(libraryKeyWordListOf("engi élève")).toBe("french");
    expect(completeLibraryKeyWords(["engi", "eleve", ""])).toEqual(["engin", "élève", ""]);
    // An English-only word decides English: the shared words around it do not switch it.
    expect(libraryKeyWordListOf("volc engine anim")).toBe("english");
    expect(completeLibraryKeyWords(["volc", "engine", "anim"])).toEqual(["volcano", "engine", "animal"]);
    expect(libraryKeyWordListOf("")).toBeNull();
    expect(libraryKeyWordListOf("zzzz")).toBeNull();
  });
});

// @req UX-KEY-01
describe("a library key pasted from anywhere (UX-KEY-01)", () => {
  const key = generateLibraryKeyWords("en", fixedRandom(7));
  const w = key.words;
  const french = generateLibraryKeyWords("fr", fixedRandom(9));
  const bare = (word: string) => word.normalize("NFKD").replace(/\p{M}+/gu, "");
  // Words 1-2, 3-4… written together, each pair separated from the next.
  const pairs = w.map((word, i) => (i % 2 ? `${word} ` : word)).join("");

  const accepted: [string, string, NewLibraryKey][] = [
    ["spaces", w.join(" "), key],
    ["newlines", w.join("\n"), key],
    ["numbered list", w.map((word, i) => `${i + 1}. ${word}`).join("\n"), key],
    ["numbered 1) and 01 -", w.map((word, i) => (i % 2 ? `${i + 1}) ${word}` : `0${i + 1} - ${word}`)).join("\r\n"), key],
    ["hyphens", w.join("-"), key],
    ["underscores", w.join("_"), key],
    ["commas", w.join(", "), key],
    ["slashes", w.join("/"), key],
    ["dots, pipes, semicolons", w.join(".|;"), key],
    ["quotes, brackets, bullets", w.map((word) => `• "${word}" [x]`.replace("x", "")).join(" "), key],
    ["tabs, ideographic and zero-width spaces", w.join("\t\u3000\u200b"), key],
    ["no separators at all", w.join(""), key],
    ["mixed: some words joined", pairs, key],
    ["MIXED CASE", w.map((word, i) => (i % 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1))).join(" "), key],
    ["MIXED CASE, no separators", w.join("").toUpperCase(), key],
    ["leading and trailing junk whitespace", `\n\t  \u00a0${w.join("  ")} \u3000\n\n`, key],
    ["4-letter starts", w.map((word) => word.slice(0, 4)).join(" "), key],
    ["French, accents", french.words.join(" "), french],
    ["French, no accents", french.words.map(bare).join("-"), french],
    ["French, accents, no separators", french.words.join(""), french],
    ["French, no accents, no separators, upper case", french.words.map(bare).join("").toUpperCase(), french],
  ];
  it.each(accepted)("reads %s", (_, pasted, made) => {
    expect(splitPastedLibraryKey(pasted)).toEqual({ status: "ok", keyBase64: made.keyBase64, words: made.words });
  });

  it("reads the old base64 key first, '+' and '/' included, grouped or not", () => {
    const old = Buffer.from(new Uint8Array(32).fill(0xfb)).toString("base64");
    expect(old).toMatch(/[+/]/);
    for (const pasted of [old, ` ${old.match(/.{1,4}/g)!.join(" ")}\n`, `\u200b${old}\u200b`]) {
      expect(splitPastedLibraryKey(pasted)).toEqual({ status: "ok", keyBase64: old, words: null });
    }
  });

  it("never reads a wrong key: 11 or 13 words, a bad checksum, an ambiguous run-on text", () => {
    const bad = [...w.slice(0, 11), w[11] === "zoo" ? "abandon" : "zoo"];
    // Two keys in one run-on text: "...shop can alarm" and "...shop canal arm" both hold their checksum.
    const one = "baby double inch pepper squeeze aerobic crumble grace noodle shop can alarm";
    const other = "baby double inch pepper squeeze aerobic crumble grace noodle shop canal arm";
    expect(splitPastedLibraryKey(one).status).toBe("ok");
    expect(splitPastedLibraryKey(other).status).toBe("ok");
    const cases = {
      eleven: w.slice(0, 11).join(" "),
      elevenJoined: w.slice(0, 11).join(""),
      thirteen: [...w, "abandon"].join(" "),
      checksum: bad.join(" "),
      checksumJoined: bad.join(""),
      ambiguous: one.replace(/ /g, ""),
      ambiguousPreferred: one.replace(/ /g, ""),
      unknownWord: [...w.slice(0, 11), "zzzzz"].join(" "),
    };
    for (const [name, pasted] of Object.entries(cases)) {
      const read = splitPastedLibraryKey(pasted, name === "ambiguousPreferred" ? "english" : undefined);
      expect({ name, status: read.status }).toEqual({ name, status: "pieces" });
    }
    // What could not be read is handed back in pieces, for the boxes to show as they are.
    expect(splitPastedLibraryKey(`1. ${bad.join("\n")}`)).toEqual({ status: "pieces", pieces: bad });
  });
});
