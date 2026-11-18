/**
 * @test-id ORPHAN-CLEANUP-001
 * @level unit
 * @why Cancelled or failed ingest jobs leave orphaned chunks in gateway storage.
 *      No mechanism existed to identify which object keys to clean up.
 * @covers packages/ingest-co../src/resumableState.ts: collectUploadedObjectKeys
 */

import { describe, expect, it } from "vitest";
import { collectUploadedObjectKeys, type JobState } from "../src/resumableState";

const makeJobState = (overrides: Partial<JobState> = {}): JobState => ({
  version: 1,
  inputPath: "/tmp/test.mkv",
  userId: "user-1",
  createdAt: "2026-03-30T00:00:00.000Z",
  outputs: [],
  subtitles: [],
  ...overrides,
});

// On assertion failure, dump the job state we fed in and the keys we collected so
// the mismatch is diagnosable from CI logs alone (no local repro needed).
const dumpOrphanKeySnapshot = (
  label: string,
  state: JobState,
  collected: string[],
): void => {
  try {
    const outputSummary = state.outputs.map((o) => ({
      id: o.id,
      kind: o.kind,
      initKey: o.init?.key ?? null,
      initUploaded: o.init?.uploaded ?? null,
      segments: o.segments.map((s) => ({ key: s.key ?? null, uploaded: s.uploaded })),
    }));
    const subtitleSummary = state.subtitles.map((s) => ({
      id: s.id,
      key: s.key ?? null,
      uploaded: s.uploaded,
    }));
    console.error(`=== [orphan-key-collection:${label}] snapshot ===`);
    console.error(`outputs:\n${JSON.stringify(outputSummary, null, 2)}`);
    console.error(`subtitles:\n${JSON.stringify(subtitleSummary, null, 2)}`);
    console.error(
      `collected keys (count=${collected.length}): ${JSON.stringify(collected)}`,
    );
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("collectUploadedObjectKeys", () => {
  it("returns empty array for fresh job with no uploads", () => {
    const state = makeJobState();
    expect(collectUploadedObjectKeys(state)).toEqual([]);
  });

  it("collects init segment key when uploaded", () => {
    const state = makeJobState({
      outputs: [
        {
          id: "video-source",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/out",
          init: { path: "/tmp/init.mp4", key: "init-key-1", uploaded: true, sizeBytes: 100 },
          segments: [],
        },
      ],
    });
    expect(collectUploadedObjectKeys(state)).toEqual(["init-key-1"]);
  });

  it("collects segment keys when uploaded", () => {
    console.info(
      "[orphan-key-collection:segments] collecting with 2 uploaded + 1 pending segment",
    );
    const state = makeJobState({
      outputs: [
        {
          id: "video-source",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/out",
          init: { path: "/tmp/init.mp4", key: "init-key", uploaded: true },
          segments: [
            { path: "/tmp/seg-0.m4s", key: "seg-0-key", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-1.m4s", key: "seg-1-key", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-2.m4s", uploaded: false }, // not yet uploaded
          ],
        },
      ],
    });
    const keys = collectUploadedObjectKeys(state);
    const expected = ["init-key", "seg-0-key", "seg-1-key"];
    if (JSON.stringify(keys) !== JSON.stringify(expected) || keys.includes(undefined as unknown as string)) {
      dumpOrphanKeySnapshot("segments", state, keys);
    }
    expect(keys).toEqual(expected);
    expect(keys).not.toContain(undefined);
  });

  it("collects subtitle keys when uploaded", () => {
    const state = makeJobState({
      subtitles: [
        { id: "sub-0", path: "/tmp/sub-en.vtt", key: "sub-en-key", uploaded: true, language: "en", label: "English", format: "vtt" },
        { id: "sub-1", path: "/tmp/sub-fr.vtt", uploaded: false, language: "fr", label: "French", format: "vtt" },
      ],
    });
    expect(collectUploadedObjectKeys(state)).toEqual(["sub-en-key"]);
  });

  it("collects keys across multiple outputs and subtitles", () => {
    const state = makeJobState({
      outputs: [
        {
          id: "video-source",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/source",
          init: { path: "/tmp/init-src.mp4", key: "src-init", uploaded: true },
          segments: [
            { path: "/tmp/seg-src-0.m4s", key: "src-seg-0", uploaded: true },
          ],
        },
        {
          id: "video-360p",
          kind: "video",
          segmentSeconds: 4,
          outputDir: "/tmp/360p",
          init: { path: "/tmp/init-360.mp4", key: "360-init", uploaded: true },
          segments: [
            { path: "/tmp/seg-360-0.m4s", key: "360-seg-0", uploaded: true },
            { path: "/tmp/seg-360-1.m4s", key: "360-seg-1", uploaded: true },
          ],
        },
        {
          id: "audio-en",
          kind: "audio",
          segmentSeconds: 4,
          outputDir: "/tmp/audio",
          init: { path: "/tmp/init-audio.mp4", key: "audio-init", uploaded: true },
          segments: [
            { path: "/tmp/seg-audio-0.m4s", key: "audio-seg-0", uploaded: true },
          ],
        },
      ],
      subtitles: [
        { id: "sub-0", path: "/tmp/sub.vtt", key: "sub-key", uploaded: true, language: "en", label: "English", format: "vtt" },
      ],
    });

    console.info(
      "[orphan-key-collection:multi-output] collecting across 3 outputs + 1 subtitle (expect 8 keys)",
    );
    const keys = collectUploadedObjectKeys(state);
    if (keys.length !== 8) {
      dumpOrphanKeySnapshot("multi-output", state, keys);
    }
    expect(keys).toHaveLength(8);
    expect(keys).toContain("src-init");
    expect(keys).toContain("src-seg-0");
    expect(keys).toContain("360-init");
    expect(keys).toContain("360-seg-0");
    expect(keys).toContain("360-seg-1");
    expect(keys).toContain("audio-init");
    expect(keys).toContain("audio-seg-0");
    expect(keys).toContain("sub-key");
  });

  it("ignores segments without key even if uploaded flag is true", () => {
    const state = makeJobState({
      outputs: [
        {
          id: "video",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/out",
          init: { path: "/tmp/init.mp4", uploaded: true }, // no key
          segments: [
            { path: "/tmp/seg-0.m4s", uploaded: true }, // no key
          ],
        },
      ],
    });
    expect(collectUploadedObjectKeys(state)).toEqual([]);
  });

  it("returns all uploaded keys after partial upload cancellation for storage cleanup", () => {
    const state = makeJobState({
      outputs: [
        {
          id: "video-source",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/out",
          init: { path: "/tmp/init.mp4", key: "cancel-init", uploaded: true },
          segments: [
            { path: "/tmp/seg-0.m4s", key: "cancel-seg-0", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-1.m4s", key: "cancel-seg-1", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-2.m4s", key: "cancel-seg-2", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-3.m4s", uploaded: false },
            { path: "/tmp/seg-4.m4s", uploaded: false },
          ],
        },
      ],
    });

    console.info(
      "[orphan-key-collection:cancel] collecting after partial cancellation (3 uploaded + 2 pending segments)",
    );
    const keys = collectUploadedObjectKeys(state);
    const expected = ["cancel-init", "cancel-seg-0", "cancel-seg-1", "cancel-seg-2"];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      dumpOrphanKeySnapshot("cancel", state, keys);
    }
    expect(keys).toEqual(expected);
    expect(keys).toHaveLength(4);
  });

  it("identifies orphan keys from persisted crash state on restart", () => {
    const crashedState = makeJobState({
      outputs: [
        {
          id: "video-source",
          kind: "video",
          segmentSeconds: 12,
          outputDir: "/tmp/out",
          init: { path: "/tmp/init.mp4", key: "crash-init", uploaded: true },
          segments: [
            { path: "/tmp/seg-0.m4s", key: "crash-seg-0", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-1.m4s", key: "crash-seg-1", uploaded: true, sizeBytes: 500 },
            { path: "/tmp/seg-2.m4s", uploaded: false },
          ],
        },
        {
          id: "audio-en",
          kind: "audio",
          segmentSeconds: 12,
          outputDir: "/tmp/audio",
          init: { path: "/tmp/audio-init.mp4", key: "crash-audio-init", uploaded: true },
          segments: [
            { path: "/tmp/audio-0.m4s", key: "crash-audio-0", uploaded: true },
          ],
        },
      ],
      subtitles: [
        { id: "sub-0", path: "/tmp/sub.vtt", key: "crash-sub", uploaded: true, language: "en", label: "English", format: "vtt" },
      ],
    });

    console.info(
      "[orphan-key-collection:crash-restart] collecting orphan keys from persisted crash state (expect 6)",
    );
    const orphanKeys = collectUploadedObjectKeys(crashedState);
    const expected = [
      "crash-init",
      "crash-seg-0",
      "crash-seg-1",
      "crash-audio-init",
      "crash-audio-0",
      "crash-sub",
    ];
    if (JSON.stringify(orphanKeys) !== JSON.stringify(expected)) {
      dumpOrphanKeySnapshot("crash-restart", crashedState, orphanKeys);
    }
    expect(orphanKeys).toEqual(expected);
    expect(orphanKeys).toHaveLength(6);
  });
});
