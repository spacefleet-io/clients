/**
 * Synced per-media audio + subtitle preference (PLAY-TRACK-04).
 *
 * One `setting.set` record per movie / per TV SHOW (never per episode):
 *   key   `track_prefs_v1:<mediaId>`
 *   value JSON `{audioLanguage, subtitle, updatedAt}`
 * Same transport as `episode_resume_v1:<episodeId>`: no op-shape change, old
 * clients ignore the key. The cross-client contract (Kodi / Jellyfin sidecars
 * port it to Python) is mirrored by the helpers below.
 */

export const TRACK_PREFS_KEY_PREFIX = "track_prefs_v1:";

export const trackPrefsKey = (mediaId: string) => `${TRACK_PREFS_KEY_PREFIX}${mediaId}`;

export type SubtitlePref = { language: string; format?: string; forced?: boolean };

export type TrackPrefs = {
  /** Language the user picked for audio; `null` = no choice recorded. */
  audioLanguage: string | null;
  /** `"off"` = the user turned subtitles off; `null` = no choice recorded. */
  subtitle: SubtitlePref | "off" | null;
  updatedAt: string;
  /** Fields a newer client wrote: preserved on rewrite, ignored on read. */
  [extra: string]: unknown;
};

/** A field left `undefined` is not touched. */
export type TrackPrefsPatch = {
  audioLanguage?: string | null;
  subtitle?: SubtitlePref | "off" | null;
};

// ISO 639-1 first, then its 639-2 (B and T) spellings.
const LANGUAGE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["en", "eng"],
  ["fr", "fre", "fra"],
  ["de", "ger", "deu"],
  ["es", "spa"],
  ["it", "ita"],
  ["pt", "por"],
  ["ru", "rus"],
  ["ja", "jpn"],
  ["ko", "kor"],
  ["zh", "chi", "zho"],
  ["nl", "dut", "nld"],
  ["sv", "swe"],
  ["no", "nor", "nob", "nno"],
  ["da", "dan"],
  ["fi", "fin"],
  ["pl", "pol"],
  ["tr", "tur"],
  ["ar", "ara"],
  ["he", "heb"],
  ["hi", "hin"],
  ["cs", "cze", "ces"],
  ["hu", "hun"],
  ["el", "gre", "ell"],
  ["uk", "ukr"],
  ["th", "tha"],
  ["vi", "vie"],
  ["id", "ind"],
  ["ro", "rum", "ron"],
  ["bg", "bul"],
  ["fa", "per", "fas"],
  ["is", "ice", "isl"],
  ["ms", "may", "msa"],
  ["bn", "ben"],
];

const LANGUAGE_TO_639_1 = new Map<string, string>(
  LANGUAGE_GROUPS.flatMap(([code, ...aliases]) => [[code, code] as const, ...aliases.map((alias) => [alias, code] as const)]),
);

/**
 * Lowercase ISO 639-1 for a library language tag (`eng`, `fre`, `en-US` →
 * `en`, `fr`, `en`); unknown codes are kept lowercased; `und` / empty → null.
 */
export const normalizeLanguageCode = (raw: string | null | undefined): string | null => {
  if (typeof raw !== "string") return null;
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (!primary || primary === "und" || primary === "zxx" || primary === "mis") return null;
  return LANGUAGE_TO_639_1.get(primary) ?? primary;
};

export const languagesMatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = normalizeLanguageCode(a);
  return left !== null && left === normalizeLanguageCode(b);
};

const parseSubtitlePref = (value: unknown): SubtitlePref | "off" | null | undefined => {
  if (value === null) return null;
  if (value === "off") return "off";
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.language !== "string" || record.language.trim() === "") return undefined;
  const pref: SubtitlePref = { language: record.language };
  if (typeof record.format === "string" && record.format !== "") pref.format = record.format;
  if (typeof record.forced === "boolean") pref.forced = record.forced;
  return pref;
};

