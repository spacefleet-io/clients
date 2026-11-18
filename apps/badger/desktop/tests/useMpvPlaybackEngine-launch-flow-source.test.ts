import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Source-contract net for the long chain of mpv-playback launch-flow
 * fixes. Each assertion below pins a specific commit's invariant. If a
 * future refactor reintroduces the pre-fix shape, the matching test fails
 * loudly — even when the behavioural surface area is too gnarly to drive
 * directly through unit tests.
 *
 * Bugs covered (in commit order):
 *
 *  - 90f08221 — synchronous lifecycleRef sync (lifecycleRef declared & assigned each render).
 *  - 3d94a69a — in-place track-selection reset (no `key={mediaId:requestId}` remount).
 *  - 5d29bc40 — useMemo'd media prop fed to MediaPlaybackController.
 *  - a8ae26ca — launchInProgressRef latch acquired SYNCHRONOUSLY inside `loadStream`'s entry guard.
 *  - 1f6081e8 — exposed `setSelectedAudio` is wrapped in `useCallback` so its identity is stable.
 *  - f4f84920 — audio/sub reset effect sets the new default DIRECTLY (no setX(null) intermediate).
 *  - 9a83087a — init effect early-returns when `launchInProgressRef.current` is true.
 *  - 0c601c79 — HLS prewarm + `--demuxer-cache-wait=yes` mpv flag.
 *  - ede80b62 — prewarm capped at 2 s via Promise.race; ensureExternalSeek gated on `isReadyToRevealRef` (not lifecycle).
 *  - 9928ac71 — subtitle cache capped at 3 s; superseded by PLAY-TRACK-07 interim (MPV-SUBLATE-001): launch never
 *    waits on a subtitle download and mpv never gets a raw proxy URL for a sidecar.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);

const CONTROLLER_PATH = resolve(
  process.cwd(),
  "src/renderer/src/components/MediaPlaybackController.tsx",
);

const DIALOG_PATH = resolve(
  process.cwd(),
  "src/renderer/src/components/MediaDetailsDialog.tsx",
);

const MPV_EXTERNAL_PATH = resolve(
  process.cwd(),
  "../../../packages/mpv/src/external.ts",
);

const engineSource = readFileSync(ENGINE_PATH, "utf8");
const controllerSource = readFileSync(CONTROLLER_PATH, "utf8");
const dialogSource = readFileSync(DIALOG_PATH, "utf8");
const mpvExternalSource = readFileSync(MPV_EXTERNAL_PATH, "utf8");

