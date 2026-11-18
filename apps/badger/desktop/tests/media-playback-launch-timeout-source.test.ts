import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * History of this watchdog:
 *
 * (1) Original bug (2026-05-07): launch-stalled fallback timer fired at 10 s
 *     and auto-degraded quality on cold-storage first-load even though the
 *     launch was about to succeed at the requested quality. Fix: budget
 *     bumped to 20 s.
 *
 * (2) Local-dev false-positive (2026-05-13): on a localhost gateway with no
 *     networking latency the watchdog tripped, toasted "Switching to 360p
 *     for a faster start", and the mpv that opened was NOT in 360p — the
 *     original quality finished launching a beat after the toast fired.
 *     Cause: the renderer watchdog raced the engine's own ready-gate
 *     (15 s tracks-stable + 5 s vo-configured = 20 s) at the boundary.
 *     Fix: bump to 30 s, short-circuit on `playback.isReadyToReveal`.
 *
 * (3) Production-grade ABR (2026-05-13): the watchdog no longer makes ANY
 *     quality decisions. ABR owns that via real network signals. Watchdog
 *     became safety-net only — fires at 30 s with error toast.
 *
 * (4) Slow-launch false-positive (2026-05-13 evening): user reported a
 *     successful launch took ~50 s; the 30 s watchdog toasted "Couldn't
 *     start playback" while the engine was still progressing, then mpv
 *     appeared 20 s later. Fix: two-tier safety net — 30 s soft (status
 *     hint only, modal stays up), 60 s hard (true failure, modal
 *     dismissed + error toast).
 *
 * Each `it` block asserts an invariant from the above history. If a future
 * refactor reintroduces wall-clock-only quality fallback OR a single-tier
 * timeout that fires the error too eagerly, the test fails.
 */
