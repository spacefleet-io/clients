/** A track number heading a title tag: `02. `, `02 - `, `2) `, `002 ` (a space alone only after a padded number). */
const TITLE_NUMBER = /^(\d{1,3})(?:\s*[.)]\s*|\s+[-\u2013\u2014_:]\s+|(?<=^0\d*)(?:\s+|[-_]))(?=\D)(\S.*)$/u;

/**
 * Takes a track number out of the front of a title tag (PAR-META-21): `02. Wildfire` → title `Wildfire`, number 2.
 * The number becomes the song's when its track-number tag is missing (`tagNumber` 0 or absent); a tag that disagrees
 * keeps its own number, and the title is cleaned either way. A title that is only a number (`1999`) or starts with one
 * that belongs to it (`99 Luftballons`, `7 Seconds`, `2.0`, `3 - 2 - 1`) stays as it is.
 */
export const splitTitleTrackNumber = (title: string, tagNumber?: number | null): { title: string; number: number | null } => {
  const tagged = tagNumber && tagNumber > 0 ? tagNumber : null;
  const lead = TITLE_NUMBER.exec(title.trim());
  if (!lead) return { title, number: tagged };
  const prefix = Number(lead[1]);
  return { title: lead[2]!.trim(), number: tagged ?? (prefix > 0 ? prefix : null) };
};
