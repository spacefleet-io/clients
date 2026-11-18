/**
 * A profile's playback settings (ACCT-SQUAD-03), kept in the account's encrypted library with the profile's other
 * viewing state so they follow the profile onto every device. The app language is the account's, not the profile's
 * (UX-I18N-07, `accountLanguage.ts`).
 *
 * One `setting.set` record per profile:
 *   key   `profile_settings_v1` for the main profile, `p:<profileId>:profile_settings_v1` for any other (ACCT-SQUAD-02)
 *   value JSON `{autoplayNextEpisode?, autoSkipIntro?, autoSkipCredits?, quality?, forceQuality?, audioLanguage?,
 *               skipMode?, titleLanguage?, fieldUpdatedAt: {<field>: iso}, resetAt?, updatedAt}`
 * A field absent from the value is one the profile never had: the app seeds it from the device's current value,
 * stamped `PROFILE_SETTINGS_SEED_AT` so any real value from another device beats it.
 * Fields a newer client wrote are kept on rewrite and ignored on read. Desktop, phone and TV share this shape.
 *
 * Sync merges field by field (Main 2026-10-30): every field carries its own time in `fieldUpdatedAt` (an older value
 * without it gives each field the record's `updatedAt`), and a receiver folds the incoming `setting.set` ops into its
 * own row with `mergeProfileSettingsOps` before applying them, so two devices editing different fields both keep
 * their edit. An equal time goes to the larger canonical JSON value, so every device ends with the same value
 * whatever order the ops arrive in. A blank value (a wipe) or `resetAt` (a promotion's move, which also stamps the
 * moved fields) drops the fields set before it; a seed after a reset is stamped at the reset (`profileSettingsSeedAt`).
 */
import type { LibraryOp } from "./libraryOps";
import type { ViewingScope } from "./profileViewing";
import { isTitleLanguage, type TitleLanguage } from "./titleLanguage";
import { normalizeLanguageCode } from "./trackPrefs";

export const PROFILE_SETTINGS_KEY = "profile_settings_v1";

export const scopedProfileSettingsKey = (scope: ViewingScope): string => `${scope.prefix}${PROFILE_SETTINGS_KEY}`;

/** True for any profile's settings key: `profile_settings_v1` or `p:<profileId>:profile_settings_v1`. */
export const isProfileSettingsKey = (key: string): boolean =>
  key === PROFILE_SETTINGS_KEY || /^p:[^:]+:profile_settings_v1$/.test(key);

/** The time a seeded field carries: older than any real edit, so a value saved on another device always wins. */
export const PROFILE_SETTINGS_SEED_AT = "1970-01-01T00:00:00.000Z";

/** Every streaming quality an app offers; an app with a shorter list maps the others onto its nearest one. */
export const PROFILE_QUALITIES = ["2160p", "1080p", "720p", "480p", "360p", "240p", "144p"] as const;
export type ProfileQuality = (typeof PROFILE_QUALITIES)[number];

export type ProfileSkipMode = "auto" | "manual";

/**
 * Languages offered for the "Default audio language" and "Subtitle language" settings on every app (ISO 639-1,
 * labels from `@space/shared/media-languages`). A curated list: the full media language table has ~190 entries, far
 * too many choices for one settings row.
 */
export const AUDIO_LANGUAGE_CHOICES = [
  "en", "fr", "de", "es", "it", "pt", "nl", "sv", "pl", "ru", "tr", "ar", "hi", "ja", "ko", "zh",
] as const;

export type AudioLanguageChoice = (typeof AUDIO_LANGUAGE_CHOICES)[number];

export const isAudioLanguageChoice = (value: unknown): value is AudioLanguageChoice =>
  typeof value === "string" && (AUDIO_LANGUAGE_CHOICES as readonly string[]).includes(value);

