import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bucketRelativeTime,
  formatRating,
  formatStarRating,
  formatClock,
  formatRelativeTimeEnglish,
  formatStorageBytes,
  formatStorageUsage,
  formatLocalizedStorage,
  formatLocalizedStorageUsage,
  getStorageUnitBase,
  localizedDecimal,
  localizedStorageSize,
  localizedStorageUsage,
  planGbToBytes,
  setStorageUnitBase,
  storageUnitBaseFor,
  storageUnitBaseFromUserAgent,
  storageUnitName,
  storageUsedPercent,
  type StorageUnitBase,
} from "../src/format";

// The storage cases below are written in 1024-based units (Windows Explorer, KDE Dolphin); STOR-UNIT-01 has the 1000 ones.
beforeEach(() => setStorageUnitBase(1024));
afterEach(() => setStorageUnitBase(1000));

// Dump-on-failure helper: on a formatting mismatch, surface the raw input, the
// expected string and what the formatter actually produced so a CI failure is
// diagnosable from the log alone (no local repro needed). Wrapped in try/catch
// so a dump failure can never mask the real assertion failure.
const dumpFormatSnapshot = (
  label: string,
  input: unknown,
  expected: unknown,
  actual: unknown,
) => {
  try {
    console.error(`=== [format:${label}] format mismatch snapshot ===`);
    console.error(`input=${JSON.stringify(input)}`);
    console.error(`expected=${JSON.stringify(expected)}`);
    console.error(`actual=${JSON.stringify(actual)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert a formatter output and, when it diverges, emit the diagnostic snapshot
// before re-throwing the original assertion error.
const expectFormat = (label: string, input: unknown, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    dumpFormatSnapshot(label, input, expected, actual);
  }
  expect(actual).toBe(expected);
};

describe("formatStorageBytes", () => {
  it("renders 0 bytes as bytes", () => {
    console.info(`[format:storage-bytes-zero] formatting 0 bytes`);
    expectFormat("storage-bytes-zero", 0, formatStorageBytes(0), "0 B");
  });

  it("renders KB when below 1 MiB", () => {
    console.info(`[format:storage-bytes-kb] formatting 1024 and ${1024 * 512} bytes`);
    expectFormat("storage-bytes-kb", 1024, formatStorageBytes(1024), "1.0 KB");
    expectFormat("storage-bytes-kb", 1024 * 512, formatStorageBytes(1024 * 512), "512.0 KB");
  });

  it("renders MB", () => {
    const bytes = 1024 * 1024 * 5;
    console.info(`[format:storage-bytes-mb] formatting ${bytes} bytes`);
    expectFormat("storage-bytes-mb", bytes, formatStorageBytes(bytes), "5.0 MB");
  });

  it("renders GB with one decimal", () => {
    const fiveSevenGB = Math.round(5.7 * 1024 * 1024 * 1024);
    console.info(`[format:storage-bytes-gb] formatting ${fiveSevenGB} bytes`);
    expectFormat("storage-bytes-gb", fiveSevenGB, formatStorageBytes(fiveSevenGB), "5.7 GB");
  });

  it("renders TB with two decimals", () => {
    const oneAndHalfTB = Math.round(1.5 * 1024 * 1024 * 1024 * 1024);
    console.info(`[format:storage-bytes-tb] formatting ${oneAndHalfTB} bytes`);
    expectFormat("storage-bytes-tb", oneAndHalfTB, formatStorageBytes(oneAndHalfTB), "1.50 TB");
  });

  it("treats negative values consistently", () => {
    console.info(`[format:storage-bytes-negative] formatting -1024 bytes`);
    expectFormat("storage-bytes-negative", -1024, formatStorageBytes(-1024), "-1.0 KB");
  });

  it("falls back to 0 for non-finite input", () => {
    console.info(`[format:storage-bytes-nonfinite] formatting NaN and +Infinity`);
    expectFormat("storage-bytes-nonfinite", Number.NaN, formatStorageBytes(Number.NaN), "0 B");
    expectFormat(
      "storage-bytes-nonfinite",
      Number.POSITIVE_INFINITY,
      formatStorageBytes(Number.POSITIVE_INFINITY),
      "0 B",
    );
  });
});

describe("localizedStorageSize", () => {
  it("[MOBILE-STORAGE-DECIMAL-001] writes the number the way the language does and keeps the unit apart", () => {
    const twentyGb = 20 * 1024 ** 3;
    const cases = [
      [localizedStorageSize(twentyGb, "en"), { value: "20.0", unit: "GB" }],
      [localizedStorageSize(twentyGb, "fr"), { value: "20,0", unit: "GB" }],
      [localizedStorageSize(twentyGb, "de"), { value: "20,0", unit: "GB" }],
      [localizedStorageSize(67 * 1024 ** 2, "fr", { minUnit: "MB", maxUnit: "GB" }), { value: "67", unit: "MB" }],
      [localizedStorageSize(1500 * 1024 ** 3, "nl", { maxUnit: "GB" }), { value: "1500,0", unit: "GB" }],
      [localizedStorageSize(0, "en", { minUnit: "MB" }), { value: "0", unit: "MB" }],
      [localizedStorageSize(Number.NaN, "en"), { value: "0", unit: "B" }],
    ] as const;
    for (const [got, want] of cases) {
      console.info("[MOBILE-STORAGE-DECIMAL-001] localizedStorageSize", { got, want });
      expect(got).toEqual(want);
    }
  });
});

// @req STOR-UNIT-02[web]
describe("STOR-UNIT-02 storage figures in the interface language", () => {
  it("[STOR-UNIT-02-TEXT] writes the number and the unit the way each of the 5 languages does", () => {
    const usedBytes = 3.2 * 1000 ** 3;
    const limitBytes = 20 * 1000 ** 3;
    const want = {
      en: ["3.2 GB", "20.0 GB", "800 MB", "1.5 TB", "0 B"],
      fr: ["3,2 Go", "20,0 Go", "800 Mo", "1,5 To", "0 o"],
      nl: ["3,2 GB", "20,0 GB", "800 MB", "1,5 TB", "0 B"],
      de: ["3,2 GB", "20,0 GB", "800 MB", "1,5 TB", "0 B"],
      es: ["3,2 GB", "20,0 GB", "800 MB", "1,5 TB", "0 B"],
    };
    for (const [lang, [used, limit, mb, tb, zero]] of Object.entries(want)) {
      const pair = formatLocalizedStorageUsage(usedBytes, limitBytes, lang, { base: 1000 });
      const got = [pair.used, pair.limit, formatLocalizedStorage(800 * 1000 ** 2, lang, { base: 1000 }), formatLocalizedStorage(1.5 * 1000 ** 4, lang, { base: 1000 }), formatLocalizedStorage(0, lang, { base: 1000 })];
      console.info("[STOR-UNIT-02-TEXT]", lang, got);
      expect(got).toEqual([used, limit, mb, tb, zero]);
    }
    expect([storageUnitName("GB", "fr-FR"), storageUnitName("MB", "FR"), storageUnitName("GB", "en-GB")]).toEqual(["Go", "Mo", "GB"]);
  });

  it("[STOR-UNIT-02-PAIR] a figure one megabyte short of its limit never reads as the limit, in French too", () => {
    const limitBytes = 20 * 1000 ** 3;
    const { used, limit } = formatLocalizedStorageUsage(limitBytes - 1000 ** 2, limitBytes, "fr", { base: 1000 });
    console.info("[STOR-UNIT-02-PAIR]", used, limit);
    expect(used).not.toBe(limit);
    expect(limit).toMatch(/^20,0+ Go$/u);
    expect(used).toMatch(/^19,9+ Go$/u);
  });
});

/** Parses "107.4 GB" / "107,4 Go"-style figures back to the bytes they stand for, in `base`. */
const shownBytes = (value: string, unit: string, base: StorageUnitBase) =>
  Number(value.replace(",", ".")) * base ** ["B", "KB", "MB", "GB", "TB"].indexOf(unit);
const parsePlain = (text: string, base: StorageUnitBase) => {
  const [value, unit] = text.split(" ");
  return shownBytes(value, unit, base);
};

// @req STOR-UNIT-01[web]
describe("STOR-UNIT-01 storage units follow the device's file manager", () => {
  it("[STOR-UNIT-01-BASE] picks 1024 for Windows and KDE, 1000 for macOS, iOS, Android, GNOME and unknown desktops", () => {
    const cases: [string, string | undefined, StorageUnitBase][] = [
      ["windows", undefined, 1024],
      ["linux", "KDE", 1024],
      ["linux", "ubuntu:KDE", 1024],
      ["linux", "GNOME", 1000],
      ["linux", "ubuntu:GNOME", 1000],
      ["linux", undefined, 1000],
      ["macos", undefined, 1000],
      ["ios", undefined, 1000],
      ["android", undefined, 1000],
    ];
    for (const [os, desktop, want] of cases) {
      console.info("[STOR-UNIT-01-BASE] storageUnitBaseFor", { os, desktop, got: storageUnitBaseFor(os, desktop), want });
      expect(storageUnitBaseFor(os, desktop)).toBe(want);
    }
    const uas: [string, StorageUnitBase][] = [
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", 1024],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15", 1000],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", 1000],
      ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36", 1000],
    ];
    for (const [ua, want] of uas) {
      console.info("[STOR-UNIT-01-BASE] storageUnitBaseFromUserAgent", { ua, got: storageUnitBaseFromUserAgent(ua), want });
      expect(storageUnitBaseFromUserAgent(ua)).toBe(want);
    }
  });

  it("[STOR-UNIT-01-FORMAT] a file reads the size its computer shows, and the set base is the default", () => {
    const file = 4_700_000_000; // a "4.7 GB" film as macOS Finder shows it; Windows Explorer shows 4.4 GB
    const cases: [StorageUnitBase, string, string][] = [
      [1000, "4.7 GB", "107.4 GB"],
      [1024, "4.4 GB", "100.0 GB"],
    ];
    for (const [base, fileText, planText] of cases) {
      setStorageUnitBase(base);
      const got = { file: formatStorageBytes(file), plan: formatStorageBytes(planGbToBytes(100)), base: getStorageUnitBase() };
      console.info("[STOR-UNIT-01-FORMAT]", { base, got });
      expect(got).toEqual({ file: fileText, plan: planText, base });
    }
  });

  it("[STOR-UNIT-01-ROLLOVER] a size that rounds up to the next unit is written in it, never as 1000.0 of the smaller one", () => {
    const cases: [StorageUnitBase, number, string][] = [
      [1000, 999_960_000_000, "1.00 TB"],
      [1024, 1024 ** 4 - 1024 ** 2, "1.00 TB"],
      [1000, 999_960, "1.0 MB"],
    ];
    for (const [base, bytes, want] of cases) {
      console.info("[STOR-UNIT-01-ROLLOVER]", { base, bytes, got: formatStorageBytes(bytes, base), want });
      expect(formatStorageBytes(bytes, base)).toBe(want);
    }
  });

  // Concern, Chris 2026-11-16: a user must never be blocked while the screen shows usage below the limit.
  for (const base of [1000, 1024] as const) {
    it(`[STOR-UNIT-01-NEVER-BLOCKED-${base}] at the limit usage reads equal to it, below it lower, above it higher`, () => {
      const limits = [planGbToBytes(20), planGbToBytes(100), planGbToBytes(1000), planGbToBytes(2000), 5 * 1024 ** 2];
      const gaps = [1, 1000, 1024 ** 2, 10 ** 6, 49 * 10 ** 6, 10 ** 9, 7 * 1024 ** 3];
      for (const limit of limits) {
        const atLimit = formatStorageUsage(limit, limit, base);
        console.info(`[STOR-UNIT-01-NEVER-BLOCKED-${base}] at limit`, { limitBytes: limit, shown: atLimit });
        expect(atLimit.used).toBe(atLimit.limit);
        expect(formatStorageUsage(limit, limit, base).limit).toBe(formatStorageBytes(limit, base));
        for (const gap of gaps.filter((g) => g < limit)) {
          const below = formatStorageUsage(limit - gap, limit, base);
          const above = formatStorageUsage(limit + gap, limit, base);
          console.info(`[STOR-UNIT-01-NEVER-BLOCKED-${base}]`, { limit, gap, below, above });
          expect(parsePlain(below.used, base)).toBeLessThan(parsePlain(below.limit, base));
          expect(parsePlain(above.used, base)).toBeGreaterThan(parsePlain(above.limit, base));
          for (const [lang, used, lim] of [
            ["en", limit - gap, limit],
            ["fr", limit - gap, limit],
          ] as const) {
            const pair = localizedStorageUsage(used, lim, lang, { minUnit: "MB", maxUnit: "GB", base });
            expect(shownBytes(pair.used.value, pair.used.unit, base)).toBeLessThan(shownBytes(pair.limit.value, pair.limit.unit, base));
          }
          const localAt = localizedStorageUsage(limit, limit, "fr", { minUnit: "MB", maxUnit: "GB", base });
          expect(localAt.used).toEqual(localAt.limit);
        }
      }
    });
  }

  it("[STOR-UNIT-01-PAIR-PLAIN] a pair far from a tie keeps the usual decimals", () => {
    const got = formatStorageUsage(31.9 * 10 ** 9, planGbToBytes(100), 1000);
    console.info("[STOR-UNIT-01-PAIR-PLAIN]", got);
    expect(got).toEqual({ used: "31.9 GB", limit: "107.4 GB" });
  });

  it("[STOR-UNIT-01-PERCENT] the percentage rounds down: 100% only once the stored bytes reach the limit", () => {
    const limit = planGbToBytes(100);
    const got = {
      belowByOneByte: storageUsedPercent(limit - 1, limit),
      belowByOneByteOneDecimal: storageUsedPercent(limit - 1, limit, 1),
      atLimit: storageUsedPercent(limit, limit),
      above: storageUsedPercent(limit + 1, limit),
      halfAndABit: storageUsedPercent(limit * 0.5059, limit),
      empty: storageUsedPercent(0, limit),
      negative: storageUsedPercent(-5, limit),
      noRoom: storageUsedPercent(0, 0),
    };
    console.info("[STOR-UNIT-01-PERCENT]", got);
    expect(got).toEqual({
      belowByOneByte: 99,
      belowByOneByteOneDecimal: 99.9,
      atLimit: 100,
      above: 100,
      halfAndABit: 50,
      empty: 0,
      negative: 0,
      noRoom: 100,
    });
  });
});

// Dump-on-failure for relative-time bucketing: surface the input ISO, the
// reference `now`, the resolved offset (now - iso) and the actual bucket so a
// threshold-boundary regression is diagnosable from the log alone.
const dumpBucketSnapshot = (
  label: string,
  input: string | null | undefined,
  now: number,
  actual: unknown,
) => {
  try {
    const parsed = typeof input === "string" ? Date.parse(input) : Number.NaN;
    const offsetMs = Number.isFinite(parsed) ? now - parsed : null;
    console.error(`=== [format:${label}] bucket snapshot ===`);
    console.error(`input=${JSON.stringify(input)} now=${now} (${new Date(now).toISOString()})`);
    console.error(`parsedInputMs=${Number.isFinite(parsed) ? parsed : "NaN"} offsetMs=${offsetMs}`);
    console.error(`actual=${JSON.stringify(actual)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("bucketRelativeTime", () => {
  const now = new Date("2026-05-08T12:00:00.000Z").getTime();

  it("returns null for null/empty input", () => {
    console.info(`[format:bucket-null-input] bucketing null/undefined/empty`);
    for (const input of [null, undefined, ""] as const) {
      const actual = bucketRelativeTime(input, now);
      if (actual !== null) dumpBucketSnapshot("bucket-null-input", input, now, actual);
      expect(actual).toBeNull();
    }
  });

  it("returns null for invalid ISO", () => {
    console.info(`[format:bucket-invalid-iso] bucketing "not-a-date"`);
    const actual = bucketRelativeTime("not-a-date", now);
    if (actual !== null) dumpBucketSnapshot("bucket-invalid-iso", "not-a-date", now, actual);
    expect(actual).toBeNull();
  });

  it("returns just_now for under 5 seconds", () => {
    const iso = new Date(now - 2_000).toISOString();
    console.info(`[format:bucket-just-now] bucketing ${iso} (offset 2s)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "just_now", value: 0 });
    } catch (err) {
      dumpBucketSnapshot("bucket-just-now", iso, now, actual);
      throw err;
    }
  });

  it("buckets seconds", () => {
    const iso = new Date(now - 30_000).toISOString();
    console.info(`[format:bucket-seconds] bucketing ${iso} (offset 30s)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "seconds", value: 30 });
    } catch (err) {
      dumpBucketSnapshot("bucket-seconds", iso, now, actual);
      throw err;
    }
  });

  it("buckets minutes", () => {
    const iso = new Date(now - 5 * 60_000).toISOString();
    console.info(`[format:bucket-minutes] bucketing ${iso} (offset 5m)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "minutes", value: 5 });
    } catch (err) {
      dumpBucketSnapshot("bucket-minutes", iso, now, actual);
      throw err;
    }
  });

  it("buckets hours", () => {
    const iso = new Date(now - 3 * 60 * 60_000).toISOString();
    console.info(`[format:bucket-hours] bucketing ${iso} (offset 3h)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "hours", value: 3 });
    } catch (err) {
      dumpBucketSnapshot("bucket-hours", iso, now, actual);
      throw err;
    }
  });

  it("buckets days", () => {
    const iso = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
    console.info(`[format:bucket-days] bucketing ${iso} (offset 2d)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "days", value: 2 });
    } catch (err) {
      dumpBucketSnapshot("bucket-days", iso, now, actual);
      throw err;
    }
  });

  it("never returns negative durations for clock skew", () => {
    const iso = new Date(now + 60_000).toISOString();
    console.info(`[format:bucket-clock-skew] bucketing ${iso} (future offset +60s)`);
    const actual = bucketRelativeTime(iso, now);
    try {
      expect(actual).toEqual({ unit: "just_now", value: 0 });
    } catch (err) {
      dumpBucketSnapshot("bucket-clock-skew", iso, now, actual);
      throw err;
    }
  });
});

describe("formatRelativeTimeEnglish", () => {
  const now = new Date("2026-05-08T12:00:00.000Z").getTime();

  it("returns em-dash for null", () => {
    console.info(`[format:relative-english-null] formatting null`);
    expectFormat("relative-english-null", null, formatRelativeTimeEnglish(null, now), "—");
  });

  it("returns 'just now' for < 5s", () => {
    const iso = new Date(now - 1_000).toISOString();
    console.info(`[format:relative-english-just-now] formatting ${iso} (offset 1s)`);
    expectFormat(
      "relative-english-just-now",
      iso,
      formatRelativeTimeEnglish(iso, now),
      "just now",
    );
  });

  it("renders minutes", () => {
    const iso = new Date(now - 7 * 60_000).toISOString();
    console.info(`[format:relative-english-minutes] formatting ${iso} (offset 7m)`);
    expectFormat("relative-english-minutes", iso, formatRelativeTimeEnglish(iso, now), "7m ago");
  });
});

describe("formatClock", () => {
  it("shows m:ss under an hour and h:mm:ss from an hour", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
  });
  it("shows 0:00 for a negative or unknown time", () => {
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("localizedDecimal / formatRating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the decimals the way the locale writes them (UX-I18N-01)", () => {
    expect(formatRating(7.5, "en")).toBe("7.5");
    expect(formatRating(7.5, "fr")).toBe("7,5");
    expect(formatRating(7.5, "de")).toBe("7,5");
    expect(formatRating(7, "nl")).toBe("7,0");
    expect(formatStarRating(8.25, "en")).toBe("★ 8.3");
    expect(localizedDecimal(1234.567, "en", 2)).toBe("1234.57");
    expect(localizedDecimal(1234.567, "de", 0)).toBe("1235");
    expect(localizedDecimal(Number.NaN, "en", 1)).toBe("0.0");
    expect(localizedDecimal(Number.POSITIVE_INFINITY, "fr", 2)).toBe("0,00");
  });

  it("[@bugfix #2461][@regression-proof] reuses one formatter per locale instead of building one per call", () => {
    // A Home page re-rendering every poster card on each ingest progress tick called
    // `toLocaleString(locale, options)` per card, which builds a fresh ICU formatter each time
    // (~400 ms self time in a 30 s renderer profile during peak ingest).
    const toLocaleString = vi.spyOn(Number.prototype, "toLocaleString");
    const NumberFormat = Intl.NumberFormat;
    let constructed = 0;
    vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.NumberFormat>
    ) {
      constructed += 1;
      return new NumberFormat(...args);
    } as unknown as typeof Intl.NumberFormat);
    const outputs = new Set<string>();
    for (let i = 0; i < 200; i += 1) outputs.add(formatRating(6.4, "en-GB"));
    console.info(
      `[#2461:formatter-reuse] calls=200 toLocaleString=${toLocaleString.mock.calls.length} NumberFormat=${constructed} outputs=${JSON.stringify([...outputs])}`,
    );
    expect([...outputs]).toEqual(["6.4"]);
    expect(toLocaleString).not.toHaveBeenCalled();
    expect(constructed).toBeLessThanOrEqual(1);
  });
});
