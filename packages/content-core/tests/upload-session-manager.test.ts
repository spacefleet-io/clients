import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResumableJobStateStore } from "../src/resumableState";
import { UploadSessionManager } from "../src/storageTransport/uploadSessionManager";

// On assertion failure, dump the reopened store state so a part/session
// mismatch is diagnosable offline. try/catch so a dump failure can't mask the
// real assertion.
const dumpSessionSnapshot = (
  label: string,
  ctx: { reopened?: ResumableJobStateStore; outputId?: string },
) => {
  try {
    console.error(`=== [upload-session-manager:${label}] snapshot ===`);
    if (ctx.reopened) {
      console.error(`reopened full state:\n${JSON.stringify(ctx.reopened.getState(), null, 2)}`);
      if (ctx.outputId) {
        console.error(
          `completedParts(${ctx.outputId}):\n${JSON.stringify(ctx.reopened.getCompletedParts(ctx.outputId), null, 2)}`,
        );
        console.error(
          `output(${ctx.outputId}):\n${JSON.stringify(ctx.reopened.getOutput(ctx.outputId), null, 2)}`,
        );
      }
    } else {
      console.error(`reopened: (not available)`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("upload session manager", () => {
  const roots: string[] = [];

  afterEach(() => {
    console.info(`[upload-session-manager:teardown] cleaning ${roots.length} temp root(s)`);
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const createStore = async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-upload-session-manager-"));
    roots.push(root);
    const store = await ResumableJobStateStore.open({
      jobDir: join(root, "job-1"),
      inputPath: "/tmp/input.mkv",
      userId: "user-1",
    });
    store.ensureOutput("video-source", "video", 12);
    await store.save();
    console.info(`[upload-session-manager:setup] store opened jobDir=${store.jobDir} output=video-source`);
    return store;
  };

  it("@bugfix @regression-proof records completed parts through the shared media job state store instead of direct json rewrites", async () => {
    const store = await createStore();
    const manager = new UploadSessionManager(store);

    console.info(`[upload-session-manager:record] recording part partNumber=0 etag=object-1 for video-source`);
    await manager.recordPart("video-source", {
      partNumber: 0,
      etag: "object-1",
      sizeBytes: 100,
      checksum: "abc",
      path: "/tmp/seg-1.m4s",
    });

    console.info(`[upload-session-manager:record] reopening store to verify persistence jobDir=${store.jobDir}`);
    const reopened = await ResumableJobStateStore.open({
      jobDir: store.jobDir,
      inputPath: "/tmp/input.mkv",
      userId: "user-1",
    });
    console.info(
      `[upload-session-manager:record] reopened completedParts(video-source)=${JSON.stringify(reopened.getCompletedParts("video-source"))}`,
    );
    try {
      expect(reopened.getCompletedParts("video-source")).toEqual([
        {
          partNumber: 0,
          etag: "object-1",
          sizeBytes: 100,
          checksum: "abc",
          path: "/tmp/seg-1.m4s",
        },
      ]);
    } catch (err) {
      dumpSessionSnapshot("record-part-reopen", { reopened, outputId: "video-source" });
      throw err;
    }
  });

  it("persists upload session ids and completed parts through the shared state store", async () => {
    const store = await createStore();
    const manager = new UploadSessionManager(store);

    console.info(`[upload-session-manager:persist] persisting session uploadSessionId=session-1 for video-source`);
    await manager.persistSession("video-source", {
      uploadSessionId: "session-1",
      parts: [
        {
          partNumber: 1,
          etag: "object-2",
          sizeBytes: 101,
        },
      ],
    });

    console.info(`[upload-session-manager:persist] reopening store to verify persistence jobDir=${store.jobDir}`);
    const reopened = await ResumableJobStateStore.open({
      jobDir: store.jobDir,
      inputPath: "/tmp/input.mkv",
      userId: "user-1",
    });
    console.info(
      `[upload-session-manager:persist] reopened output(video-source)=${JSON.stringify(reopened.getOutput("video-source"))}`,
    );
    try {
      expect(reopened.getOutput("video-source")).toEqual(
        expect.objectContaining({
          uploadSessionId: "session-1",
          completedParts: [
            {
              partNumber: 1,
              etag: "object-2",
              sizeBytes: 101,
            },
          ],
        })
      );
    } catch (err) {
      dumpSessionSnapshot("persist-session-reopen", { reopened, outputId: "video-source" });
      throw err;
    }
  });
});
