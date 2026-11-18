import type { MediaCrewDraft } from "./libraryTypes";

/**
 * LIB-CREW-01: the crew jobs a library keeps, in the order the detail page lists them. The other jobs (Story,
 * Novel, Producer, Editor…) are not kept.
 */
export const LIBRARY_CREW_JOBS = ["Director", "Screenplay", "Writer"] as const;

export type LibraryCrewJob = (typeof LIBRARY_CREW_JOBS)[number];

/** Credits per job; a writing room of twenty does not belong on a detail page. */
const MAX_PER_JOB = 4;

const jobRank = (job: string | null | undefined) => LIBRARY_CREW_JOBS.indexOf(job as LibraryCrewJob);

/**
 * The crew to store for a title from the metadata service's credits: kept jobs only, one credit per person and job,
 * at most `MAX_PER_JOB` per job, directors first. The service's order is kept within a job.
 */
export const pickLibraryCrew = (
  crew: ReadonlyArray<{ personId?: number | null; name?: string | null; job?: string | null; profilePath?: string | null }>
): MediaCrewDraft[] => {
  const seen = new Set<string>();
  const perJob = new Map<string, number>();
  const picked: MediaCrewDraft[] = [];
  for (const member of crew) {
    const name = member.name?.trim() ?? "";
    const job = member.job ?? null;
    if (!name || jobRank(job) < 0) continue;
    const key = `${member.personId ?? name}:${job}`;
    if (seen.has(key)) continue;
    const count = perJob.get(job as string) ?? 0;
    if (count >= MAX_PER_JOB) continue;
    seen.add(key);
    perJob.set(job as string, count + 1);
    picked.push({ catalogId: member.personId ?? null, name, job, profilePath: member.profilePath ?? null });
  }
  return picked.sort((a, b) => jobRank(a.job) - jobRank(b.job));
};

/** The detail page's crew lines: directors, then writers (Screenplay and Writer together), each name once. */
export const crewGroups = (
  crew: ReadonlyArray<{ name: string; job: string | null }> | undefined
): { director: string[]; writing: string[] } => {
  const namesOf = (keep: (job: string | null) => boolean) => [
    ...new Set((crew ?? []).filter((member) => keep(member.job)).map((member) => member.name)),
  ];
  return { director: namesOf((job) => job === "Director"), writing: namesOf((job) => job !== "Director") };
};

/**
 * The detail page's crew as labelled lines (directors, then writing), leaving out a group with nobody. Every Badger
 * app shows these lines with its own translated labels.
 */
export const crewLines = (
  crew: ReadonlyArray<{ name: string; job: string | null }> | undefined,
  labels: { director: string; writing: string }
): Array<{ key: "director" | "writing"; label: string; names: string[] }> => {
  const groups = crewGroups(crew);
  return (["director", "writing"] as const)
    .map((key) => ({ key, label: labels[key], names: groups[key] }))
    .filter((line) => line.names.length > 0);
};

/**
 * The crew as people, for a page that shows faces (the TV's Cast & crew tab): directors first, then writers, one entry
 * per person and group, keeping the stored order within a group.
 */
export const crewPeople = <T extends { personId: string; name: string; job: string | null }>(
  crew: ReadonlyArray<T> | undefined
): Array<T & { group: "director" | "writing" }> => {
  const seen = new Set<string>();
  const people: Array<T & { group: "director" | "writing" }> = [];
  for (const group of ["director", "writing"] as const) {
    for (const member of crew ?? []) {
      if ((member.job === "Director") !== (group === "director")) continue;
      const key = `${group}:${member.personId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({ ...member, group });
    }
  }
  return people;
};
