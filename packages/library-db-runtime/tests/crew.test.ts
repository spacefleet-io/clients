/**
 * @req LIB-CREW-01
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { crewLines, crewPeople, pickLibraryCrew } from "@space/shared/libraryCrew";
import { MEDIA_CREW_DDL } from "@space/library-db-definition/crewDdl";
import { readMediaDetailsSync } from "@space/library-db-definition/mediaDetails";

const log = (phase: string, data?: unknown) => console.log(`[crew.test] ${phase}`, data ?? "");

test("pickLibraryCrew keeps director and writers, directors first, deduped", () => {
  const picked = pickLibraryCrew([
    { personId: 2, name: "Writer A", job: "Screenplay" },
    { personId: 1, name: "Director A", job: "Director" },
    { personId: 1, name: "Director A", job: "Director" },
    { personId: 3, name: "Editor", job: "Editor" },
  ]);
  log("picked", picked);
  expect(picked.map((member) => `${member.job}:${member.name}`)).toEqual(["Director:Director A", "Screenplay:Writer A"]);
});

test("crewLines labels directors then writing, each name once, and leaves out an empty group", () => {
  const labels = { director: "Director", writing: "Writing" };
  const lines = crewLines(
    [
      { name: "Writer A", job: "Screenplay" },
      { name: "Director A", job: "Director" },
      { name: "Writer A", job: "Writer" },
      { name: "Writer B", job: "Writer" },
    ],
    labels
  );
  log("lines", lines);
  expect(lines).toEqual([
    { key: "director", label: "Director", names: ["Director A"] },
    { key: "writing", label: "Writing", names: ["Writer A", "Writer B"] },
  ]);
  expect(crewLines([{ name: "Writer A", job: "Screenplay" }], labels).map((line) => line.key)).toEqual(["writing"]);
  expect(crewLines(undefined, labels)).toEqual([]);
});

test("crewPeople puts directors first, then writers, one entry per person and group", () => {
  const people = crewPeople([
    { personId: "w1", name: "Writer A", job: "Screenplay" },
    { personId: "d1", name: "Director A", job: "Director" },
    { personId: "w1", name: "Writer A", job: "Writer" },
    { personId: "d1", name: "Director A", job: "Screenplay" },
  ]);
  log("people", people);
  expect(people.map((person) => `${person.group}:${person.name}`)).toEqual([
    "director:Director A",
    "writing:Writer A",
    "writing:Director A",
  ]);
});

test("media details read crew, and a database without media_crew reads no crew", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE media_items (id TEXT PRIMARY KEY, type TEXT, title TEXT, added_at TEXT, updated_at TEXT, has_files INTEGER)");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, profile_path TEXT)");
  db.run("CREATE TABLE people_external_ids (id TEXT, person_id TEXT, source TEXT, external_id TEXT)");
  db.run("INSERT INTO media_items VALUES ('m1', 'movie', 'Film', 'x', 'x', 0)");
  const run = (query: { sql: string; params: unknown[] }) => {
    try {
      return db.query(query.sql).all(...(query.params as string[])) as Record<string, unknown>[];
    } catch (error) {
      // Tables this minimal fixture leaves out read as empty; media_crew must not.
      if (query.sql.includes("media_crew")) throw error;
      return [];
    }
  };
  log("phase: before table", readMediaDetailsSync(run, "m1")?.crew);
  expect(readMediaDetailsSync(run, "m1")?.crew).toEqual([]);

  for (const ddl of MEDIA_CREW_DDL) db.run(ddl);
  db.run("INSERT INTO people VALUES ('p1', 'Jane Director', NULL)");
  db.run("INSERT INTO people_external_ids VALUES ('e1', 'p1', 'catalog', '42')");
  db.run("INSERT INTO media_crew VALUES ('c1', 'm1', 'p1', 'Director', 0)");
  const crew = readMediaDetailsSync(run, "m1")?.crew;
  log("phase: after table", crew);
  expect(crew).toEqual([{ id: "c1", personId: "p1", catalogId: 42, name: "Jane Director", job: "Director", profilePath: null }]);
});
