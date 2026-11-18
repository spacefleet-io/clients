import type { ContentUploadLedger, ContentUploadLedgerPart } from "../upload";
import { ResumableJobStateStore } from "../resumableState";

/**
 * Upload Session Manager
 * 
 * Responsible for persistence of session metadata in job_state.json.
 * Ensures crash-safe resumability for both segment batches and multipart uploads.
 */

export type PartMetadata = ContentUploadLedgerPart;

export interface SessionMetadata {
  uploadSessionId?: string;
  parts: PartMetadata[];
}

export class UploadSessionManager implements ContentUploadLedger {
  private storePromise: Promise<ResumableJobStateStore>;

  constructor(input: string | ResumableJobStateStore) {
    this.storePromise = Promise.resolve(
      typeof input === "string"
        ? ResumableJobStateStore.open({
            jobDir: input,
            inputPath: "",
            userId: "",
          })
        : input
    );
  }

  /**
   * Persists the upload session metadata for a specific output or segment.
   * In Phase 1, this writes directly to the local job_state.json.
   */
  async persistSession(outputId: string, metadata: SessionMetadata) {
    const store = await this.storePromise;
    await store.persistUploadSession(outputId, metadata);
  }

  /**
   * Marks a single part as completed and persists it immediately.
   */
  async recordPart(outputId: string, part: PartMetadata) {
    const store = await this.storePromise;
    await store.recordCompletedPart(outputId, part);
  }

  /**
   * Retrieves already completed parts to avoid re-uploading.
   */
  async getCompletedParts(outputId: string): Promise<PartMetadata[]> {
    const store = await this.storePromise;
    return store.getCompletedParts(outputId);
  }
}
