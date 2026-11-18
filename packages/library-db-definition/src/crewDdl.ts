/**
 * LIB-CREW-01: the `media_crew` table (a title's director and writers). Part of the metadata baseline for new
 * libraries, and the registered metadata migration step that adds it to existing ones (desktop and phone).
 */
export const MEDIA_CREW_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_crew (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    job TEXT NOT NULL,
    order_index INTEGER
  );`,
  `CREATE INDEX IF NOT EXISTS media_crew_media_id_idx ON media_crew(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_crew_person_id_idx ON media_crew(person_id);`,
];
