/**
 * Parrot count strings take the right plural form in each language: "Reading 1 of 1 song…" / "Reading 1 of 2 songs…",
 * "1 fichier illisible" / "2 fichiers illisibles". The real string tables and the real plural rule go through here.
 */
import { describe, expect, it } from "vitest";
import type { ParrotImportStatus, ParrotLanguage } from "../src/shared/ipc";
import { pluralForm, translator } from "../src/renderer/src/i18n";
import { importLine } from "../src/renderer/src/ImportJobs";

const SUITE = "parrot-count-plurals";

const scanning = (total: number): ParrotImportStatus => ({
  running: true,
  phase: "scanning",
  total,
  done: 1,
  imported: 0,
  skipped: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  published: 0,
  currentFile: null,
  error: null,
});

const scanLine = (language: ParrotLanguage, total: number): string | null => {
  const line = importLine(translator(language), language, scanning(total));
  console.info(`[${SUITE}:scan-${language}-${total}] ${line}`);
  return line;
};

const unreadable = (language: ParrotLanguage, n: number): string => {
  const line = translator(language)(`import.review.unreadable.${pluralForm(language, n)}`, { n });
  console.info(`[${SUITE}:unreadable-${language}-${n}] ${line}`);
  return line;
};

describe("Parrot count strings", () => {
  it("the scan line agrees with the total in English and French", () => {
    expect(scanLine("en", 1)).toBe("Reading 1 of 1 song…");
    expect(scanLine("en", 2)).toBe("Reading 1 of 2 songs…");
    expect(scanLine("fr", 1)).toBe("Lecture de 1 sur 1 morceau…");
    expect(scanLine("fr", 2)).toBe("Lecture de 1 sur 2 morceaux…");
  });

  it("the unreadable-files line agrees with its count in English and French", () => {
    expect(unreadable("en", 1)).toBe("1 file could not be read and is left out");
    expect(unreadable("en", 2)).toBe("2 files could not be read and are left out");
    expect(unreadable("fr", 1)).toBe("1 fichier illisible, laissé de côté");
    expect(unreadable("fr", 2)).toBe("2 fichiers illisibles, laissés de côté");
  });
});
