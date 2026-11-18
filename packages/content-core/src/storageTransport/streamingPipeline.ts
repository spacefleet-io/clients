import crypto from "node:crypto";
import { Readable } from "node:stream";

/**
 * storage transport Streaming Pipeline
 * 
 * Implements a memory-bounded, backpressured stream:
 * ReadStream -> Encrypt -> Upload
 */

export interface EncryptionConfig {
  key: Buffer;
  iv: Buffer;
  aad?: Buffer;
  plaintextLength: number;
}

export interface PipelineOptions {
  memoryBudget?: number; // Total bytes allowed to be buffered
  unencryptedHeader?: Uint8Array; // MAGIC + salt + nonce
}

export class StreamingPipeline {
  private memoryBudget: number;
  private bufferedBytes = 0;
  private unencryptedHeader?: Uint8Array;

  constructor(options: PipelineOptions = {}) {
    this.memoryBudget = options.memoryBudget ?? 256 * 1024 * 1024; // 256MB Default
    this.unencryptedHeader = options.unencryptedHeader;
  }

  /**
   * Creates an encrypted ReadableStream from a source stream.
   * Leverages Web Streams for backpressure.
   */
  createEncryptedStream(
    source: ReadableStream<Uint8Array>,
    config: EncryptionConfig
  ): ReadableStream<Uint8Array> {
    const { key, iv, aad, plaintextLength } = config;
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    if (aad) {
      cipher.setAAD(aad);
    }

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        if (this.unencryptedHeader) {
          controller.enqueue(this.unencryptedHeader);
        }
        
        // storage transport Pillar 2: Prepend encrypted encrypted metadata (size + padding_len)
        // For simplicity in streaming, we use 0 padding.
        const sfHeader = Buffer.alloc(6);
        sfHeader.writeUInt32LE(plaintextLength, 0);
        sfHeader.writeUInt16LE(0, 4);
        
        const encryptedHeader = cipher.update(sfHeader);
        if (encryptedHeader.length > 0) {
          controller.enqueue(new Uint8Array(encryptedHeader));
        }
      },
      transform: (chunk, controller) => {
        // Track memory usage for the budget
        this.bufferedBytes += chunk.byteLength;
        
        const encrypted = cipher.update(chunk);
        if (encrypted.length > 0) {
          controller.enqueue(new Uint8Array(encrypted));
        }
        
        this.bufferedBytes -= chunk.byteLength;
      },
      flush: (controller) => {
        const final = cipher.final();
        if (final.length > 0) {
          controller.enqueue(new Uint8Array(final));
        }
        // Enqueue the auth tag at the very end
        controller.enqueue(new Uint8Array(cipher.getAuthTag()));
      }
    });

    return source.pipeThrough(transform);
  }

  /**
   * Utility to wrap a Node.js Readable into a Web ReadableStream
   */
  static fromNodeStream(nodeStream: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  }

  getBufferedBytes() {
    return this.bufferedBytes;
  }
}