export type ProfileSettingsFields = {
  /** Continue TV episodes automatically (PLAY-NEXT-01). */
  autoplayNextEpisode: boolean;
  /** Skip intros automatically (PLAY-NEXT-02). */
  autoSkipIntro: boolean;
  /** Skip credits automatically (PLAY-NEXT-02). */
  autoSkipCredits: boolean;
  /** Streaming quality (PLAY-QUAL-01). */
  quality: ProfileQuality;
  /** "Force this quality" (PLAY-QUAL-03). */
  forceQuality: boolean;
  /** Default audio language, ISO 639-1; `null` = Original (PLAY-TRACK-01). */
  audioLanguage: string | null;
  /**
   * Preferred subtitle language, ISO 639-1; `null` = no preference, the file's own default subtitle (ACCT-SQUAD-03).
   * Applied at play start when the title has no remembered subtitle choice and the file has that language.
   */
  subtitleLanguage: string | null;
  /** Desktop's skip mode (no control shown). */
  skipMode: ProfileSkipMode;
  /**
   * "App language everywhere" or "Original version" for titles, posters and backdrops (ACCT-PROF-03). Never seeded
   * from the device: unset is the default, asked once on a profile created after the rule (`needsTitleLanguageQuestion`).
   */
  titleLanguage: TitleLanguage;
};

export type ProfileSettingsField = keyof ProfileSettingsFields;

export type ProfileSettings = Partial<ProfileSettingsFields> & {
  updatedAt: string;
  /** When each field (also one a newer client wrote) was last set; a field missing here takes `updatedAt`. */
  fieldUpdatedAt?: Record<string, string>;
  /** The value replaced the profile's whole set at this time: the other side's older fields are dropped on merge. */
  resetAt?: string;
  /** Fields a newer client wrote: preserved on rewrite, ignored on read. */
  [extra: string]: unknown;
};

export type ProfileSettingsPatch = Partial<ProfileSettingsFields>;

/** The fields every app seeds on a profile's first read (`skipMode` is desktop-only and has a default there). */
export const SEEDED_PROFILE_SETTINGS = [
  "autoplayNextEpisode",
  "autoSkipIntro",
  "autoSkipCredits",
  "quality",
  "forceQuality",
  "audioLanguage",
] as const satisfies ReadonlyArray<keyof ProfileSettingsFields>;

export type SeededProfileSetting = (typeof SEEDED_PROFILE_SETTINGS)[number];

const BOOLEAN_FIELDS = ["autoplayNextEpisode", "autoSkipIntro", "autoSkipCredits", "forceQuality"] as const;
const FIELDS: readonly ProfileSettingsField[] = [...BOOLEAN_FIELDS, "quality", "audioLanguage", "subtitleLanguage", "skipMode", "titleLanguage"];
const KNOWN_FIELDS = new Set<string>([...FIELDS, "updatedAt", "fieldUpdatedAt", "resetAt"]);
/**
 * Fields no app writes any more, dropped on read: `uiLanguage` became the account's (Chris 2026-11-11, UX-I18N-07);
 * `originalTitles` became `titleLanguage` (Chris 2026-11-16, ACCT-PROF-03).
 */
const RETIRED_FIELDS = new Set<string>(["uiLanguage", "originalTitles"]);

const isIso = (value: unknown): value is string => typeof value === "string" && value !== "";
const maxIso = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : a >= b ? a : b;

export const isProfileQuality = (value: unknown): value is ProfileQuality =>
  typeof value === "string" && (PROFILE_QUALITIES as readonly string[]).includes(value);

export type SubtitleLanguageTextLanguage = "en" | "fr" | "nl" | "de" | "es";

/**
 * ACCT-SQUAD-03: the "Subtitle language" setting's texts (Settings → Playback), the same in every app (REL-FAM-02).
 * `none` is the "no preference" choice (`subtitleLanguage: null`, the file's own default subtitles).
 */
