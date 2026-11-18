import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildLoadfileCommand } from "@space/mpv-protocol";

/**
 * @bugfix @regression-proof
 *
 * Regression test for the backdrop-handoff rewire — after mpv comes up
 * on the static backdrop image, the renderer sends a `loadfile <streamUrl>
 * replace -1 start=<resumeTime>` IPC to swap the source. The 5th
 * positional mpv argument carries per-load options (start + pause) so
 * the cmdline `--start` / `--pause` (intentionally omitted from the
 * backdrop-mode launch) don't apply.
 *
 * This test pins:
 *  1. buildLoadfileCommand with per-load options emits the 5-arg shape.
 *  2. buildLoadfileCommand with NO options falls back to the 3-arg
 *     shape (preserves the existing direct-launch path's wire).
 *  3. start=<n> is only included when n > 0 (don't waste mpv's parser
 *     on `start=0`).
 *  4. pause=yes/no is encoded as the literal string mpv expects.
 *  5. Source-contract: the backdrop branch in useMpvPlaybackEngine
 *     calls buildLoadfileCommand with the options arg carrying
 *     startSeconds and paused.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
console.info(`[loadfile-handoff:setup] reading engine source from ${ENGINE_PATH}`);
const engineSource = readFileSync(ENGINE_PATH, "utf8");
console.info(`[loadfile-handoff:setup] engine source loaded, length=${engineSource.length} chars`);

// Dump the command array / matched source slice so a wire-shape or
// source-contract failure is diagnosable offline. Wrapped in try/catch so the
// dump can't mask the real assertion failure.
const dumpLoadfileSnapshot = (
  label: string,
  ctx: { command?: unknown; sourceWindow?: string },
) => {
  try {
    console.error(`=== [loadfile-handoff:${label}] snapshot ===`);
    if (ctx.command !== undefined) {
      console.error(`built command=${JSON.stringify(ctx.command)}`);
    }
    if (ctx.sourceWindow !== undefined) {
      console.error(`engine source window:\n${ctx.sourceWindow}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof loadfile handoff: backdrop->stream swap", () => {
  it("@bugfix @regression-proof per-load options emit the 5-arg loadfile shape with start + pause", () => {
    console.info("[loadfile-handoff:wire-5arg] building loadfile with startSeconds=3081.5 paused=false");
    const cmd = buildLoadfileCommand("https://example.com/stream.m3u8", "replace", {
      startSeconds: 3081.5,
      paused: false,
    });
    const expected = [
      "loadfile",
      "https://example.com/stream.m3u8",
      "replace",
      -1,
      // Every per-load options object pins the cache policy: no prefill
      // outside the first GOP (mpv-start-latency-args.test.ts, #25 playable-start).
      "start=3081.5,demuxer-cache-wait=no,pause=no",
    ];
    if (JSON.stringify(cmd.command) !== JSON.stringify(expected)) {
      dumpLoadfileSnapshot("wire-5arg-mismatch", { command: cmd.command });
    }
    expect(cmd.command).toEqual(expected);
  });

  it("@bugfix @regression-proof start=<n> is encoded only when n > 0 (skips zero/null/NaN); the cache policy always is", () => {
    // null → skipped
    expect(
      buildLoadfileCommand("https://example.com/x.m3u8", "replace", {
        startSeconds: null,
        paused: false,
      }).command,
    ).toEqual(["loadfile", "https://example.com/x.m3u8", "replace", -1, "demuxer-cache-wait=no,pause=no"]);
    // 0 → skipped (no need to seek to origin)
    expect(
      buildLoadfileCommand("https://example.com/x.m3u8", "replace", {
        startSeconds: 0,
        paused: false,
      }).command,
    ).toEqual(["loadfile", "https://example.com/x.m3u8", "replace", -1, "demuxer-cache-wait=no,pause=no"]);
    // NaN → skipped (defensive)
    expect(
      buildLoadfileCommand("https://example.com/x.m3u8", "replace", {
        startSeconds: NaN,
        paused: false,
      }).command,
    ).toEqual(["loadfile", "https://example.com/x.m3u8", "replace", -1, "demuxer-cache-wait=no,pause=no"]);
  });

  it("@bugfix @regression-proof pause=yes is encoded when paused=true (mpv literal)", () => {
    const cmd = buildLoadfileCommand("https://example.com/stream.m3u8", "replace", {
      startSeconds: 100,
      paused: true,
    });
    expect(cmd.command).toEqual([
      "loadfile",
      "https://example.com/stream.m3u8",
      "replace",
      -1,
      "start=100,demuxer-cache-wait=no,pause=yes",
    ]);
  });

  it("@bugfix @regression-proof when every option skips, the load still pins the cache policy (never an empty 5th arg)", () => {
    // No start, no pause: the 5th arg still carries `demuxer-cache-wait=no`
    // so an alive mpv launched with a first-GOP resume prefill
    // (--demuxer-cache-wait=yes globally) does not prefill this load. Never
    // a stray empty 5th-arg "" that mpv would reject.
    expect(
      buildLoadfileCommand("https://example.com/x.m3u8", "replace", {
        startSeconds: null,
      }).command,
    ).toEqual(["loadfile", "https://example.com/x.m3u8", "replace", -1, "demuxer-cache-wait=no"]);
  });

  it("@bugfix @regression-proof backwards compat: no options arg → 3-arg shape (direct-launch path)", () => {
    expect(buildLoadfileCommand("https://example.com/x.m3u8", "replace").command).toEqual([
      "loadfile",
      "https://example.com/x.m3u8",
      "replace",
    ]);
  });

  it("@bugfix @regression-proof source: backdrop branch calls buildLoadfileCommand with per-load options", () => {
    console.info("[loadfile-handoff:source-backdrop] grepping engine for backdrop swap call");
    // The renderer's backdrop swap MUST pass `startSeconds: options.startTime`
    // (so the seek lands at the resume offset) AND `paused: !shouldPlay`
    // (so the user's Play/Pause intent is honored).
    const swapCall = engineSource.match(
      /buildLoadfileCommand\(session\.url,\s*["']replace["'],\s*\{[\s\S]*?\}\)/,
    )?.[0] ?? "";
    if (
      !swapCall ||
      !/startSeconds:\s*options\.startTime/.test(swapCall) ||
      !/paused:\s*!shouldPlay/.test(swapCall)
    ) {
      dumpLoadfileSnapshot("source-backdrop-mismatch", {
        sourceWindow: swapCall || "(no backdrop swap buildLoadfileCommand call matched)",
      });
    }
    expect(swapCall, "backdrop-branch swap loadfile call must use per-load options").toBeTruthy();
    expect(swapCall).toMatch(/startSeconds:\s*options\.startTime/);
    expect(swapCall).toMatch(/paused:\s*!shouldPlay/);
  });

  it("@bugfix @regression-proof source: the swap is awaited via awaitHandoffLoadfile and logs swap verdict/swapMs", () => {
    console.info("[loadfile-handoff:source-swap-await] grepping engine for awaited swap + swapMs log");
    // The swap result must be captured so subsequent logic can branch
    // on failure (fall through to a fresh launch). Since issue #25 P17
    // the raw loadfile reply is settled by awaitHandoffLoadfile (a
    // reply timeout is "unknown", not a failure) and the verdict is
    // branched on. swapMs / settledBy / verdict make the launch path
    // observable for debug. Since issue #25 S1 c038 the same loadfile is
    // passed as `resend`, so a reply that never came from mpv is re-sent.
    const swapRe =
      /const sendHandoffLoadfile = \(\) =>\s*sendExternalCommandReply\(\s*buildLoadfileCommand\(session\.url,\s*["']replace["'][^;]*\);\s*const swap = await awaitHandoffLoadfile\(\{\s*reply: sendHandoffLoadfile\(\),\s*resend: sendHandoffLoadfile,/;
    const swapMsRe = /swapMs:\s*Date\.now\(\) - swapStartMs/;
    const verdictBranchRe = /if \(swap\.verdict\.failed\) await abortHandoff\(swap\.verdict\)/;
    if (!swapRe.test(engineSource) || !swapMsRe.test(engineSource) || !verdictBranchRe.test(engineSource)) {
      const window = engineSource.match(/const swap = [\s\S]{0,600}/)?.[0] ?? "(no swap decl found)";
      dumpLoadfileSnapshot("source-swap-await-mismatch", { sourceWindow: window });
    }
    expect(engineSource).toMatch(swapRe);
    expect(engineSource).toMatch(swapMsRe);
    expect(engineSource).toMatch(verdictBranchRe);
  });
});
