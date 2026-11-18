/**
 * Child process for resumable-upload-ledger.test.ts: opens a job state with
 * `segments` pending segments, then "uploads" them one by one through
 * recordCompletedPart, printing `ACK <index>` after each append resolved.
 * The parent SIGKILLs it mid-run.
 */
import { ResumableJobStateStore } from "@space/content-core";

const [jobDir, segmentCountArg] = process.argv.slice(2);
const segmentCount = Number(segmentCountArg);

const store = await ResumableJobStateStore.open({ jobDir: jobDir!, inputPath: "/tmp/in.mkv", userId: "u" });
const output = store.ensureOutput("video-1080p", "video", 4);
output.init = { path: "/tmp/init.mp4", uploaded: false };
for (let i = 0; i < segmentCount; i++) {
  output.segments.push({ path: `/tmp/seg-${i}.m4s`, uploaded: false, startSeconds: i * 4 });
}
await store.save();
console.log("READY");

for (let i = 0; i < segmentCount; i++) {
  await store.recordCompletedPart("video-1080p", {
    partNumber: 0,
    etag: `obj-${i}`,
    sizeBytes: 1000 + i,
    checksum: `sum-${i}`,
    path: `/tmp/seg-${i}.m4s`,
  });
  console.log(`ACK ${i}`);
}
console.log("DONE");
