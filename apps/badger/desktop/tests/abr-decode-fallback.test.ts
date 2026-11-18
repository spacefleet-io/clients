// Issue #25 (Chris, 2026-10-15) / PLAY-CODEC-01..03: Auto quality must notice when this computer cannot keep up with the
// playing version and move to a lighter one, or say it is too weak when nothing lighter is left.
//
// Live evidence (/tmp/sf-abr-live/decode.sh, mpv 0.41, software decode,
// one decoder thread, CPUQuota=40%, vo/ao null, healthy cache):
//   HEVC 1080p  frame-drop-count 17 → 47 → 118 → 152 over 6–24 s,
//               decoder-frame-drop-count 0, paused-for-cache false,
//               cache-duration full.
//   H.264 1080p frame-drop-count 0 for 30 s under the same quota.
// So decode-bound = a rising drop count while the buffer is healthy, which a
// starved network never produces (it underruns instead).
//
// The detector and the decision are the shared @space/playback-abr ones (`stepDecoder`: the lag detector, then
// `planDecodeFallback`), pinned with simulated mpv drop stats in packages/playback-abr/tests/decode-fallback.test.ts.
// This file pins what is desktop-only: that the engine feeds the decoder step mpv's properties, passes the ladder rebuilt
// with the playing codec blocked, acts on its switch and too-weak verdicts, and that the notice strings exist.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[abr-decode-fallback]";
const engine = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
const LOCALES = ["en", "fr", "nl", "de", "es"] as const;

const present = (phase: string, needles: Record<string, RegExp | string | boolean>): Record<string, boolean> => {
  const found = Object.fromEntries(
    Object.entries(needles).map(([name, needle]) => [
      name,
      typeof needle === "boolean" ? needle : typeof needle === "string" ? engine.includes(needle) : needle.test(engine),
    ]),
  );
  console.info(`${LOG} phase=${phase} ${JSON.stringify(found)}`);
  return found;
};

const allTrue = (found: Record<string, boolean>) => Object.fromEntries(Object.keys(found).map((k) => [k, true]));

describe("desktop decoder fallback wiring (PLAY-CODEC-01/02/03)", () => {
  /** @req PLAY-CODEC-01[badger-desktop] @req PLAY-QUAL-06[badger-desktop] */
  it("the engine runs the shared decoder step first, fed with mpv's drop / desync / position evidence", () => {
    const found = present("decoder-step", {
      decoderFirst: "stepDecoder(abrCtrl, variants, sample) ?? stepNetworkAbr(abrCtrl, variants, sample)",
      softwareDecodeIsNoVerdict: /decoderPolicy: "any"/,
      readsDrops: /"frame-drop-count"[\s\S]{0,200}"decoder-frame-drop-count"/,
      readsAvsync: /getProperty\(sendExternalRequestRaw, "avsync"\)/,
      readsTimePos: /getProperty\(sendExternalRequestRaw, "time-pos"\)/,
      readsHwdec: /getProperty\(sendExternalRequestRaw, "hwdec-current"\)/,
      codecFromLibrary: /const videoCodec = currentFmt\.codec \?\? null;/,
      newLoadRestartsWindow: /abrDecodeKeyRef\.current = decodeKey;\s*resetLagDetector\(abrCtrl\.lag, now\);/,
      oldDetectorGone: !/abrDecodeHealth|createDecodeHealthMonitor|decodeBound/.test(engine),
    });
    expect(found).toEqual(allTrue(found));
  });

  /** @req PLAY-CODEC-01[badger-desktop] */
  it("@bugfix @regression-proof the engine ladder honours the codec block and the decoder step sees the rebuilt ladder", () => {
    const found = present("ladder", {
      ladderHonoursBlock: /buildPlaybackFormatsForFile\(media\.formats, fileId, abrBlockedCodecs\)/,
      fallbackLadderRebuilt:
        /buildPlaybackFormatsForFile\(\s*ladderInputs\.libraryFormats,\s*ladderInputs\.fileId,\s*new Set\(\[\.\.\.ladderInputs\.blockedCodecs, currentFmt\.codec\]\)/,
      fallbackLadderPassed: /decodeVariants:\s*currentFmt\.codec && needsH264Fallback\(currentFmt\.codec\)\s*\?\s*toVariants\(/,
      hevcFallbackBlocksCodec: /const blockCodec = action\.reason === "hevc-fallback" \? currentFmt\.codec : null;/,
      blockIsState: /setAbrBlockedCodecs\(/,
      switchesThroughAbrSource: /"abr decode-fallback"[\s\S]{0,400}selectFixedFormatRef\.current\(action\.targetId, "abr"\)/,
    });
    expect(found).toEqual(allTrue(found));
  });

  /** @req PLAY-CODEC-02[badger-desktop] */
  it("the fallback is per file: a new file clears the decode ceiling, the bans, the too-weak flag and the lag window", () => {
    const found = present("per-file", {
      clearsCeiling: /bannedIds: \[\], decodeCeilingRank: null \};\s*abrCtrl\.tooWeakNotified = false;\s*resetLagDetector\(abrCtrl\.lag, Date\.now\(\)\);\s*\}, \[abrCtrl, fileId\]\);/,
      pinnedIsManual: /mode: pinned \? "manual" : "auto"/,
    });
    expect(found).toEqual(allTrue(found));
  });

  /** @req PLAY-CODEC-03[badger-desktop] @req PLAY-QUAL-03[badger-desktop] */
  it("nothing lighter left (or pinned): a lasting 'not powerful enough' notice with Keep watching, never a pause", () => {
    const tooWeak = engine.slice(engine.indexOf('if (action.kind === "too-weak")'), engine.indexOf('if (action.kind !== "switch") return;'));
    console.info(`${LOG} phase=too-weak-branch length=${tooWeak.length}`);
    const checks = {
      branch: tooWeak.length > 0,
      logs: tooWeak.includes('"abr device-too-weak"'),
      message: tooWeak.includes('t("player.deviceTooWeak.message")'),
      pinnedHint: /action\.pinned \? `\$\{message\} \$\{t\("player\.deviceTooWeak\.pinnedHint"\)\}` : message/.test(tooWeak),
      keepWatching: tooWeak.includes('label: t("player.deviceTooWeak.keepWatching")'),
      lasts: tooWeak.includes("duration: Infinity"),
      neverSwitchesOrPauses: !/selectFixedFormatRef|"pause"|cycle pause/.test(tooWeak),
    };
    console.info(`${LOG} phase=too-weak ${JSON.stringify(checks)}`);
    expect(checks).toEqual(allTrue(checks));
  });

  /** @req PLAY-CODEC-03[badger-desktop] */
  it.each(LOCALES)("the %s strings exist and the fallback toast no longer claims H.264", (locale) => {
    const strings = JSON.parse(readFileSync(resolve(__dirname, `../src/renderer/src/i18n/${locale}.json`), "utf8")).player;
    console.info(`${LOG} phase=i18n locale=${locale} ${JSON.stringify({ fallback: strings.abrDecodeFallback, tooWeak: strings.deviceTooWeak })}`);
    expect(strings.deviceTooWeak.message).toBeTruthy();
    expect(strings.deviceTooWeak.pinnedHint).toBeTruthy();
    expect(strings.deviceTooWeak.keepWatching).toBeTruthy();
    expect(strings.abrDecodeFallback).toContain("{{quality}}");
    expect(strings.abrDecodeFallback).not.toContain("H.264");
  });
});
