import { formatLocalizedStorage, storageUnitName } from "@space/shared/format";

/**
 * A media size as the dialogs show it, "850 MB" / "2.3 GB" in English, "850 Mo" / "2,3 Go" in French: the shared
 * `formatLocalizedStorage` from MB to GB, in the device's base (STOR-UNIT-01) and the interface language (STOR-UNIT-02).
 */
export const mediaSizeLabel = (bytes: number, locale: string): string =>
  formatLocalizedStorage(bytes, locale, { minUnit: "MB", maxUnit: "GB" });

/**
 * A plan catalogue size ("Scale (1500 GB)" in Settings → Account and the import window's offer), not a measured figure
 * (STOR-UNIT-01 leaves the number alone), written with the interface language's unit name ("1500 Go" in French, STOR-UNIT-02).
 */
export const planSizeLabel = (gb: number, locale: string): string =>
  `${gb.toLocaleString(locale, { useGrouping: false })} ${storageUnitName("GB", locale)}`;

/** Bytes in one MB of an ingest estimate (`sizeMb`, `estimateSizeMb`): estimates are counted in 1024² bytes. */
export const ESTIMATE_MB_BYTES = 1024 ** 2;
