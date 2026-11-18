import { StreamingPipeline, type EncryptionConfig } from "./streamingPipeline";
import { AdaptivePool } from "./adaptivePool";
import type { PartMetadata } from "./uploadSessionManager";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";

/**
 * storage transport Multipart Uploader
 * 
 * Specifically designed for very large files (>100MB).
 * Implements the multipart upload lifecycle (start / parts / complete / abort) with storage transport parallelism and streaming.
 */

export interface MultipartConfig {
  token: string;
  key: string;
  contentType: string;
  filePath: string;
  partSize?: number; // Default 16MB
  encryptionConfig?: EncryptionConfig;
}

export interface StorageDriver {
  initiate: (token: string, key: string, contentType: string) => Promise<string>;
  getPartUrl: (token: string, key: string, uploadId: string, partNumber: number) => Promise<string>;
  complete: (token: string, key: string, uploadId: string, parts: PartMetadata[]) => Promise<void>;
}

export class MultipartUploader {
  private pool: AdaptivePool;
  private partSize: number;

  constructor(pool: AdaptivePool, partSize = 16 * 1024 * 1024) {
    this.pool = pool;
    this.partSize = partSize;
  }

  async upload(config: MultipartConfig, driver: StorageDriver): Promise<void> {
    const stats = await fs.stat(config.filePath);
    const totalSize = stats.size;
    const uploadId = await driver.initiate(config.token, config.key, config.contentType);

    const numParts = Math.ceil(totalSize / this.partSize);
    const parts: PartMetadata[] = [];

    const uploadPart = async (partNumber: number) => {
      const start = (partNumber - 1) * this.partSize;
      const end = Math.min(start + this.partSize - 1, totalSize - 1);
      const partLength = end - start + 1;

      const url = await driver.getPartUrl(config.token, config.key, uploadId, partNumber);

      const nodeStream = createReadStream(config.filePath, { start, end });

      if (config.encryptionConfig) {
        // Note: For multipart, we'd need to adjust encryption to handle part boundaries 
        // if we want each part to be independently decryptable, or just stream the whole 
        // thing as one encrypted blob. 
        // Legacy encrypted format expects one single encrypted blob per object.
        // So for Multipart, we'll need a specialized "Segmented Encryption" if we want 
        // true random access, OR we just encrypt the whole file first (not zero-copy).
        
        // For storage transport Pillar 2, we'll assume the driver/caller handles the encryption 
        // or we use a block-aligned cipher.
        
        // In this MVP, we stream the plaintext if no config, or throw if config 
        // (as true streaming encrypted multipart requires chunk-aligned keys).
        throw new Error("STREAMING_ENCRYPTED_MULTIPART_NOT_IMPLEMENTED_YET");
      }

      // fetch needs a WHATWG stream body; wrap the node stream in the global ReadableStream so the type
      // is the one the loaded lib (DOM or Bun) expects for BodyInit, not node:stream/web's lookalike.
      const chunks = nodeStream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          await chunks.return?.();
        },
      });
      // `duplex` is not in the DOM lib's RequestInit (it is in Bun's and undici's), so the init is a
      // named value typed with it rather than an object literal checked against whichever lib is loaded.
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        body,
        // Required by fetch for streamed request bodies in Node/Bun.
        duplex: "half",
      };
      const res = await fetch(url, init);

      if (!res.ok) throw new Error(`PART_UPLOAD_FAILED_${res.status}`);
      
      const etag = res.headers.get("ETag")?.replace(/"/g, "") ?? "";
      return { partNumber, etag, sizeBytes: partLength };
    };

    const tasks = [];
    for (let i = 1; i <= numParts; i++) {
      tasks.push(this.pool.run(() => uploadPart(i)));
    }

    const completedParts = await Promise.all(tasks);
    await driver.complete(config.token, config.key, uploadId, completedParts);
  }
}
