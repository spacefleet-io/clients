import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { filterRuntimeJobs, type RuntimeJobFilter, type RuntimeJobRecord } from "@space/runtime-jobs";
import type { AppId } from "../../types";

export class RuntimeJobsStore {
  private readonly jobs = new Map<string, RuntimeJobRecord>();
  private filePath: string | null = null;

  constructor(filePath?: string | null) {
    if (filePath) {
      this.configurePersistence(filePath);
    }
  }

  configurePersistence(filePath: string | null) {
    this.filePath = filePath?.trim() || null;
    this.loadFromDisk();
  }

  upsert(job: RuntimeJobRecord) {
    this.jobs.set(job.jobId, job);
    this.persist();
    return job;
  }

  upsertMany(jobs: RuntimeJobRecord[]) {
    for (const job of jobs) {
      this.jobs.set(job.jobId, job);
    }
    this.persist();
    return jobs;
  }

  delete(jobId: string) {
    const deleted = this.jobs.delete(jobId);
    if (deleted) this.persist();
    return deleted;
  }

  deleteMany(jobIds: string[]) {
    let deleted = false;
    for (const jobId of jobIds) {
      deleted = this.jobs.delete(jobId) || deleted;
    }
    if (deleted) this.persist();
    return deleted;
  }

  list(filter: RuntimeJobFilter = {}, allowedApps: AppId[] | null = null) {
    const scoped = [...this.jobs.values()].filter((job) => allowedApps === null || allowedApps.includes(job.app as AppId));
    return filterRuntimeJobs(scoped, filter);
  }

  get(jobId: string, allowedApps: AppId[] | null = null) {
    const job = this.jobs.get(jobId) ?? null;
    if (!job) return null;
    if (allowedApps && !allowedApps.includes(job.app as AppId)) return null;
    return job;
  }

  findByDedupeKey(app: AppId, dedupeKey: string) {
    for (const job of this.jobs.values()) {
      if (job.app === app && job.dedupeKey === dedupeKey) return job;
    }
    return null;
  }

  reset(options?: { clearPersistence?: boolean }) {
    this.jobs.clear();
    if (options?.clearPersistence) {
      this.clearPersistence();
      return;
    }
    this.persist();
  }

  private loadFromDisk() {
    this.jobs.clear();
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: RuntimeJobRecord[] } | RuntimeJobRecord[];
      const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      for (const job of jobs) {
        if (job && typeof job.jobId === "string") {
          this.jobs.set(job.jobId, job);
        }
      }
    } catch {
      this.jobs.clear();
    }
  }

  private persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2));
  }

  private clearPersistence() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    rmSync(this.filePath, { force: true });
  }
}

export const runtimeJobsStore = new RuntimeJobsStore();