export const subtitleLanguageTexts: Record<SubtitleLanguageTextLanguage, { title: string; description: string; none: string }> = {
  en: {
    title: "Subtitle language",
    description:
      "Subtitles start in this language when the file has it, unless you picked other subtitles in this movie or show after changing this setting.",
    none: "No preference",
  },
  fr: {
    title: "Langue des sous-titres",
    description:
      "Les sous-titres démarrent dans cette langue quand le fichier l'a, sauf si vous avez choisi d'autres sous-titres dans ce film ou cette série après avoir modifié ce réglage.",
    none: "Aucune préférence",
  },
  nl: {
    title: "Ondertiteltaal",
    description:
      "Ondertitels starten in deze taal als het bestand die taal bevat, tenzij je in deze film of serie andere ondertitels hebt gekozen nadat je deze instelling hebt gewijzigd.",
    none: "Geen voorkeur",
  },
  de: {
    title: "Untertitelsprache",
    description:
      "Untertitel starten in dieser Sprache, wenn die Datei sie enthält, außer du hast in diesem Film oder dieser Serie nach dem Ändern dieser Einstellung andere Untertitel gewählt.",
    none: "Keine Vorliebe",
  },
  es: {
    title: "Idioma de los subtítulos",
    description:
      "Los subtítulos empiezan en este idioma cuando el archivo lo incluye, salvo que hayas elegido otros subtítulos en esta película o serie después de cambiar este ajuste.",
    none: "Sin preferencia",
  },
};

/** Puts {@link subtitleLanguageTexts} into an i18next translation tree as `subtitleLanguage`, keeping its other keys. */
export const withSubtitleLanguageTexts = <T extends Record<string, unknown>>(translation: T, language: SubtitleLanguageTextLanguage): T => ({
  ...translation,
  subtitleLanguage: subtitleLanguageTexts[language],
});

/** The stored `subtitleLanguage` as a setting choice: a code of {@link AUDIO_LANGUAGE_CHOICES}, else `null` (no preference). */
export const profileSubtitleLanguage = (stored: Pick<ProfileSettings, "subtitleLanguage"> | null): AudioLanguageChoice | null => {
  const code = stored?.subtitleLanguage == null ? null : normalizeLanguageCode(stored.subtitleLanguage);
  return isAudioLanguageChoice(code) ? code : null;
};

/** Keeps only the valid known fields of `input` (wrong types are dropped, languages normalised to ISO 639-1). */
export const sanitizeProfileSettingsPatch = (input: Record<string, unknown>): ProfileSettingsPatch => {
  const out: ProfileSettingsPatch = {};
  for (const key of BOOLEAN_FIELDS) {
    if (typeof input[key] === "boolean") out[key] = input[key] as boolean;
  }
  if (isProfileQuality(input.quality)) out.quality = input.quality;
  for (const key of ["audioLanguage", "subtitleLanguage"] as const) {
    const value = input[key];
    if (value === null) out[key] = null;
    else if (typeof value === "string") {
      const code = normalizeLanguageCode(value);
      if (code !== null) out[key] = code;
    }
  }
  if (input.skipMode === "auto" || input.skipMode === "manual") out.skipMode = input.skipMode;
  if (isTitleLanguage(input.titleLanguage)) out.titleLanguage = input.titleLanguage;
  return out;
};

/** Parse a stored value; malformed JSON, a blanked value or a missing `updatedAt` → null ("no record"). */
export const parseProfileSettings = (raw: string | null | undefined): ProfileSettings | null => {
  if (typeof raw !== "string" || raw === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  if (typeof record.updatedAt !== "string" || record.updatedAt === "") return null;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_FIELDS.has(key) && !RETIRED_FIELDS.has(key)) extras[key] = value;
  }
  const fields = sanitizeProfileSettingsPatch(record);
  const stored = typeof record.fieldUpdatedAt === "object" && record.fieldUpdatedAt !== null ? (record.fieldUpdatedAt as Record<string, unknown>) : {};
  const fieldUpdatedAt: Record<string, string> = {};
  for (const key of [...Object.keys(fields), ...Object.keys(extras)]) {
    const at = stored[key];
    fieldUpdatedAt[key] = isIso(at) ? at : record.updatedAt;
  }
  return {
    ...extras,
    ...fields,
    fieldUpdatedAt,
    ...(isIso(record.resetAt) ? { resetAt: record.resetAt } : {}),
    updatedAt: record.updatedAt,
  };
};

