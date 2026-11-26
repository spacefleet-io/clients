// @req UX-NOTICE-06[badger-desktop]
import { describe, expect, it, vi } from "vitest";
import { lookAtRuntimeJobs, watchHiddenRuntimeJobs, type RuntimeJobLike } from "../src/main/hiddenRuntimeJobs";

const job = (groupId: string, status: string, kind = "source", payload: RuntimeJobLike["payload"] = null): RuntimeJobLike => ({
  jobId: `${groupId}-${kind}-${status}`,
  groupId,
  kind,
  status,
  payload,
});

describe("Badger runtime jobs that end while the window is hidden (UX-NOTICE-06)", () => {
  it("a group that ran and now all succeeded ends done, named by its file", () => {
    const look = lookAtRuntimeJobs(new Set(["g1"]), [
      job("g1", "succeeded", "source", { filename: "/home/me/Videos/Holiday.mkv" }),
      job("g1", "succeeded", "format"),
    ]);
    expect(look.ends).toEqual([{ kind: "import", outcome: "done", name: "Holiday.mkv" }]);
    expect(look.running.size).toBe(0);
  });

  it("a failed or interrupted job makes the group fail", () => {
    expect(lookAtRuntimeJobs(new Set(["g"]), [job("g", "succeeded"), job("g", "failed", "format")]).ends[0]?.outcome).toBe("failed");
    expect(lookAtRuntimeJobs(new Set(["g"]), [job("g", "interrupted", "download")]).ends).toEqual([
      { kind: "download", outcome: "failed", name: null },
    ]);
  });

  it("a group the user cancelled, one still running and one that was not running at the last look tell nothing", () => {
    const look = lookAtRuntimeJobs(new Set(["cancelled", "running"]), [
      job("cancelled", "cancelled"),
      job("running", "running"),
      job("old", "succeeded"),
    ]);
    expect(look.ends).toEqual([]);
    expect([...look.running]).toEqual(["running"]);
  });

  it("names a download by its episode and an export as a job", () => {
    const episode = { manifest: { filenameInputs: { kind: "episode", showTitle: "Show ", seasonNumber: 1, episodeNumber: 2 } } };
    expect(lookAtRuntimeJobs(new Set(["d"]), [job("d", "succeeded", "download", episode)]).ends[0]).toEqual({
      kind: "download",
      outcome: "done",
      name: "Show - S01E02",
    });
    expect(lookAtRuntimeJobs(new Set(["e"]), [job("e", "succeeded", "export")]).ends[0]?.kind).toBe("export");
  });

  it("the first look after hiding is the baseline; later looks tell what ended; showing the window forgets it", async () => {
    let hidden = true;
    let jobs: RuntimeJobLike[] = [job("a", "succeeded"), job("b", "running", "source", { filename: "b.mkv" })];
    const onEnd = vi.fn();
    const watch = watchHiddenRuntimeJobs({ isHidden: () => hidden, list: async () => jobs, onEnd, intervalMs: 60_000 });
    try {
      await watch.check();
      expect(onEnd).not.toHaveBeenCalled();
      jobs = [job("a", "succeeded"), job("b", "succeeded", "source", { filename: "b.mkv" })];
      await watch.check();
      expect(onEnd).toHaveBeenCalledWith({ kind: "import", outcome: "done", name: "b.mkv" });

      hidden = false;
      jobs = [job("c", "running")];
      await watch.check();
      hidden = true;
      jobs = [job("c", "succeeded")];
      await watch.check();
      expect(onEnd).toHaveBeenCalledTimes(1);
    } finally {
      watch.stop();
    }
  });

  it("a runtime that cannot be asked keeps the last look", async () => {
    let jobs: RuntimeJobLike[] | null = [job("g", "running")];
    const onEnd = vi.fn();
    const watch = watchHiddenRuntimeJobs({ isHidden: () => true, list: async () => jobs, onEnd, intervalMs: 60_000 });
    try {
      await watch.check();
      jobs = null;
      await watch.check();
      jobs = [job("g", "failed")];
      await watch.check();
      expect(onEnd).toHaveBeenCalledWith({ kind: "import", outcome: "failed", name: null });
    } finally {
      watch.stop();
    }
  });
});
