/**
 * The multiple between storage units: 1000 (kB, MB, GB as macOS, iOS, Android and GNOME Files count them) or 1024
 * (Windows Explorer and KDE Dolphin). Every storage figure follows the file manager of the device it is shown on, so a
 * file reads the same size in the app as on the computer it came from (STOR-UNIT-01). The label stays "GB" either way.
 */
export type StorageUnitBase = 1000 | 1024;

/** Bytes in one GB of a plan size: plan sizes have always been counted in 1024³ bytes (ACCT-PLAN-01). */
export const PLAN_GB_BYTES = 1024 ** 3;

/** A plan size in GB (`storageLimitGb`, `storageGb`) as the bytes it allows. */
export const planGbToBytes = (gb: number): number => gb * PLAN_GB_BYTES;

/**
 * The base the device's own file manager uses (STOR-UNIT-01). `os` is a desktop system as the platform layer names it
 * ("windows", "macos", "linux") or a React Native `Platform.OS` ("ios", "android"); `desktop` is Linux's
 * `XDG_CURRENT_DESKTOP` ("KDE", "GNOME", "ubuntu:GNOME"): KDE means 1024, any other or unknown desktop 1000.
 */
export const storageUnitBaseFor = (os: string, desktop?: string | null): StorageUnitBase => {
  if (os === "windows") return 1024;
  if (os === "linux") return (desktop ?? "").split(":").some((part) => part.trim().toUpperCase() === "KDE") ? 1024 : 1000;
  return 1000;
};

/** The base for a browser from its user agent: Windows is 1024, every other system 1000 (STOR-UNIT-01). */
export const storageUnitBaseFromUserAgent = (userAgent: string | null | undefined): StorageUnitBase =>
  /\bWindows\b/i.test(userAgent ?? "") ? 1024 : 1000;

const initialBase = (): StorageUnitBase => {
  const nav: unknown = Reflect.get(globalThis, "navigator");
  const ua = nav && typeof nav === "object" && "userAgent" in nav ? nav.userAgent : undefined;
  return typeof ua === "string" ? storageUnitBaseFromUserAgent(ua) : 1000;
};

let currentBase: StorageUnitBase = initialBase();

/**
 * Sets the base for this app (STOR-UNIT-01). A browser picks it from its user agent on load; an Electron app sets it
 * from its main process (platform and `XDG_CURRENT_DESKTOP`), which the renderer cannot read; the CLI from Node.
 */
export const setStorageUnitBase = (base: StorageUnitBase): void => {
  currentBase = base;
};

export const getStorageUnitBase = (): StorageUnitBase => currentBase;

const STORAGE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
export type StorageUnit = (typeof STORAGE_UNITS)[number];

type StorageScale = { base: StorageUnitBase; min: number; max: number; digitsAt: (unit: number) => number };

/**
 * A size in the largest unit between `min` and `max` it reaches, rounded to that unit's decimals plus `extraDigits`,
 * and the bytes the rounded figure stands for. A value that rounds up to a whole next unit is written in it
 * ("1.0 TB", never "1024.0 GB"), so the figure never decreases as the bytes grow.
 */
const scaleStorage = (abs: number, scale: StorageScale, extraDigits: number) => {
  const { base, min, max } = scale;
  // Bytes are whole: B never gains decimals.
  const digitsAt = (unit: number) => (unit === 0 ? 0 : scale.digitsAt(unit) + extraDigits);
  let index = min;
  while (index < max && abs >= base ** (index + 1)) index += 1;
  let digits = digitsAt(index);
  let value = Number((abs / base ** index).toFixed(digits));
  if (index < max && value >= base) {
    index += 1;
    digits = digitsAt(index);
    value = Number((abs / base ** index).toFixed(digits));
  }
  return { value, digits, unit: STORAGE_UNITS[index], shownBytes: value * base ** index };
};

/** `formatStorageBytes`'s decimals: B whole, KB to GB one, TB two. */
const plainScale = (base: StorageUnitBase): StorageScale => ({
  base,
  min: 0,
  max: STORAGE_UNITS.length - 1,
  digitsAt: (unit) => (unit === 0 ? 0 : unit === STORAGE_UNITS.length - 1 ? 2 : 1),
});

const plainStorage = (bytes: number, base: StorageUnitBase, extraDigits: number) => {
  const safe = Number.isFinite(bytes) ? bytes : 0;
  const shown = scaleStorage(Math.abs(safe), plainScale(base), extraDigits);
  const sign = safe < 0 ? "-" : "";
  return { text: `${sign}${shown.value.toFixed(shown.digits)} ${shown.unit}`, shownBytes: (safe < 0 ? -1 : 1) * shown.shownBytes };
};