/** Parse a stored value; malformed JSON or wrong types → null ("no record"). */
export const parseTrackPrefs = (raw: string | null | undefined): TrackPrefs | null => {
  if (typeof raw !== "string" || raw === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const { audioLanguage, subtitle, updatedAt, ...rest } = json as Record<string, unknown>;
  if (audioLanguage !== null && typeof audioLanguage !== "string") return null;
  if (typeof updatedAt !== "string" || updatedAt === "") return null;
  const parsedSubtitle = parseSubtitlePref(subtitle);
  if (parsedSubtitle === undefined) return null;
  return { ...rest, audioLanguage, subtitle: parsedSubtitle, updatedAt };
};

export const serializeTrackPrefs = (prefs: TrackPrefs): string => JSON.stringify(prefs);

const normalizeSubtitlePref = (pref: SubtitlePref | "off" | null): SubtitlePref | "off" | null => {
  if (pref === null || pref === "off") return pref;
  const language = normalizeLanguageCode(pref.language);
  if (language === null) return null;
  const next: SubtitlePref = { language };
  if (pref.format) next.format = pref.format;
  if (typeof pref.forced === "boolean") next.forced = pref.forced;
  return next;
};

/** Read-modify-write: apply `patch` on `current`, keep every other field. */
export const mergeTrackPrefs = (current: TrackPrefs | null, patch: TrackPrefsPatch, updatedAt: string): TrackPrefs => {
  const next: TrackPrefs = {
    ...(current ?? {}),
    audioLanguage: current?.audioLanguage ?? null,
    subtitle: current?.subtitle ?? null,
    updatedAt,
  };
  if (patch.audioLanguage !== undefined) next.audioLanguage = normalizeLanguageCode(patch.audioLanguage);
  if (patch.subtitle !== undefined) next.subtitle = normalizeSubtitlePref(patch.subtitle);
  return next;
};

/** The prefs patch a user's audio pick stands for, or null when the track has no usable language. */
export const audioPickPatch = (track: { language: string }): TrackPrefsPatch | null => {
  const audioLanguage = normalizeLanguageCode(track.language);
  return audioLanguage ? { audioLanguage } : null;
};

/** The prefs patch a user's subtitle pick stands for (`null` track = Off), or null for a track without a usable language. */
export const subtitlePickPatch = (track: { language: string; format?: string } | null): TrackPrefsPatch | null => {
  if (!track) return { subtitle: "off" };
  const language = normalizeLanguageCode(track.language);
  return language ? { subtitle: { language, format: track.format } } : null;
};

export type AudioTrackCandidate = { id: string; language: string };
export type SubtitleTrackCandidate = { id: string; language: string; format?: string | null; forced?: boolean | null };
/**
 * The user's default language settings, used when the remembered choice has no match. `subtitleSetAt` is when the
 * profile's subtitle language was last changed (its `fieldUpdatedAt.subtitleLanguage`); a change after the title's
 * record makes that language win over the title's remembered subtitle (PLAY-TRACK-11).
 */
export type TrackDefaults = { audioLanguage?: string | null; subtitle?: SubtitlePref | "off" | null; subtitleSetAt?: string | null };

export type TrackSelection = {
  /** `null` = nothing matched; the caller keeps its own default track. */
  audioTrackId: string | null;
  audioSource: "prefs" | "defaults" | "none";
  subtitle:
    | { mode: "off"; source: "prefs" | "defaults" }
    | { mode: "track"; id: string; source: "prefs" | "defaults" }
    | { mode: "default" };
};

const pickAudio = (tracks: ReadonlyArray<AudioTrackCandidate>, language: string | null | undefined): string | null =>
  language ? (tracks.find((track) => languagesMatch(track.language, language))?.id ?? null) : null;

const pickSubtitle = (tracks: ReadonlyArray<SubtitleTrackCandidate>, pref: SubtitlePref): string | null => {
  let best: { id: string; score: number } | null = null;
  for (const track of tracks) {
    if (!languagesMatch(track.language, pref.language)) continue;
    const forcedMatch = Boolean(track.forced) === Boolean(pref.forced);
    const formatMatch = Boolean(pref.format) && track.format === pref.format;
    const score = (forcedMatch ? 2 : 0) + (formatMatch ? 1 : 0);
    if (best === null || score > best.score) best = { id: track.id, score };
  }
  return best?.id ?? null;
};

/**
 * What to play for one file: the remembered choice of its movie/show, else the
 * default language settings, else "no choice" (the caller's own default).
 * A subtitle language changed in Settings after the title's record wins over its
 * remembered subtitle when the file has that language (PLAY-TRACK-11).
 * A remembered track the file lacks never rewrites the record.
 */
export const resolveTrackSelection = (input: {
  prefs: TrackPrefs | null;
  defaults?: TrackDefaults | null;
  audioTracks: ReadonlyArray<AudioTrackCandidate>;
  subtitleTracks: ReadonlyArray<SubtitleTrackCandidate>;
}): TrackSelection => {
  const { prefs, defaults, audioTracks, subtitleTracks } = input;

  let audioTrackId = pickAudio(audioTracks, prefs?.audioLanguage);
  let audioSource: TrackSelection["audioSource"] = audioTrackId ? "prefs" : "none";
  if (!audioTrackId) {
    audioTrackId = pickAudio(audioTracks, defaults?.audioLanguage);
    if (audioTrackId) audioSource = "defaults";
  }

  const fromSubtitlePref = (
    pref: SubtitlePref | "off" | null | undefined,
    source: "prefs" | "defaults",
  ): TrackSelection["subtitle"] | null => {
    if (pref === "off") return { mode: "off", source };
    if (!pref) return null;
    const id = pickSubtitle(subtitleTracks, pref);
    return id ? { mode: "track", id, source } : null;
  };
  const remembered = fromSubtitlePref(prefs?.subtitle, "prefs");
  const fromDefaults = fromSubtitlePref(defaults?.subtitle, "defaults");
  // PLAY-TRACK-11: a subtitle language changed in Settings after the title's record was last written comes first.
  const setAt = Date.parse(defaults?.subtitleSetAt ?? "");
  const pickedAt = Date.parse(prefs?.updatedAt ?? "");
  const defaultIsNewer = Number.isFinite(setAt) && Number.isFinite(pickedAt) && setAt > pickedAt;
  const subtitle = (defaultIsNewer ? (fromDefaults ?? remembered) : (remembered ?? fromDefaults)) ?? { mode: "default" as const };

  return { audioTrackId, audioSource, subtitle };
};
