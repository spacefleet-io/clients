/**
 * @test-id PARROT-DESKTOP-IMPORT-ENGINE-001
 * @level unit (main's pure helpers around the import job engine: the resume record, which import resumes at start,
 *   and the per-song rows the Jobs panel shows)
 * @why PAR-UP-13 / RT-LIFE-04: an import cut short by Parrot closing resumes at the next start from its jobs, so main
 *   keeps what the review decided (the edits, the chosen pictures) next to them; and UX-JOBS-02: the Jobs panel shows
 *   one bucket per song with its upload and its light copy, each with its place in line.
 */
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { ParrotImportEdit } from "@space/parrot-ingest";
import { describe, expect, it } from "vitest";
import { importResumeRecord, importSongRows, readImportResume, resumePlan } from "../src/main/importJobs";

const SUITE = "[parrot-import-engine]";

const job = (patch: Partial<IngestJobRecord> & { index: number; importId?: string; userId?: string }): IngestJobRecord => {
  const { index, importId = "imp-1", userId = "u1", ...rest } = patch;
  return {
    jobId: `${importId}-${rest.kind ?? "source"}-${index}`,
    app: "parrot",
    kind: "source",
    lane: "source",
    status: "queued",
    stageCode: "queued",
    progressPct: 0,
    errorMessage: null,
    createdAt: `2026-11-26T01:00:0${index % 10}.000Z`,
    groupId: importId,
    payload: { userId, importId, file: `/music/${index}.m4a`, index },
    ...rest,
  } as IngestJobRecord;
};

const edit = (title: string, coverPicture?: string): ParrotImportEdit => ({ artist: "Artie Shaw", album: "Dancing on the Ceiling", title, coverPicture });

describe("PARROT-DESKTOP-IMPORT-ENGINE-001 import resume and rows", () => {
  // @req PAR-UP-13
  it("keeps the review's decisions for a resume, with only the pictures an edit chose", () => {
    const record = importResumeRecord({
      importId: "imp-1",
      userId: "u1",
      files: ["/music/1.m4a", "/music/2.m4a"],
      edits: new Map([
        ["/music/1.m4a", edit("Begin the Beguine", "pic-a")],
        ["/music/2.m4a", edit("Frenesi")],
      ]),
      folders: ["/music"],
      unreadable: [{ file: "/music/bad.m4a", error: "no tags" }],
      pictures: new Map([
        ["pic-a", { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }],
        ["pic-b", { bytes: new Uint8Array([9]), mime: "image/jpeg" }],
      ]),
    });
    console.info(SUITE, "record pictures", Object.keys(record.pictures));
    expect(Object.keys(record.pictures)).toEqual(["pic-a"]);
    const back = readImportResume(JSON.parse(JSON.stringify(record)));
    expect(back?.importId).toBe("imp-1");
    expect(back?.files).toEqual(["/music/1.m4a", "/music/2.m4a"]);
    expect(back?.edits.get("/music/2.m4a")?.title).toBe("Frenesi");
    expect(back?.folders).toEqual(["/music"]);
    expect(back?.unreadable).toEqual([{ file: "/music/bad.m4a", error: "no tags" }]);
    expect([...(back?.pictures.get("pic-a")?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(readImportResume({ version: 2 })).toBeNull();
    expect(readImportResume(null)).toBeNull();
  });

  // @req PAR-UP-13
  it("resumes the newest unfinished import of this account that has its record, and drops the others", () => {
    const jobs = [
      job({ index: 0, importId: "old", status: "queued", createdAt: "2026-11-25T10:00:00.000Z" }),
      job({ index: 0, importId: "new", status: "succeeded", createdAt: "2026-11-26T10:00:00.000Z" }),
      job({ index: 1, importId: "new", status: "running", createdAt: "2026-11-26T10:00:00.000Z" }),
      job({ index: 0, importId: "done", status: "succeeded" }),
      job({ index: 0, importId: "other", userId: "u2", status: "queued" }),
      job({ index: 0, importId: "badger", app: "badger", status: "queued" }),
    ];
    const plan = resumePlan(jobs, "u1", (importId) => importId !== "missing");
    console.info(SUITE, "plan", { resume: plan.resume?.importId, drop: plan.drop.map((one) => one.jobId) });
    expect(plan.resume?.importId).toBe("new");
    expect(plan.resume?.jobs.map((one) => one.jobId)).toEqual(["new-source-0", "new-source-1"]);
    expect(plan.drop.map((one) => one.jobId)).toEqual(["old-source-0"]);

    const noRecord = resumePlan(jobs, "u1", (importId) => importId === "nothing");
    expect(noRecord.resume).toBeNull();
    expect(noRecord.drop.map((one) => one.jobId).sort()).toEqual(["new-source-1", "old-source-0"]);
  });

  // @req UX-JOBS-02[parrot]
  it("shows one bucket per song with its upload and light copy, each with its place in line", () => {
    const rows = importSongRows([
      job({ index: 2, status: "queued" }),
      job({ index: 0, status: "succeeded", stageCode: "commit", progressPct: 100 }),
      job({ index: 1, status: "running", stageCode: "upload", progressPct: 40 }),
      job({ index: 3, status: "queued" }),
      job({ index: 0, kind: "format", lane: "format", status: "running", stageCode: "transcode", variant: "light" }),
      job({ index: 1, kind: "format", lane: "format", status: "queued" }),
      job({ index: 3, kind: "format", lane: "format", status: "failed", errorMessage: "encoder gone" }),
    ]);
    console.info(SUITE, "rows", JSON.stringify(rows.map((song) => [song.file, song.source.placeInLine, song.light?.placeInLine ?? null])));
    expect(rows.map((song) => song.file)).toEqual(["/music/0.m4a", "/music/1.m4a", "/music/2.m4a", "/music/3.m4a"]);
    expect(rows[0]!.source).toMatchObject({ status: "succeeded", stage: "commit", progressPct: 100, placeInLine: null });
    expect(rows[0]!.light).toMatchObject({ status: "running", stage: "transcode", placeInLine: null });
    expect(rows[1]!.source).toMatchObject({ status: "running", stage: "upload", progressPct: 40 });
    expect(rows[1]!.light?.placeInLine).toBe(1);
    expect(rows[2]!.source.placeInLine).toBe(1);
    expect(rows[2]!.light).toBeNull();
    expect(rows[3]!.source.placeInLine).toBe(2);
    expect(rows[3]!.light).toMatchObject({ status: "failed", error: "encoder gone" });
  });
});