describe("@bugfix @regression-proof useMpvPlaybackEngine launch-flow source contract", () => {
  it("0c601c79 → #25 playable-start: --demuxer-cache-wait=yes is only the first-GOP resume prefill", () => {
    // The wait must be conditional on cacheSecs > 0 (so disabling cache via
    // env disables the wait too) AND on a resume into the first GOP: every
    // other launch starts as soon as the stream is playable (Chris,
    // 2026-10-09). Behaviour: mpv-start-latency-args.test.ts.
    expect(mpvExternalSource).toMatch(/firstGopPrefill\s*=\s*cacheSecs\s*>\s*0\s*&&/);
    expect(mpvExternalSource).toMatch(/firstGopPrefill\s*\?\s*\["--demuxer-cache-wait=yes"\]\s*:\s*\[\]/);
  });

  it("a8ae26ca → PR 3.2c-3: loadStream's concurrency protection is now phase-based (latch refs deleted)", () => {
    // Pre-3.2c-3: `launchInProgressRef` latch was set synchronously in
    // loadStream's entry guard before any await. PR 3.2c-3 deleted the
    // latch refs entirely. Concurrent entry is now prevented by:
    //   (1) start_load dispatched SYNCHRONOUSLY at the init-effect top
    //       (PR 3.2c-2) before any await, advancing phase to `launching`.
    //   (2) The init-effect's own `isLoadInFlight(phaseRef.current)` guard
    //       (PR 3.2c-1) short-circuits subsequent dep-change re-fires
    //       BEFORE they can re-enter loadStream.
    // Source contract: the engine no longer contains the latch refs.
    expect(engineSource).not.toContain("const launchInProgressRef = useRef(false);");
    expect(engineSource).not.toContain(
      "const initEffectInFlightRef = useRef(false);",
    );
    // And the "launch already in progress, skipping" log shape is gone.
    expect(engineSource).not.toContain(
      "loadStream: launch already in progress, skipping",
    );
  });

  it("9a83087a + PR 3.2c-1: init effect early-returns when a load is in flight (phase-derived)", () => {
    // The init useEffect's body reads `isLoadInFlight(phaseRef.current)`
    // and skips. PR 3.2c-1 flipped the reader to the phase-derived
    // predicate after the shadow-mode gate run confirmed zero divergence.
    // PR 3.2c-3 then removed the underlying flag refs entirely.
    // Issue #25 (c035): the read moved into decideInitEntry, which never
    // returns "proceed" while a load is in flight (a pending format switch
    // is queued and re-fired once the load settles).
    const initGuard = engineSource.match(
      /loadInFlight: isLoadInFlight\(phaseRef\.current\)[\s\S]{0,600}?if \(entryDecision !== "proceed"\) \{[\s\S]{0,2000}?return;/,
    );
    expect(initGuard, "init effect must early-return when a load is in flight").toBeTruthy();
  });

  it("ede80b62 + PR 3.2d + PR 4.1c: ensureExternalSeek gates on seeksAllowed(phaseRef.current) (not a raw lifecycle check)", () => {
    // The seek gate must read `seeksAllowed(phaseRef.current)`. History:
    //   pre-ede80b62: incorrectly read lifecycle.kind (blocked ALL seeks)
    //   ede80b62: read `isReadyToRevealRef.current && streamLoadfileCompleteRef.current` (the AND)
    //   PR 3.2d: collapsed the AND into the phase predicate
    //   PR 4.1c: ensureExternalSeek moved from useMpvPlaybackEngine.ts
    //     to lib/useExternalMpvCommands.ts (the new facade).
    const facadeSource = readFileSync(
      resolve(process.cwd(), "src/renderer/src/lib/useExternalMpvCommands.ts"),
      "utf8",
    );
    const gateBody = facadeSource.match(
      /const ensureExternalSeek = useCallback\([\s\S]*?\}, \[/,
    )?.[0] ?? "";
    expect(gateBody, "ensureExternalSeek body must be present in the facade").toBeTruthy();
    expect(gateBody).toMatch(/!seeksAllowed\(phaseRef\.current\)/);
    // Must NOT use a raw lifecycle.kind compare as the gate (that was
    // the broken implementation we replaced at ede80b62).
    expect(gateBody).not.toMatch(/lifecycleRef\.current\.kind !== ["']?playing/);
    // Must NOT use the pre-3.2d flag-AND shape either.
    expect(gateBody).not.toMatch(
      /!isReadyToRevealRef\.current\s*\|\|\s*!streamLoadfileCompleteRef\.current/,
    );
  });

  it("ede80b62: HLS prewarm is wrapped in a Promise.race with a PREWARM_BUDGET_MS cap (2 s)", () => {
    // The budget constant must exist and equal 2000 ms — the prewarm
    // pre-launch wait MUST be bounded so a slow tunnel can't block the
    // window-hide path indefinitely.
    expect(engineSource).toMatch(/const PREWARM_BUDGET_MS\s*=\s*2000;/);
    // It must be raced against the prewarmPlaybackHlsSession promise.
    // Both `prewarmPlaybackHlsSession` and `Promise.race(...PREWARM_BUDGET_MS...)`
    // must appear in proximity (cap distance to keep the assertion tight).
    const prewarmCall = engineSource.search(/window\.sf\?\.prewarmPlaybackHlsSession/);
    expect(prewarmCall).toBeGreaterThan(-1);
    // Slice from the call site forward — Promise.race against the budget
    // must appear within ~600 characters (the actual race lives ~10 lines
    // below the call).
    const after = engineSource.slice(prewarmCall, prewarmCall + 800);
    expect(after).toMatch(/Promise\.race/);
    expect(after).toMatch(/PREWARM_BUDGET_MS/);
  });

  it("PLAY-TRACK-07 interim: launch payload carries only sidecars already on disk; the rest land later", () => {
    // The 3 s race and its raw-URL fallback held the picture (mpv reads an external subtitle up to the playing
    // moment before the next frame). MPV-SUBLATE-001 covers the split / late fill themselves.
    expect(engineSource).not.toMatch(/SUBTITLE_CACHE_BUDGET_MS/);
    expect(engineSource).not.toMatch(/cachedSubtitles\s*=\s*subtitlePayload;/);
    const build = engineSource.slice(
      engineSource.indexOf("const buildExternalMetadataPayload = useCallback"),
      engineSource.indexOf("const sendExternalMetadata = useCallback"),
    );
    expect(build).toMatch(/splitLaunchSidecars\(/);
    expect(build).toMatch(/fillLateSidecars\(/);
    expect(build).toMatch(/subtitles:\s*launchSubtitles/);
  });

  it("PLAY-TRACK-07 interim: the subtitle effect leaves a sidecar the late fill owns to it (no second sub-add)", () => {
    const effect = engineSource.slice(engineSource.indexOf("const applyExternalSubtitle = async"));
    const owns = effect.search(/lateSidecarsRef\.current\?\.owns\(/);
    const subAdd = effect.search(/buildSubAddCommand\(/);
    expect(owns).toBeGreaterThan(-1);
    expect(owns).toBeLessThan(subAdd);
  });

  it("1f6081e8: setSelectedAudio is wrapped in useCallback with an empty deps array (stable identity)", () => {
    // The renderer's exposed `setSelectedAudioId` (renamed setSelectedAudio
    // internally) MUST be a stable reference across renders so the
    // controller's requestId reset effect doesn't re-fire on every engine
    // commit.
    const stableSetter = engineSource.match(
      /const setSelectedAudio = useCallback\(\(trackId: string \| null\) => \{\s*setSelectedAudioId\(trackId\);\s*\}, \[\]\);/,
    );
    expect(stableSetter, "setSelectedAudio must be useCallback with empty deps").toBeTruthy();
    // And it must be the one returned to consumers under the
    // `setSelectedAudioId` key on the engine's return object.
    expect(engineSource).toMatch(/setSelectedAudioId:\s*setSelectedAudio,/);
  });

  it("f4f84920: requestId-keyed audio/sub reset sets the new default DIRECTLY (no null intermediate)", () => {
    // The reset useEffect lives in MediaPlaybackController and must:
    // - read audioDefault and subDefault from currentMediaRef
    // - call resetAudio(audioDefault) and resetSub(subDefault)
    // - NOT call resetAudio(null) followed by a resolver re-pick (pre-fix shape).
    const resetBlock = controllerSource.match(
      /useEffect\(\(\) => \{[\s\S]*?if \(!requestId\) return;[\s\S]*?audioDefault[\s\S]*?subDefault[\s\S]*?resetAudio\(audioDefault\)[\s\S]*?resetSub\(subDefault\)[\s\S]*?\}, \[requestId/,
    );
    expect(resetBlock, "reset effect must set new default directly, not via null").toBeTruthy();
    // Pre-fix shape would be `resetAudio(null)` BEFORE the resolver kicked
    // in — guard against that ever coming back.
    const body = resetBlock?.[0] ?? "";
    expect(body).not.toMatch(/resetAudio\(null\)/);
  });

  it("3d94a69a: MediaDetailsDialog renders MediaPlaybackController WITHOUT a requestId-bearing key (in-place reset)", () => {
    // Pre-fix the dialog had `<MediaPlaybackController key={`${media.id}:${requestId}`} ...>`
    // which produced a mount-storm on every Play click. Post-fix the
    // component remounts ONLY at the position-based default key; the
    // requestId arrives as a PROP and drives the in-place reset effect.
    //
    // Pinpoint the JSX site in MediaDetailsDialog: from the `<MediaPlaybackController`
    // opening tag to the `/>` closing self-close — the slice MUST NOT
    // contain a `key=` attribute that mentions `requestId`.
    const jsxSlice = dialogSource.match(/<MediaPlaybackController[\s\S]*?\/>/)?.[0] ?? "";
    expect(jsxSlice, "MediaDetailsDialog must render MediaPlaybackController").toBeTruthy();
    // Strip JSX-style line comments so a historical mention of the bug
    // shape inside `// ...` doesn't fool a literal regex.
    const stripped = jsxSlice
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // No actual JSX key= attribute that references requestId.
    expect(stripped).not.toMatch(/\bkey=\s*\{[^}]*requestId[^}]*\}/);
  });

  it("5d29bc40: MediaDetailsDialog memoizes the playbackMedia prop fed to the controller", () => {
    // The dialog computes `playbackMedia` via useMemo and passes it as the
    // `media` prop. Without this, every selectedDetails reassignment from
    // background library syncs would propagate into the engine and trigger
    // re-renders (which then cascade into init-effect re-fires).
    expect(dialogSource).toMatch(/const playbackMedia = useMemo\(/);
    // The memo must feed the controller's media prop.
    const jsxSlice = dialogSource.match(/<MediaPlaybackController[\s\S]*?\/>/)?.[0] ?? "";
    expect(jsxSlice).toMatch(/media=\{playbackMedia\}/);
  });

  it("90f08221: lifecycleRef is synced synchronously each render (lifecycleRef.current = lifecycle)", () => {
    expect(engineSource).toMatch(/lifecycleRef\.current\s*=\s*lifecycle\b/);
  });
});
