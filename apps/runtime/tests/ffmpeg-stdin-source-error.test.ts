/**
 * #25 P11 — a failing stdin source must fail the encode, not hand ffmpeg a
 * clean EOF on a truncated input.
 *
 * Ultimate baseline b51ea3c4, shard-4 runtime.log:67820-67900: after a
 * runtime-kill + gateway-restart, the resumed retranscode of job 356dac5c
 * piped its source through `runFfmpeg({ stdin })`. The source stream died
 * after 814 bytes; the pump (packages/ffmpeg/src/index.ts, `pumpBunSink` /
 * `pumpNodeStream`) swallowed the error and ended stdin normally, so ffmpeg
 * saw EOF and the job failed with a misleading "Could not find codec
 * parameters". Worse, a source dying mid-stream lets ffmpeg finalize a
 * truncated rendition and exit 0.
 *
 * Fake ffmpeg here: `cat > /dev/null`, which exits 0 on EOF exactly like an
 * encoder that finalizes whatever it got. The run must reject with the source
 * error (and the child must be killed before stdin is closed), on both the
 * Bun.spawn path (the runtime's) and the node:child_process path.
 *
 * @bugfix @regression-proof
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFfmpeg } from "@space/ffmpeg";

const SUITE = "ffmpeg-stdin-source-error";
const FFMPEG_SRC = resolve(__dirname, "../../../packages/ffmpeg/src/index.ts");

const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}:${phase}] ${JSON.stringify(data)}`);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeFakeFfmpeg = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sf-stdin-src-"));
  tmpDirs.push(dir);
  const fake = join(dir, "ffmpeg");
  writeFileSync(fake, "#!/bin/sh\nexec cat > /dev/null\n");
  chmodSync(fake, 0o755);
  return fake;
};

// A source that dies after 814 bytes, like the gateway stream in x064. The
// Bun parent embeds the same function through `toString()`.
async function* failingSource(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(814);
  throw new Error("source boom: gateway connection reset");
}

type Outcome = { resolved: number } | { rejected: string };

const bunOnPath = spawnSync("sh", ["-c", "command -v bun"]).status === 0;

describe.skipIf(process.platform === "win32")("@bugfix @regression-proof stdin source errors fail the encode (#25 P11)", () => {
  it("node:child_process path: runFfmpeg rejects with the source error", async () => {
    const fake = makeFakeFfmpeg();
    const outcome: Outcome = await runFfmpeg(["-i", "pipe:0", "-f", "null", "-"], {
      ffmpegPath: fake,
      progress: { enabled: false },
      stdin: failingSource(),
    }).then(
      (res) => ({ resolved: res.code }),
      (err: unknown) => ({ rejected: err instanceof Error ? err.message : String(err) })
    );
    log("node-outcome", outcome);
    expect("rejected" in outcome ? outcome.rejected : `resolved with code ${outcome.resolved}`).toMatch(
      /stdin source failed.*source boom/
    );
  }, 20_000);

  it.skipIf(!bunOnPath)("Bun.spawn path (runtime): runFfmpeg rejects with the source error", async () => {
    const fake = makeFakeFfmpeg();
    const dir = tmpDirs[tmpDirs.length - 1] as string;
    const parent = join(dir, "parent.ts");
    writeFileSync(
      parent,
      `import { runFfmpeg } from ${JSON.stringify(FFMPEG_SRC)};
${failingSource.toString()}
runFfmpeg(["-i", "pipe:0", "-f", "null", "-"], {
  ffmpegPath: ${JSON.stringify(fake)},
  progress: { enabled: false },
  stdin: failingSource(),
}).then(
  (res) => console.log("OUTCOME " + JSON.stringify({ resolved: res.code })),
  (err) => console.log("OUTCOME " + JSON.stringify({ rejected: err instanceof Error ? err.message : String(err) }))
);
`
    );
    const child = spawn("bun", [parent], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    const { promise, resolve: done } = Promise.withResolvers<number | null>();
    child.on("close", done);
    const exitCode = await promise;
    log("bun-run", { exitCode, stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) });
    const line = stdout.split("\n").find((l) => l.startsWith("OUTCOME ")) ?? "OUTCOME null";
    const outcome: Outcome | null = JSON.parse(line.slice("OUTCOME ".length));
    expect(outcome, "bun parent printed no OUTCOME line").not.toBeNull();
    expect(outcome && "rejected" in outcome ? outcome.rejected : JSON.stringify(outcome)).toMatch(
      /stdin source failed.*source boom/
    );
  }, 30_000);
});