describe("@bugfix @regression-proof MediaPlaybackController launch-stalled watchdog", () => {
  const sourcePath = resolve(
    process.cwd(),
    "src/renderer/src/components/MediaPlaybackController.tsx"
  );
  console.info(
    `[media-playback-launch-timeout:setup] reading watchdog source from ${sourcePath}`
  );
  const source = readFileSync(sourcePath, "utf8");
  console.info(
    `[media-playback-launch-timeout:setup] source loaded: ${source.length} chars, ${source.split("\n").length} lines`
  );

  // On assertion failure, dump the source-grep state this suite reasons about:
  // which timer-bodies were extracted from MediaPlaybackController.tsx and the
  // labelled fields we expect to find inside them. This makes a regex-match
  // failure debuggable offline without re-running against the live source.
  const dumpLaunchTimeoutSnapshot = (
    label: string,
    fields: Record<string, unknown>
  ) => {
    try {
      const softMatch = source.match(
        /softTimeout\s*=\s*window\.setTimeout\([\s\S]*?,\s*(\d+)\s*\)/
      );
      const hardMatch = source.match(
        /hardTimeout\s*=\s*window\.setTimeout\([\s\S]*?,\s*(\d+)\s*\)/
      );
      console.error(`=== [media-playback-launch-timeout:${label}] snapshot ===`);
      console.error(`sourcePath=${sourcePath}`);
      console.error(
        `softTimeout ms=${JSON.stringify(softMatch?.[1])} hardTimeout ms=${JSON.stringify(hardMatch?.[1])}`
      );
      console.error(`fields:\n${JSON.stringify(fields, null, 2)}`);
    } catch (err) {
      console.error(
        `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`
      );
    }
  };

  it("does not use a 10-second fallback timeout (the original false-positive value)", () => {
    console.info(
      `[media-playback-launch-timeout:no-10s] scanning for setTimeout(..., 10000)`
    );
    const offending = source.match(/setTimeout\([^)]+,\s*10000\)/);
    if (offending) {
      dumpLaunchTimeoutSnapshot("no-10s", { offendingMatch: offending[0] });
    }
    expect(source).not.toMatch(/setTimeout\([^)]+,\s*10000\)/);
  });

  it("uses a two-tier safety net: soft 30 s + hard 60 s", () => {
    console.info(
      `[media-playback-launch-timeout:two-tier] extracting soft + hard timeout values`
    );
    // Both timeouts must exist and be different. Soft = status hint only.
    // Hard = genuine failure (modal dismiss + error toast).
    const softMatch = source.match(/softTimeout\s*=\s*window\.setTimeout\([\s\S]*?,\s*(\d+)\s*\)/);
    const hardMatch = source.match(/hardTimeout\s*=\s*window\.setTimeout\([\s\S]*?,\s*(\d+)\s*\)/);
    const softMs = Number(softMatch?.[1] ?? 0);
    const hardMs = Number(hardMatch?.[1] ?? 0);
    console.info(
      `[media-playback-launch-timeout:two-tier] softMs=${softMs} hardMs=${hardMs} softMatched=${softMatch !== null} hardMatched=${hardMatch !== null}`
    );
    if (
      softMatch === null ||
      hardMatch === null ||
      !(softMs > 20000) ||
      !(hardMs > softMs) ||
      !(hardMs >= 60000)
    ) {
      dumpLaunchTimeoutSnapshot("two-tier", { softMs, hardMs });
    }
    expect(softMatch).not.toBeNull();
    expect(hardMatch).not.toBeNull();
    // Soft tier must be strictly outside the engine's deterministic budget.
    expect(softMs).toBeGreaterThan(20000);
    // Hard tier must be strictly later than soft tier — they're meant to be
    // staged, not redundant.
    expect(hardMs).toBeGreaterThan(softMs);
    // Hard tier should give real-world slow launches a chance (~50 s
    // observed). 60 s is a sensible floor.
    expect(hardMs).toBeGreaterThanOrEqual(60000);
  });

  it("both tiers short-circuit when isReadyToReveal is set (no race with engine ready-gate)", () => {
    console.info(
      `[media-playback-launch-timeout:short-circuit] extracting soft + hard timer bodies`
    );
    // Each timer callback's first decision must be the isReadyToReveal check.
    const softBody = source.match(
      /softTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    const hardBody = source.match(
      /hardTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    const softReadyIdx = softBody.indexOf("isReadyToReveal");
    const hardReadyIdx = hardBody.indexOf("isReadyToReveal");
    console.info(
      `[media-playback-launch-timeout:short-circuit] softBody.length=${softBody.length} hardBody.length=${hardBody.length} softReadyIdx=${softReadyIdx} hardReadyIdx=${hardReadyIdx}`
    );
    if (
      !/playback\.isReadyToReveal/.test(softBody) ||
      !/playback\.isReadyToReveal/.test(hardBody) ||
      /setIsLaunching|notifyError|setLaunchStatusHint/.test(softBody.slice(0, softReadyIdx)) ||
      /setIsLaunching|notifyError/.test(hardBody.slice(0, hardReadyIdx))
    ) {
      dumpLaunchTimeoutSnapshot("short-circuit", {
        softReadyIdx,
        hardReadyIdx,
        softBodyHead: softBody.slice(0, Math.max(softReadyIdx, 0)),
        hardBodyHead: hardBody.slice(0, Math.max(hardReadyIdx, 0)),
      });
    }
    expect(softBody).toMatch(/playback\.isReadyToReveal/);
    expect(hardBody).toMatch(/playback\.isReadyToReveal/);
    // The check must precede any side effect in both bodies.
    expect(softBody.slice(0, softReadyIdx)).not.toMatch(/setIsLaunching|notifyError|setLaunchStatusHint/);
    expect(hardBody.slice(0, hardReadyIdx)).not.toMatch(/setIsLaunching|notifyError/);
  });

  it("soft tier only updates the status hint — no error toast, no modal dismiss", () => {
    console.info(
      `[media-playback-launch-timeout:soft-hint-only] extracting soft timer body`
    );
    const softBody = source.match(
      /softTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    console.info(
      `[media-playback-launch-timeout:soft-hint-only] softBody.length=${softBody.length} hasStatusHint=${/setLaunchStatusHint/.test(softBody)} hasNotifyError=${/notifyError/.test(softBody)}`
    );
    if (
      !/setLaunchStatusHint/.test(softBody) ||
      !/player\.launchSlow/.test(softBody) ||
      /notifyError/.test(softBody) ||
      /setIsLaunching\(false\)/.test(softBody) ||
      /hideLoading/.test(softBody)
    ) {
      dumpLaunchTimeoutSnapshot("soft-hint-only", { softBody });
    }
    expect(softBody).toMatch(/setLaunchStatusHint/);
    expect(softBody).toMatch(/player\.launchSlow/);
    expect(softBody).not.toMatch(/notifyError/);
    expect(softBody).not.toMatch(/setIsLaunching\(false\)/);
    expect(softBody).not.toMatch(/hideLoading/);
  });

  it("hard tier dismisses the modal + surfaces error toast (genuine failure)", () => {
    console.info(
      `[media-playback-launch-timeout:hard-failure] extracting hard timer body`
    );
    const hardBody = source.match(
      /hardTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    console.info(
      `[media-playback-launch-timeout:hard-failure] hardBody.length=${hardBody.length} hasNotifyError=${/notifyError/.test(hardBody)} dismisses=${/setIsLaunching\(false\)/.test(hardBody)}`
    );
    if (
      !/notifyError/.test(hardBody) ||
      !/player\.abrLaunchFailed/.test(hardBody) ||
      !/setIsLaunching\(false\)/.test(hardBody)
    ) {
      dumpLaunchTimeoutSnapshot("hard-failure", { hardBody });
    }
    expect(hardBody).toMatch(/notifyError/);
    expect(hardBody).toMatch(/player\.abrLaunchFailed/);
    expect(hardBody).toMatch(/setIsLaunching\(false\)/);
  });

  it("no quality switch attempted by EITHER tier — ABR owns quality decisions @req PLAY-ABR-03", () => {
    console.info(
      `[media-playback-launch-timeout:no-quality-switch] extracting soft + hard timer bodies`
    );
    const softBody = source.match(
      /softTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    const hardBody = source.match(
      /hardTimeout\s*=\s*window\.setTimeout\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\d+\s*\)/
    )?.[1] ?? "";
    for (const [tier, body] of [["soft", softBody], ["hard", hardBody]] as const) {
      const hasQualityLogic =
        /tryAutoFallback/.test(body) ||
        /selectFixedFormat/.test(body) ||
        /networkSlow/.test(body);
      console.info(
        `[media-playback-launch-timeout:no-quality-switch] tier=${tier} bodyLength=${body.length} hasQualityLogic=${hasQualityLogic}`
      );
      if (hasQualityLogic) {
        dumpLaunchTimeoutSnapshot("no-quality-switch", { tier, body });
      }
      expect(body).not.toMatch(/tryAutoFallback/);
      expect(body).not.toMatch(/selectFixedFormat/);
      expect(body).not.toMatch(/networkSlow/);
    }
  });

  it("the getNextFallbackFormat / tryAutoFallback / attemptedFallbackFormatIdsRef helpers are removed", () => {
    console.info(
      `[media-playback-launch-timeout:helpers-removed] scanning whole source for removed fallback helpers`
    );
    const survivors = [
      "getNextFallbackFormat",
      "tryAutoFallback",
      "attemptedFallbackFormatIdsRef",
    ].filter((sym) => source.includes(sym));
    console.info(
      `[media-playback-launch-timeout:helpers-removed] survivingSymbols=${JSON.stringify(survivors)}`
    );
    if (survivors.length > 0) {
      dumpLaunchTimeoutSnapshot("helpers-removed", { survivors });
    }
    expect(source).not.toMatch(/getNextFallbackFormat/);
    expect(source).not.toMatch(/tryAutoFallback/);
    expect(source).not.toMatch(/attemptedFallbackFormatIdsRef/);
  });
});