/** The keys holding a value: the known fields, then the fields a newer client wrote (sorted). */
const valueKeys = (settings: ProfileSettings): string[] => [
  ...FIELDS.filter((key) => settings[key] !== undefined),
  ...Object.keys(settings)
    .filter((key) => !KNOWN_FIELDS.has(key) && settings[key] !== undefined)
    .sort(),
];

/** JSON with object keys sorted: the same value gives the same text on every device. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner
  );

/** Always the same text for the same settings (fields, then field times, then the record's times). */
export const serializeProfileSettings = (settings: ProfileSettings): string => {
  const keys = valueKeys(settings);
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = settings[key];
  const times: Record<string, string> = {};
  for (const key of keys) {
    const at = settings.fieldUpdatedAt?.[key];
    if (at !== undefined) times[key] = at;
  }
  out.fieldUpdatedAt = times;
  if (settings.resetAt !== undefined) out.resetAt = settings.resetAt;
  out.updatedAt = settings.updatedAt;
  return canonicalJson(out);
};

/** When `settings` last set `key` (its own time, else the record's). */
const fieldTime = (settings: ProfileSettings, key: string): string =>
  settings.fieldUpdatedAt?.[key] ?? settings.updatedAt;

/**
 * Read-modify-write: apply `patch` on `current`, keep every other field. The patched fields are stamped `updatedAt`;
 * the record's `updatedAt` never goes back (a seed stamped `PROFILE_SETTINGS_SEED_AT` keeps a partial record's time).
 */
export const mergeProfileSettings = (
  current: ProfileSettings | null,
  patch: ProfileSettingsPatch,
  updatedAt: string
): ProfileSettings => {
  const clean = sanitizeProfileSettingsPatch(patch as Record<string, unknown>);
  const times: Record<string, string> = {};
  if (current) for (const key of valueKeys(current)) times[key] = fieldTime(current, key);
  for (const key of Object.keys(clean)) times[key] = updatedAt;
  return { ...(current ?? {}), ...clean, fieldUpdatedAt: times, updatedAt: maxIso(current?.updatedAt, updatedAt) ?? updatedAt };
};

/**
 * The time a seed of `stored`'s missing fields carries: the epoch, so any real value from another device beats it,
 * but never before the value's `resetAt` (a promotion's move), which would drop the seed again on every device.
 */
export const profileSettingsSeedAt = (stored: ProfileSettings | null): string =>
  maxIso(PROFILE_SETTINGS_SEED_AT, stored?.resetAt) ?? PROFILE_SETTINGS_SEED_AT;

/**
 * A stored row as a record: a blank value (a wiped profile, or a promotion of a profile that had no settings) is an
 * empty set reset at the row's `updated_at`, so a seed after it is stamped at the reset (`profileSettingsSeedAt`).
 */
export const readProfileSettingsRow = (value: string | null | undefined, rowUpdatedAt: string): ProfileSettings | null => {
  if (value === "") return isIso(rowUpdatedAt) ? { updatedAt: rowUpdatedAt, resetAt: rowUpdatedAt, fieldUpdatedAt: {} } : null;
  return parseProfileSettings(value);
};

/**
 * Field-by-field merge of two records of one profile, the same result in either order and on every device
 * (commutative, associative, idempotent). Per field, known or written by a newer client: the newer time wins, and an
 * equal time goes to the larger canonical JSON value. Fields set before the later `resetAt` of the two are dropped.
 */
