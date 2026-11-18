import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = path.resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts"
);

// On assertion failure, dump the matched region (or its absence) plus context
// so a source-grep regression points straight at the drifted code (per "Tests
// log generously"). try/catch so a dump failure can't mask the real assertion.
// `matched` is the regex capture (or "" when not found); `needle` is the
// substring/pattern we were looking for.
const dumpEngineSourceSnapshot = (
  label: string,
  details: { needle?: string; matched?: string; sourceLen?: number },
) => {
  try {
    console.error(`=== [mpv-playback-engine-source:${label}] snapshot ===`);
    console.error(`SOURCE_PATH=${SOURCE_PATH} sourceLen=${details.sourceLen ?? "n/a"}`);
    if (details.needle !== undefined) console.error(`needle=${JSON.stringify(details.needle)}`);
    console.error(
      `matched(${details.matched?.length ?? 0} chars)=${JSON.stringify((details.matched ?? "").slice(0, 2000))}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("useMpvPlaybackEngine source", () => {
  it("@bugfix @regression-proof keeps external launch init independent from loadStream callback identity", () => {
    console.info(`[mpv-playback-engine-source:loadstream-ref] reading ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    const needles = [
      "const loadStreamRef = useRef(loadStream);",
      "loadStreamRef.current = loadStream;",
      "await loadStreamRef.current({ startTime, paused: !shouldAutoPlay });",
    ];
    const missing = needles.filter((n) => !source.includes(n));
    if (missing.length > 0 || source.includes("    loadStream,\n    t,")) {
      dumpEngineSourceSnapshot("loadstream-ref", {
        needle: `missing=${JSON.stringify(missing)} / forbidden-present=${source.includes("    loadStream,\n    t,")}`,
        sourceLen: source.length,
      });
    }
    expect(source).toContain("const loadStreamRef = useRef(loadStream);");
    expect(source).toContain("loadStreamRef.current = loadStream;");
    expect(source).toContain("await loadStreamRef.current({ startTime, paused: !shouldAutoPlay });");
    expect(source).not.toContain("    loadStream,\n    t,");
  });

  it("[@bugfix][@regression-proof] launch branch verifies time-pos before falling back to ensureExternalSeek (avoids redundant-seek stutter on resume)", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    // Tier-5 collapsed the renderer's lifecycle refs into the
    // useMpvLifecycleStore snapshot — the launch branch's guard is now
    // `if (!processActive)` (a local that combines lifecycle.kind with
    // the synchronous isExternalMpvAlive check). The cold-HLS-proxy fix
    // (mpv-launch-loop-cold-hls-proxy) then added a nested try/catch
    // INSIDE the launch branch around prewarmPlaybackHlsSession — so a
    // naive `} catch (error) {` regex stops at the inner prewarm catch
    // instead of the outer launch catch. Anchor the outer catch by
    // requiring its body to include `setExternalMpvSessionActive(false)`,
    // which is unique to the launch branch's failure path.
    console.info(`[mpv-playback-engine-source:launch-time-pos] reading + matching launch branch`);
    const launchBranch = source.match(
      /if \(!processActive\) \{[\s\S]*?\} catch \(error\) \{[^}]*setExternalMpvSessionActive\(false\)/
    )?.[0] ?? "";
    if (!launchBranch || !launchBranch.includes("Math.abs")) {
      dumpEngineSourceSnapshot("launch-time-pos", {
        needle: "if (!processActive) { ... } catch (error) { ... setExternalMpvSessionActive(false) [+ Math.abs]",
        matched: launchBranch,
        sourceLen: source.length,
      });
    }
    expect(launchBranch, "launch branch must be present").toBeTruthy();
    // Post-fix: launch branch verifies time-pos via Math.abs(...) before any
    // redundant ensureExternalSeek. Pre-fix: bare unguarded call → no Math.abs.
    expect(launchBranch, "launch branch must verify time-pos before redundant seek").toContain("Math.abs");
  });

  it("[@bugfix][@regression-proof] backdrop-handoff branch awaits waitForExternalTracksStable BEFORE invoking sendMetadataWithBackoff (serialized ordering)", () => {
    // Phase-2b coupling-b trap: the metadata-backoff loop was extracted into a
    // shared pure helper (mpvMetadataBackoff.ts) and rewired into the three
    // call sites that used to inline the [0, 100, 300] loop (backdrop / direct /
    // reload). The backdrop branch is the ONLY path that must serialize the
    // metadata send AFTER tracks-stable resolves — see @bugfix
    // mpv-backdrop-handoff-metadata-before-stream-stable. Pre-extraction this
    // was a literal `await waitForExternalTracksStable();` followed by the
    // inline loop, easy to read. Post-extraction the helper makes it tempting
    // to "simplify" by moving the wait INTO the helper — but that would
    // silently break the direct/reload branches (which deliberately overlap
    // the wait with the send via Promise.all). This regex pins the inline
    // serialization at the backdrop site so a future refactor can't quietly
    // reorder it.
    //
    // Anchor on the bugfix tag (uniquely identifies the backdrop site) and
    // require the helper invocation to follow it without an intervening
    // Promise.all / IIFE structure. The closing `await waitForVoConfigured`
    // is also part of the serialized prelude — assert both stay before the
    // helper.
    console.info(`[mpv-playback-engine-source:backdrop-serial] matching backdrop section after bugfix anchor`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    // Window widened 1500 -> 3500 chars: the handoff load-failure checks
    // (end-file race + idle-active read, issue #25) sit between the waits and
    // the metadata send. They race the waits only against a FAILURE signal
    // (Promise.race, not Promise.all), so the serialization still holds.
    const backdropSection = source.match(
      /@bugfix mpv-backdrop-handoff-metadata-before-stream-stable[\s\S]{0,3500}?sendMetadataWithBackoff/
    )?.[0] ?? "";
    const backdropPrefix = backdropSection.split("sendMetadataWithBackoff")[0] ?? "";
    const backdropOk =
      Boolean(backdropSection) &&
      backdropSection.includes("await waitForExternalTracksStable()") &&
      backdropSection.includes("await waitForVoConfigured(5000)") &&
      !/Promise\.all\(/.test(backdropPrefix);
    if (!backdropOk) {
      dumpEngineSourceSnapshot("backdrop-serial", {
        needle: "backdrop must serialize: waitForExternalTracksStable() + waitForVoConfigured(5000) BEFORE sendMetadataWithBackoff, no Promise.all( in prefix",
        matched: backdropSection,
        sourceLen: source.length,
      });
    }
    expect(backdropSection, "backdrop bugfix anchor + sendMetadataWithBackoff invocation not found").toBeTruthy();
    expect(
      backdropSection,
      "backdrop branch must await waitForExternalTracksStable BEFORE sendMetadataWithBackoff (load-bearing ordering)"
    ).toContain("await waitForExternalTracksStable()");
    expect(
      backdropSection,
      "backdrop branch must await waitForVoConfigured(5000) before sendMetadataWithBackoff"
    ).toContain("await waitForVoConfigured(5000)");
    // No actual Promise.all CALL between the waits and the helper — that's
    // the direct/reload pattern. Backdrop must be a straight sequence.
    // (We match `Promise.all(` as a code construct rather than the bare
    // identifier so the rationale comment block that explains *why* the
    // sequencing matters can still mention Promise.all in prose.)
    expect(
      backdropSection.split("sendMetadataWithBackoff")[0] ?? "",
      "backdrop branch must NOT wrap the helper in a Promise.all call — that's the parallel direct/reload pattern"
    ).not.toMatch(/Promise\.all\(/);
  });

  it("[@bugfix][@regression-proof] direct-launch and reload branches send metadata in PARALLEL with tracks-stable (Promise.all)", () => {
    // Mirror guard for the coupling-b trap: the direct-launch and reload
    // branches deliberately OVERLAP the metadata send with the
    // waitForExternalTracksStable wait — that's the 200-500 ms start-budget
    // saving that motivated the original adaptive-backoff change. If a
    // future refactor moves the wait INTO sendMetadataWithBackoff, both
    // branches collapse to serialized waits and we lose the budget.
    console.info(`[mpv-playback-engine-source:parallel-wait] matching direct-launch + reload parallel sequences`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    // Direct-launch site: tracksStablePromise → sendMetadataWithBackoff →
    // Promise.all([tracksStablePromise, metadataPromise]) sequence.
    const directLaunch = source.match(
      /const tracksStablePromise = waitForExternalTracksStable\(\);[\s\S]{0,1500}?Promise\.all\(\[tracksStablePromise, metadataPromise\]\)/
    )?.[0] ?? "";
    if (!directLaunch || !directLaunch.includes("sendMetadataWithBackoff(")) {
      dumpEngineSourceSnapshot("parallel-wait-direct", {
        needle: "direct-launch: tracksStablePromise ... sendMetadataWithBackoff( ... Promise.all([tracksStablePromise, metadataPromise])",
        matched: directLaunch,
        sourceLen: source.length,
      });
    }
    expect(directLaunch, "direct-launch parallel-wait sequence not found").toBeTruthy();
    expect(
      directLaunch,
      "direct-launch branch must invoke sendMetadataWithBackoff between tracksStablePromise and Promise.all"
    ).toContain("sendMetadataWithBackoff(");
    // Reload site: reloadTracksStablePromise + reloadMetadataPromise +
    // Promise.all combination.
    const reload = source.match(
      /const reloadTracksStablePromise = waitForExternalTracksStable\(\);[\s\S]{0,800}?Promise\.all\(\[reloadTracksStablePromise, reloadMetadataPromise\]\)/
    )?.[0] ?? "";
    if (!reload || !reload.includes("sendMetadataWithBackoff(")) {
      dumpEngineSourceSnapshot("parallel-wait-reload", {
        needle: "reload: reloadTracksStablePromise ... sendMetadataWithBackoff( ... Promise.all([reloadTracksStablePromise, reloadMetadataPromise])",
        matched: reload,
        sourceLen: source.length,
      });
    }
    expect(reload, "reload parallel-wait sequence not found").toBeTruthy();
    expect(
      reload,
      "reload branch must invoke sendMetadataWithBackoff between reloadTracksStablePromise and Promise.all"
    ).toContain("sendMetadataWithBackoff(");
  });

  it("[@regression-proof] all three metadata-send sites use the shared sendMetadataWithBackoff helper (no inline retry loop drift)", () => {
    // Phase-2b DRY extraction: pinning that the three sites that used to
    // each carry a copy-pasted [0, 100, 300] inline loop now all go through
    // the shared helper. If a future change re-inlines the loop at any
    // site, this test catches the drift before it ships.
    console.info(`[mpv-playback-engine-source:helper-count] counting sendMetadataWithBackoff invocations + stray inline arrays`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    // Exactly three invocations of the helper today (backdrop, direct,
    // reload). If a new path is added, this number bumps INTENTIONALLY in
    // the same PR.
    const invocationMatches = source.match(/sendMetadataWithBackoff\(/g) ?? [];
    const inlineArray = source.match(/\[\s*0\s*,\s*100\s*,\s*300\s*\]/);
    console.info(
      `[mpv-playback-engine-source:helper-count] invocations=${invocationMatches.length} inlineArrayPresent=${Boolean(inlineArray)}`,
    );
    if (invocationMatches.length !== 3 || inlineArray) {
      dumpEngineSourceSnapshot("helper-count", {
        needle: `expected exactly 3 sendMetadataWithBackoff( and no [0, 100, 300] inline array; got count=${invocationMatches.length} inline=${Boolean(inlineArray)}`,
        sourceLen: source.length,
      });
    }
    expect(invocationMatches.length, "expected 3 sendMetadataWithBackoff invocations (backdrop + direct + reload)").toBe(3);
    // No stray inline backoff arrays — the legacy literal `[0, 100, 300]`
    // must be gone from the engine module after the extraction.
    expect(
      source,
      "inline [0, 100, 300] retry array detected — should live ONLY in mpvMetadataBackoff.ts default"
    ).not.toMatch(/\[\s*0\s*,\s*100\s*,\s*300\s*\]/);
  });

  it("[@bugfix][@regression-proof] loadfile-replace branch positions via per-load `start=` option, not a separate ensureExternalSeek", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    // Pre-backdrop-handoff (before commit introducing buildLoadfileCommand
    // per-load options): the loadfile-replace branch sent a bare
    // `loadfile <url> replace` and immediately followed with
    // `ensureExternalSeek(options.startTime)` to position the new file.
    //
    // Post-fix: positioning happens via mpv's per-load options form
    // `["loadfile", url, mode, -1, "start=<n>,pause=<yes|no>"]` —
    // a single atomic command from mpv's POV, no separate seek required.
    // The dedicated `buildLoadfileCommand` helper in
    // packages/mpv-protocol/src/commands.ts enforces the shape.
    //
    // This regression test pins the helper-based approach.
    console.info(`[mpv-playback-engine-source:loadfile-cmd] checking buildLoadfileCommand + per-load startSeconds option`);
    const hasHelper = source.includes("buildLoadfileCommand");
    const hasPerLoadStart = /buildLoadfileCommand\([^)]*startSeconds\s*:/.test(source);
    if (!hasHelper || !hasPerLoadStart) {
      dumpEngineSourceSnapshot("loadfile-cmd", {
        needle: `buildLoadfileCommand present=${hasHelper}, per-load startSeconds: option present=${hasPerLoadStart}`,
        sourceLen: source.length,
      });
    }
    expect(source).toContain("buildLoadfileCommand");
    // Verify the helper is used at least once with per-load options.
    // (Use the `startSeconds` key as the unique source-level marker since
    // buildLoadfileCommand's 3-arg form omits it.)
    expect(source).toMatch(/buildLoadfileCommand\([^)]*startSeconds\s*:/);
  });
});
