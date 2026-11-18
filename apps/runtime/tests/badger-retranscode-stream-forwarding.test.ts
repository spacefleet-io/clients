/**
 * @bugfix retranscode-stream-input-not-forwarded
 * @regression-proof
 *
 * The streaming-source retranscode (Phase 7) pipes the source to ffmpeg stdin
 * and relies on `produceMediaOutputs` running in streaming mode (which skips
 * the probe and uses `sourceQualityOverride`). The thin wrapper
 * `produceBadgerMediaOutputs` (the wired `produceMediaOutputs` step dep) did
 * NOT forward `inputStream` — its input type didn't even declare it — so
 * `produceMediaOutputs` saw `inputStream: undefined`, ran in non-streaming
 * mode, and ffprobed the `retranscode-stream:<sourceFormatId>` sentinel
 * inputPath, failing with `Protocol not found`.
 *
 * Source-level guard: the wrapper must declare AND forward `inputStream`
 * (+ the streaming duration hint). produceMediaOutputs is imported from
 * @space/ingest-core/mediaProcessor (a native-ffmpeg module) which makes a
 * behavioral mount heavy; the forwarding is the precise regression surface.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = resolve(process.cwd(), "src/modules/badgerIngest.ts");
console.info(
  `[badger-retranscode-stream-forwarding:setup] reading source at ${SOURCE_PATH}`,
);
const source = readFileSync(SOURCE_PATH, "utf8");
console.info(
  `[badger-retranscode-stream-forwarding:setup] source loaded, length=${source.length} lines=${source.split("\n").length}`,
);

// On assertion failure, dump enough of the source-level surface to diagnose
// offline ("Tests log generously": the failure path is where the
// value is highest). We can't dump runtime state — this is a source-grep test —
// so we surface which regex was being matched, whether the surrounding token
// even appears in the file, and the lines that mention it, so a CI reader can
// see at a glance whether the wrapper was renamed, the field dropped, or the
// regex drifted. Body wrapped in try/catch so a dump failure cannot mask the
// real assertion failure.
const dumpRetranscodeStreamSnapshot = (
  label: string,
  pattern: RegExp,
  token: string,
) => {
  try {
    const tokenPresent = source.includes(token);
    const matchingLines = source
      .split("\n")
      .map((line, idx) => ({ no: idx + 1, line: line.trimEnd() }))
      .filter((entry) => entry.line.includes(token))
      .slice(0, 10);
    console.error(
      `=== [badger-retranscode-stream-forwarding:${label}] source snapshot ===`,
    );
    console.error(`sourcePath=${SOURCE_PATH}`);
    console.error(`pattern=${pattern.toString()}`);
    console.error(`token=${JSON.stringify(token)} tokenPresent=${tokenPresent}`);
    console.error(`matched=${pattern.test(source)}`);
    console.error(
      `lines mentioning token (first 10):\n${JSON.stringify(matchingLines, null, 2)}`,
    );
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("@bugfix @regression-proof produceBadgerMediaOutputs forwards the streaming source", () => {
  it("declares inputStream on the wrapper input type", () => {
    console.info(
      `[badger-retranscode-stream-forwarding:declare-inputStream] asserting wrapper input type declares inputStream`,
    );
    const pattern = /inputStream\?\s*:\s*AsyncIterable<Uint8Array>\s*\|\s*null/;
    if (!pattern.test(source)) {
      dumpRetranscodeStreamSnapshot(
        "declare-inputStream",
        pattern,
        "inputStream",
      );
    }
    expect(source).toMatch(pattern);
  });

  it("forwards input.inputStream to produceMediaOutputs", () => {
    console.info(
      `[badger-retranscode-stream-forwarding:forward-inputStream] asserting input.inputStream is forwarded`,
    );
    // Without this, streaming retranscode ffprobes the sentinel inputPath.
    const pattern = /inputStream:\s*input\.inputStream/;
    if (!pattern.test(source)) {
      dumpRetranscodeStreamSnapshot(
        "forward-inputStream",
        pattern,
        "input.inputStream",
      );
    }
    expect(source).toMatch(pattern);
  });

  it("forwards reopenInputStream so a failed hardware streaming encode can retry on CPU (F2)", () => {
    console.info(
      `[badger-retranscode-stream-forwarding:forward-reopen] asserting reopenInputStream is declared + forwarded`,
    );
    const declared = /reopenInputStream\?\s*:\s*\(\(\)\s*=>\s*AsyncIterable<Uint8Array>\)\s*\|\s*null/;
    const forwarded = /reopenInputStream:\s*input\.reopenInputStream/;
    if (!declared.test(source)) {
      dumpRetranscodeStreamSnapshot("declare-reopenInputStream", declared, "reopenInputStream");
    }
    if (!forwarded.test(source)) {
      dumpRetranscodeStreamSnapshot("forward-reopenInputStream", forwarded, "input.reopenInputStream");
    }
    expect(source).toMatch(declared);
    expect(source).toMatch(forwarded);
  });

  it("forwards the streaming duration hint (inputDurationSeconds)", () => {
    console.info(
      `[badger-retranscode-stream-forwarding:forward-duration-hint] asserting inputDurationSeconds is forwarded`,
    );
    const pattern = /inputDurationSeconds:\s*input\.inputDurationSeconds/;
    if (!pattern.test(source)) {
      dumpRetranscodeStreamSnapshot(
        "forward-duration-hint",
        pattern,
        "inputDurationSeconds",
      );
    }
    expect(source).toMatch(pattern);
  });
});