const mergeRecords = (a: ProfileSettings | null, b: ProfileSettings | null): ProfileSettings | null => {
  if (!a && !b) return null;
  const sides = [a, b].filter((side): side is ProfileSettings => side !== null);
  const resetAt = maxIso(a?.resetAt, b?.resetAt);
  const out: Record<string, unknown> = {};
  const times: Record<string, string> = {};
  for (const key of new Set(sides.flatMap(valueKeys))) {
    let best: { value: unknown; at: string; text: string } | null = null;
    for (const side of sides) {
      if (side[key] === undefined) continue;
      const candidate = { value: side[key], at: fieldTime(side, key), text: canonicalJson(side[key]) };
      if (!best || candidate.at > best.at || (candidate.at === best.at && candidate.text > best.text)) best = candidate;
    }
    if (!best || (resetAt !== undefined && best.at < resetAt)) continue;
    out[key] = best.value;
    times[key] = best.at;
  }
  return {
    ...out,
    fieldUpdatedAt: times,
    ...(resetAt !== undefined ? { resetAt } : {}),
    updatedAt: sides.map((side) => side.updatedAt).reduce((x, y) => maxIso(x, y)!),
  };
};

/** The value to store: blank when the merge left only a reset (a wiped profile stays wiped). */
const storedValueOf = (settings: ProfileSettings): string =>
  settings.resetAt === settings.updatedAt && valueKeys(settings).length === 0 ? "" : serializeProfileSettings(settings);

/**
 * Before a receiver applies a batch of ops: every `setting.set` of a profile settings key is folded, with the
 * receiver's own row (`local`, by key: its value and `updated_at`, or null when there is none), into ONE op at the
 * place of that key's last op. The folded op carries the merged value and the newest time (never older than the
 * row), so the ordinary `setting.set` statement (newer-or-equal wins) stores it. Every other op is returned unchanged.
 */
export const mergeProfileSettingsOps = (
  ops: readonly LibraryOp[],
  local: ReadonlyMap<string, { value: string | null; updatedAt: string } | null>
): LibraryOp[] => {
  const lastIndex = new Map<string, number>();
  ops.forEach((op, index) => {
    if (op.type === "setting.set" && isProfileSettingsKey(op.payload.key)) lastIndex.set(op.payload.key, index);
  });
  if (lastIndex.size === 0) return [...ops];
  const states = new Map<string, { settings: ProfileSettings | null; at: string | undefined }>();
  const out: LibraryOp[] = [];
  ops.forEach((op, index) => {
    if (op.type !== "setting.set" || !isProfileSettingsKey(op.payload.key)) {
      out.push(op);
      return;
    }
    const key = op.payload.key;
    const row = local.get(key) ?? null;
    const before = states.get(key) ?? { settings: row ? readProfileSettingsRow(row.value, row.updatedAt) : null, at: row?.updatedAt };
    const state = {
      settings: mergeRecords(before.settings, readProfileSettingsRow(op.payload.value, op.payload.updatedAt)),
      at: maxIso(before.at, op.payload.updatedAt),
    };
    states.set(key, state);
    if (lastIndex.get(key) !== index) return;
    const merged = state.settings;
    out.push(merged ? { ...op, payload: { key, value: storedValueOf(merged), updatedAt: maxIso(merged.updatedAt, state.at)! } } : op);
  });
  return out;
};

/**
 * Marks a whole-set replacement (deleting the main profile moves the new main's value into `profile_settings_v1`):
 * every moved field is stamped `at` and the value carries `resetAt: at`, so receivers drop the fields the key held
 * before the move and keep the moved ones. A value that is not a record is returned unchanged.
 */
export const resetProfileSettingsValue = (raw: string, at: string): string => {
  const parsed = parseProfileSettings(raw);
  if (!parsed) return raw;
  const times: Record<string, string> = {};
  for (const key of valueKeys(parsed)) times[key] = maxIso(fieldTime(parsed, key), at)!;
  return serializeProfileSettings({ ...parsed, fieldUpdatedAt: times, resetAt: maxIso(parsed.resetAt, at)!, updatedAt: maxIso(parsed.updatedAt, at)! });
};

/** The seeded fields `settings` does not hold yet, in `SEEDED_PROFILE_SETTINGS` order. */
export const missingProfileSettings = (settings: ProfileSettings | null): SeededProfileSetting[] =>
  SEEDED_PROFILE_SETTINGS.filter((key) => settings?.[key] === undefined);
