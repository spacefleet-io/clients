type ParseResult = Record<string, unknown> & {
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  part?: number;
  language?: string;
};

type Rule = {
  field: string;
  pattern: RegExp;
  /** Fixed value stored on match; otherwise the first capture group (or the whole match) is stored. */
  value?: unknown;
  as?: "int" | "lower" | "bool";
};

const convert = (raw: string, as: Rule["as"]): unknown => {
  if (as === "int") return Number.parseInt(raw, 10);
  if (as === "lower") return raw.toLowerCase();
  if (as === "bool") return true;
  return raw;
};

/*
 * Rules run in order. The first rule that matches a field sets it; later rules for that
 * field are skipped. Every match also marks a cut point: the title is the text before the
 * earliest match. Technical words (resolution, codec, edition, disc or download format,
 * audio) are only cut points; callers read title, year, season, episode, part and language.
 */
const RULES: Rule[] = [
  { field: "year", pattern: /(?!^)[([]?((?:19[0-9]|20[012])[0-9])[)\]]?/, as: "int" },

  { field: "resolution", pattern: /([0-9]{3,4}[pi])/i, as: "lower" },
  { field: "resolution", pattern: /(4k)/i, as: "lower" },
  { field: "resolution", pattern: /FHD/i, value: "1080p" },
  { field: "resolution", pattern: /UHD/i, value: "4k" },

  { field: "extended", pattern: /EXTENDED(?:[\s.]CUT)?/i, as: "bool" },
  { field: "openmatte", pattern: /OPEN[. ]MATTE/i, as: "bool" },
  { field: "remux", pattern: /REMUX/i, as: "bool" },
  { field: "remastered", pattern: /\bRemaster(?:ed)?\b/i, as: "bool" },
  { field: "unrated", pattern: /\bunrated|uncensored\b/i, as: "bool" },

  // Disc or download format words.
  { field: "format", pattern: /\bDVD\b/i, value: "dvd" },
  { field: "format", pattern: /\bBlu-?ray\b/i, value: "bluray" },
  { field: "format", pattern: /\bWEB-?DL\b/i, as: "lower" },
  { field: "format", pattern: /[\s.[-](WEB)[\s.\]-]/i, as: "lower" },
  { field: "format", pattern: /HDTV/i, as: "lower" },

  { field: "codec", pattern: /dvix|mpeg2|divx|xvid|[xh][-. ]?26[45]|avc|hevc/i, as: "lower" },

  { field: "audio", pattern: /DTS-HD[\s-.]MA/, value: "dts-hd-ma" },
  { field: "audio", pattern: /MP3|mp3|FLAC|Atmos|DTS(?:-HD)?|TrueHD/, as: "lower" },
  { field: "audio", pattern: /Dual[- ]Audio/i, as: "lower" },
  { field: "audio", pattern: /EAC-?3(?:\.5\.1)?/i, value: "eac3" },
  { field: "audio", pattern: /AC-?3(?:\.5\.1)?/i, value: "ac3" },
  { field: "audio", pattern: /\bDD(?:\+|P)/i, value: "ddp" },
  { field: "audio", pattern: /\bDD[\b\d]/i, value: "dd" },
  { field: "audio", pattern: /AAC(?:[. ]?2[. ]0)?/, value: "aac" },

  { field: "channels", pattern: /\d+[.\s](?:1|0)\b/i },
  { field: "channels", pattern: /2(?:ch)/, value: 2.0 },
  { field: "channels", pattern: /6(?:ch)/, value: 5.1 },
  { field: "channels", pattern: /8(?:ch)/, value: 7.1 },

  { field: "bitdepth", pattern: /\b(8|10|12|16|24)[-\s.]?bits?\b/i, as: "int" },

  { field: "season", pattern: /([0-9]{1,2})xall/i, as: "int" },
  { field: "season", pattern: /S([0-9]{1,2}) ?E[0-9]{1,2}/i, as: "int" },
  { field: "season", pattern: /([0-9]{1,2})x[0-9]{1,2}/, as: "int" },
  { field: "season", pattern: /(?:Saison|Season)[. _-]?([0-9]{1,2})/i, as: "int" },
  { field: "season", pattern: /S([0-9]{1,2})(?![0-9])/i, as: "int" },

  { field: "episode", pattern: /S[0-9]{1,2} ?E([0-9]{1,5})/i, as: "int" },
  { field: "episode", pattern: /[0-9]{1,2}x([0-9]{1,5})/, as: "int" },
  { field: "episode", pattern: /[ée]p(?:isode)?[. _-]?([0-9]{1,5})/i, as: "int" },
  // Anime-style bare episode: "- 145 -" or "- 145" at end of title portion
  { field: "episode", pattern: /[-–]\s*(\d{2,4})\s*(?:[-–]|$)/, as: "int" },

  // Multi-part movie detection
  { field: "part", pattern: /(?:Part|Pt)\.?\s*(\d{1,2})/i, as: "int" },
  { field: "part", pattern: /Disc\s*(\d{1,2})/i, as: "int" },
  { field: "part", pattern: /CD\s*(\d{1,2})/i, as: "int" },

  { field: "language", pattern: /\bRUS\b/i, as: "lower" },
  { field: "language", pattern: /\bUKR\b/i, as: "lower" },
  { field: "language", pattern: /\bJPN\b/i, as: "lower" },
  { field: "language", pattern: /\bENG\b/i, as: "lower" },
  { field: "language", pattern: /\bNL\b/, as: "lower" },
  { field: "language", pattern: /\bFLEMISH\b/, as: "lower" },
  { field: "language", pattern: /\bGERMAN\b/, as: "lower" },
  { field: "language", pattern: /\b(ITA(?:LIAN)?|iT(?:A(?:LiAN)?)?)\b/, value: "ita" },
  { field: "language", pattern: /\bFR(?:ENCH)?\b/, as: "lower" },
];

const cleanTitle = (rawTitle: string) => {
  let cleanedTitle = rawTitle;
  if (cleanedTitle.indexOf(" ") === -1 && cleanedTitle.indexOf(".") !== -1) {
    cleanedTitle = cleanedTitle.replace(/\./g, " ");
  }
  cleanedTitle = cleanedTitle.replace(/_/g, " ");
  cleanedTitle = cleanedTitle.replace(/([(_]|- )$/, "").trim();
  return cleanedTitle;
};

export const parseMediaTitle = (title: string): ParseResult => {
  const result: ParseResult = {};
  let endOfTitle = title.length;

  for (const rule of RULES) {
    if (result[rule.field]) continue;
    const match = title.match(rule.pattern);
    if (!match) continue;
    const [rawMatch, captured] = match;
    result[rule.field] = rule.value ?? convert(captured || rawMatch, rule.as);
    if (match.index !== undefined && match.index < endOfTitle) {
      endOfTitle = match.index;
    }
  }

  if (typeof result.codec === "string") {
    result.codec = result.codec.replace(/[ .-]/, "");
  }

  result.title = cleanTitle(title.slice(0, endOfTitle));
  return result;
};

export const parseFilename = (filename: string) => {
  const baseName = filename.replace(/\.[^/.]+$/, "");
  return parseMediaTitle(baseName);
};