/** A size as "31.9 GB": B whole, KB to GB with one decimal, TB with two, in the device's base (STOR-UNIT-01). */
export const formatStorageBytes = (bytes: number, base: StorageUnitBase = currentBase): string => plainStorage(bytes, base, 0).text;

/** Decimals a figure-against-limit pair may add: enough to tell one byte apart in TB. */
const MAX_EXTRA_DIGITS = 15;

/** The first `extra` at which `show(used)` and `show(limit)` order as the bytes do. */
const pairDigits = (usedBytes: number, limitBytes: number, shownBytes: (bytes: number, extra: number) => number): number => {
  const order = Math.sign(usedBytes - limitBytes);
  let extra = 0;
  while (extra < MAX_EXTRA_DIGITS && Math.sign(shownBytes(usedBytes, extra) - shownBytes(limitBytes, extra)) !== order) extra += 1;
  return extra;
};

/**
 * A figure and the limit it is measured against (used of a plan, a file against the space left), written so the texts
 * order as the bytes do (STOR-UNIT-01): equal bytes read the same, fewer bytes read lower, more read higher. Both go
 * through `formatStorageBytes`'s units; when rounding would make two different sizes read the same ("100.0 GB of
 * 100.0 GB" one megabyte short of the limit), both gain decimals until they differ. A user is never refused space
 * while the screen shows usage below the limit, nor shown a full account that still has room.
 */
export const formatStorageUsage = (
  usedBytes: number,
  limitBytes: number,
  base: StorageUnitBase = currentBase,
): { used: string; limit: string } => {
  const extra = pairDigits(usedBytes, limitBytes, (bytes, digits) => plainStorage(bytes, base, digits).shownBytes);
  return { used: plainStorage(usedBytes, base, extra).text, limit: plainStorage(limitBytes, base, extra).text };
};

/**
 * The share of a limit in use, as a percentage rounded DOWN to `decimals` and clamped to 0–100, so it reads 100 only
 * once `usedBytes` reaches `limitBytes` (STOR-UNIT-01: nothing reads full before the account is blocked). A limit of 0
 * or less reads 100 (no room at all); a non-finite or negative use reads 0.
 */
export const storageUsedPercent = (usedBytes: number, limitBytes: number, decimals = 0): number => {
  if (!(limitBytes > 0)) return 100;
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  if (used >= limitBytes) return 100;
  const scale = 10 ** decimals;
  return Math.min(100 - 1 / scale, Math.floor((used / limitBytes) * 100 * scale) / scale);
};

type LocalizedStorageOptions = { minUnit?: StorageUnit; maxUnit?: StorageUnit; base?: StorageUnitBase };

/** `localizedStorageSize`'s decimals: GB and TB one, smaller units none. */
const localizedScale = ({ minUnit = "B", maxUnit = "TB", base = currentBase }: LocalizedStorageOptions): StorageScale => ({
  base,
  min: STORAGE_UNITS.indexOf(minUnit),
  max: STORAGE_UNITS.indexOf(maxUnit),
  digitsAt: (unit) => (unit >= STORAGE_UNITS.indexOf("GB") ? 1 : 0),
});

const localizedStorage = (bytes: number, locale: string, scale: StorageScale, extraDigits: number) => {
  const shown = scaleStorage(Number.isFinite(bytes) && bytes > 0 ? bytes : 0, scale, extraDigits);
  return {
    value: shown.value.toLocaleString(locale, { minimumFractionDigits: shown.digits, maximumFractionDigits: shown.digits, useGrouping: false }),
    unit: shown.unit,
    shownBytes: shown.shownBytes,
  };
};

/**
 * A size split into a number written the way `locale` writes it ("20,0" in French) and its unit, which the caller
 * translates ("Go", "GB"). Climbs from `minUnit` to `maxUnit` in the device's base (STOR-UNIT-01); GB and TB keep one
 * decimal, smaller units none. Zero, negative and non-finite sizes read as 0 in `minUnit`.
 */
export const localizedStorageSize = (
  bytes: number,
  locale: string,
  options: LocalizedStorageOptions = {},
): { value: string; unit: StorageUnit } => {
  const { value, unit } = localizedStorage(bytes, locale, localizedScale(options), 0);
  return { value, unit };
};

