/**
 * Bench (#671 R3): what one library write costs the runtime's event loop, and
 * how many bytes it broadcasts, with the pre-R3 full-snapshot `library.updated`
 * frame vs the delta frame.
 *
 * Builds a real library of N media (default 1000) with a file, a format,
 * genres and cast each, injects the LibraryDb into a BadgerLibraryDbService
 * (the same injection the runtime suites use) and runs W single-media writes
 * (`setTrackPrefs`, a non-progress write so the publish is not deferred).
 * Per write it records:
 *   - `blockMs`: the longest event-loop stall during the write (1 ms ticker),
 *     which includes the snapshot build the old publisher ran synchronously;
 *   - `bytes`: JSON size of the `library.updated` payload (one subscriber);
 *   - with the delta frame, the consumer's follow-up `badger.db.snapshot`
 *     (`getSnapshotDelta(changedMediaIds)`) is run and counted too (build time
 *     into `blockMs`'s sibling `fetchMs`, bytes into `fetchBytes`), so the
 *     "after" number is the whole cost, not only the cheap frame.
 *
 * Usage:
 *   bun apps/runtime/scripts/bench-library-delta.ts [mediaCount] [writes]
 *
 * Before/after in one checkout: save the base versions of the two modules next
 * to the originals (`git show <base>:<path> > <path minus .ts>.before.ts`) and
 * point BENCH_SERVICE_MODULE / BENCH_LIBRARY_DB_MODULE at them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type * as ServiceModule from "../src/modules/badgerLibraryDb";
import type * as LibraryDbModule from "../../../packages/library-db-runtime/src/libraryDb";

const serviceModule = process.env.BENCH_SERVICE_MODULE ?? "../src/modules/badgerLibraryDb";
const libraryDbModule = process.env.BENCH_LIBRARY_DB_MODULE ?? "../../../packages/library-db-runtime/src/libraryDb";
const { BadgerLibraryDbService } = (await import(serviceModule)) as typeof ServiceModule;
const { LibraryDb } = (await import(libraryDbModule)) as typeof LibraryDbModule;
type TmdbItem = Parameters<LibraryDbModule.LibraryDb["addMediaFromTmdb"]>[0];

const mediaCount = Number(process.argv[2] ?? 1000);
const writes = Number(process.argv[3] ?? 25);
const LABEL = "[bench-library-delta]";
console.info(`${LABEL} service=${serviceModule} libraryDb=${libraryDbModule} media=${mediaCount} writes=${writes}`);

const root = mkdtempSync(join(tmpdir(), "sf-bench-lib-delta-"));
process.env.SF_USER_DATA_PATH = root;

const quiet = console.info;
const db = await LibraryDb.openLocal("token", "key");
db.setSyncEnabled(false);

const ids: string[] = [];
const seedStart = performance.now();
for (let i = 0; i < mediaCount; i += 1) {
  const id = await db.addMediaFromTmdb({
    id: 100_000 + i,
    type: "movie",
    title: `Bench movie ${i}`,
    originalTitle: `Bench movie ${i}`,
    originalLanguage: "en",
    overview: `Overview ${i} `.repeat(30),
    year: "2026",
    rating: 7.1,
    posterPath: `/poster/${i}.jpg`,
    backdropPath: `/backdrop/${i}.jpg`,
    genres: ["Drama", "Sci-Fi"],
    cast: [
      { name: `Actor ${i}`, character: "Lead", profilePath: null },
      { name: `Actress ${i}`, character: "Support", profilePath: null },
    ],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
    // Minimal movie; the rest of TmdbDetails is optional at runtime (as in the library-db-runtime suites).
  } as unknown as TmdbItem);
  const fileId = await db.linkFileToMedia(id, `bench-${i}.mkv`);
  await db.addMediaFormat(id, fileId, "1080p", "h264", 800, [{ key: `c-${i}`, sizeBytes: 1000, startSeconds: 0 }], 5000, {
    isSource: true,
  });
  ids.push(id);
}
quiet(`${LABEL} seeded ${mediaCount} media in ${(performance.now() - seedStart).toFixed(0)} ms; snapshot bytes=${JSON.stringify(db.getSnapshot()).length}`);

const service = new BadgerLibraryDbService();
Reflect.set(service, "db", db);
Reflect.set(service, "lastSnapshotVersion", db.getVersion());
const frames: Array<{ bytes: number; changed: unknown }> = [];
service.setEventPublisher((_channel, _event, payload) => {
  // One subscriber's worth of serialisation: what the runtime's event hub does per frame.
  const bytes = JSON.stringify(payload).length;
  const changed = (payload as { changedMediaIds?: unknown }).changedMediaIds ?? "(full snapshot)";
  frames.push({ bytes, changed });
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const blockSamples: number[] = [];
const frameBytes: number[] = [];
const fetchMsSamples: number[] = [];
const fetchBytes: number[] = [];
const wallSamples: number[] = [];
// Warm-up write (JIT, statement cache) is not measured.
await service.call("setTrackPrefs", [ids[0], { audioLanguage: "en" }]);
frames.length = 0;

for (let w = 0; w < writes; w += 1) {
  const mediaId = ids[(w * 37 + 11) % ids.length];
  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last - 1);
    last = now;
  }, 1);
  const start = performance.now();
  await service.call("setTrackPrefs", [mediaId, { audioLanguage: w % 2 === 0 ? "fr" : "en" }]);
  const wall = performance.now() - start;
  // Let a stall that ended inside the call surface as a late tick before the ticker stops.
  await new Promise((resolve) => setTimeout(resolve, 3));
  clearInterval(ticker);
  blockSamples.push(maxGap);
  wallSamples.push(wall);
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error(`write ${w} published no library.updated frame`);
  frameBytes.push(frame.bytes);
  // The consumer's follow-up fetch exists only with the delta frame.
  const getDelta = (service as unknown as { getSnapshotDelta?: (mediaIds: string[]) => unknown }).getSnapshotDelta;
  if (Array.isArray(frame.changed) && getDelta) {
    const fetchStart = performance.now();
    const delta = getDelta.call(service, frame.changed as string[]);
    const json = JSON.stringify(delta);
    fetchMsSamples.push(performance.now() - fetchStart);
    fetchBytes.push(json.length);
  }
}

const summary = (values: number[]) => ({
  p50: Number(percentile(values, 50).toFixed(2)),
  p95: Number(percentile(values, 95).toFixed(2)),
  max: Number(Math.max(...values).toFixed(2)),
});
const result = {
  implementation: serviceModule,
  mediaCount,
  writes,
  writeEventLoopBlockMs: summary(blockSamples),
  writeWallMs: summary(wallSamples),
  frameBytes: summary(frameBytes),
  followUpFetchMs: fetchMsSamples.length ? summary(fetchMsSamples) : null,
  followUpFetchBytes: fetchBytes.length ? summary(fetchBytes) : null,
  totalBroadcastBytesPerWriteP50: Number((percentile(frameBytes, 50) + (fetchBytes.length ? percentile(fetchBytes, 50) : 0)).toFixed(0)),
};
quiet(`${LABEL} RESULT ${JSON.stringify(result)}`);

db.close();
rmSync(root, { recursive: true, force: true });
