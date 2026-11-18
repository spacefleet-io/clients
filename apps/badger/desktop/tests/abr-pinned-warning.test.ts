/**
 * @test-id DESKTOP-ABR-PINNED-WARNING-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * PLAY-QUAL-03: with "Force this quality" (or a pick inside the player) the rung is pinned, but when the network cannot
 * sustain it the user is still told, at most once a minute. The decision and the rate limit live in `@space/playback-abr`
 * (`stepNetworkAbr` returns `warn`, pinned by packages/playback-abr/tests/network-only.test.ts). This pins the desktop side:
 * the engine turns that action into the toast, and both locales carry the text. Removing the toast with the old desktop ABR
 * was a regression.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[abr-pinned-warning]";
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");

describe("desktop pinned-rung network warning", () => {
  /** @req PLAY-QUAL-03[badger-desktop] */
  it("the engine toasts the shared controller's warn action and never switches on it", () => {
    const engine = read("../src/renderer/src/lib/useMpvPlaybackEngine.ts");
    const warnBlock = engine.match(/if \(action\.kind === "warn"\) \{[\s\S]*?\n {8}\}\n/)?.[0] ?? "";
    console.info(`${LOG} warn block length=${warnBlock.length}`);
    expect(warnBlock).toContain('t("player.abrInsufficient"');
    expect(warnBlock).toContain("return;");
    expect(warnBlock).not.toContain("selectFixedFormatRef");
  });

  it("en and fr both define player.abrInsufficient with its three placeholders", () => {
    for (const locale of ["en", "fr"]) {
      const json = JSON.parse(read(`../src/renderer/src/i18n/${locale}.json`)) as { player: Record<string, string> };
      const text = json.player.abrInsufficient;
      console.info(`${LOG} ${locale}: ${text}`);
      expect(text, `${locale}.json player.abrInsufficient`).toBeTruthy();
      for (const placeholder of ["{{current}}", "{{mbps}}", "{{recommended}}"]) expect(text).toContain(placeholder);
    }
  });
});