/** `formatStorageUsage` for `localizedStorageSize`'s split figures: the pair orders as the bytes do (STOR-UNIT-01). */
export const localizedStorageUsage = (
  usedBytes: number,
  limitBytes: number,
  locale: string,
  options: LocalizedStorageOptions = {},
): { used: { value: string; unit: StorageUnit }; limit: { value: string; unit: StorageUnit } } => {
  const scale = localizedScale(options);
  const show = (bytes: number, extra: number) => {
    const { value, unit } = localizedStorage(bytes, locale, scale, extra);
    return { value, unit };
  };
  const extra = pairDigits(usedBytes, limitBytes, (bytes, digits) => localizedStorage(bytes, locale, scale, digits).shownBytes);
  return { used: show(usedBytes, extra), limit: show(limitBytes, extra) };
};

/** Unit names a language writes differently from the international ones (STOR-UNIT-02): French counts in octets. */
const STORAGE_UNIT_NAMES: Partial<Record<string, Record<StorageUnit, string>>> = {
  fr: { B: "o", KB: "Ko", MB: "Mo", GB: "Go", TB: "To" },
};

/** A storage unit as `locale` writes it: "Go" in French, "GB" in English, Dutch, German and Spanish (STOR-UNIT-02). */
export const storageUnitName = (unit: StorageUnit, locale: string): string =>
  STORAGE_UNIT_NAMES[locale.split("-")[0].toLowerCase()]?.[unit] ?? unit;

const storageText = ({ value, unit }: { value: string; unit: StorageUnit }, locale: string) => `${value} ${storageUnitName(unit, locale)}`;

/**
 * A size as the interface language writes it: "3,2 Go" and "800 Mo" in French, "3.2 GB" and "800 MB" in English
 * (STOR-UNIT-02), in the device's base (STOR-UNIT-01). GB and TB keep one decimal, smaller units none.
 */
export const formatLocalizedStorage = (bytes: number, locale: string, options: LocalizedStorageOptions = {}): string =>
  storageText(localizedStorageSize(bytes, locale, options), locale);

/** `formatLocalizedStorage` for a figure and its limit ("3,2 Go" / "20,0 Go"): the pair orders as the bytes do (STOR-UNIT-01). */
export const formatLocalizedStorageUsage = (
  usedBytes: number,
  limitBytes: number,
  locale: string,
  options: LocalizedStorageOptions = {},
): { used: string; limit: string } => {
  const { used, limit } = localizedStorageUsage(usedBytes, limitBytes, locale, options);
  return { used: storageText(used, locale), limit: storageText(limit, locale) };
};

// @bugfix #2461: `toLocaleString(locale, options)` builds a new ICU number formatter on every call; a Home page
// of poster cards re-rendering under ingest progress spent ~400 ms of a 30 s window there. One formatter per
// (locale, digits) is reused instead.
const decimalFormatters = new Map<string, Intl.NumberFormat>();

const decimalFormatter = (locale: string, digits: number): Intl.NumberFormat => {
  const key = `${locale}|${digits}`;
  let formatter = decimalFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
    decimalFormatters.set(key, formatter);
  }
  return formatter;
};

/** A number with exactly `digits` decimals, written the way `locale` writes it ("6,3" in German, "6.3" in English). */
export const localizedDecimal = (value: number, locale: string, digits = 1): string =>
  decimalFormatter(locale, digits).format(Number.isFinite(value) ? value : 0);

export type RelativeTimeUnit = "just_now" | "seconds" | "minutes" | "hours" | "days";

export type RelativeTimeBucket = {
  unit: RelativeTimeUnit;
  value: number;
};

export const bucketRelativeTime = (
  fromIso: string | null | undefined,
  now: number = Date.now(),
): RelativeTimeBucket | null => {
  if (!fromIso) return null;
  const ts = Date.parse(fromIso);
  if (!Number.isFinite(ts)) return null;
  const diffMs = Math.max(0, now - ts);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { unit: "just_now", value: 0 };
  if (seconds < 60) return { unit: "seconds", value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  const days = Math.floor(hours / 24);
  return { unit: "days", value: days };
};

export const formatRelativeTimeEnglish = (
  fromIso: string | null | undefined,
  now: number = Date.now(),
): string => {
  const bucket = bucketRelativeTime(fromIso, now);
  if (!bucket) return "—";
  switch (bucket.unit) {
    case "just_now":
      return "just now";
    case "seconds":
      return `${bucket.value}s ago`;
    case "minutes":
      return `${bucket.value}m ago`;
    case "hours":
      return `${bucket.value}h ago`;
    case "days":
      return `${bucket.value}d ago`;
  }
};

/** A playback position as m:ss / h:mm:ss (phone, TV and web player); anything not a finite, non-negative number reads 0:00. */
export const formatClock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
