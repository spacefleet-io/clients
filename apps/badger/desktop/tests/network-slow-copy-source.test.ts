import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix Round-12 #3 — auto-fallback copy was blaming the user's connection
 * ("Connection seems slow…", "Connexion lente détectée…") even though the
 * trigger is a fixed 10s launch timeout, not a real bandwidth measurement.
 * Real-world cause is usually local first-load latency (cold gateway disk cache
 * + storage-gateway decryption overhead), not the user's network.
 *
 * @regression-proof Both i18n files must keep the network-slow keys, must keep
 * the {{quality}} interpolation token, and must NOT contain blame language
 * ("slow"/"lente"/"connection"/"connexion") in the user-facing strings.
 */

type LocaleJson = { player?: { networkSlowSwitching?: string; networkSlowToast?: string } };

const readLocale = (relativePath: string): LocaleJson => {
  const abs = resolve(process.cwd(), relativePath);
  console.info(`[network-slow-copy-source:read] loading locale ${abs}`);
  return JSON.parse(readFileSync(abs, "utf8")) as LocaleJson;
};

// Dump the actual network-slow strings from both locales on assertion
// failure. try/catch so a dump failure can't mask the real expect().
const dumpNetworkSlowCopySnapshot = (
  label: string,
  en: LocaleJson,
  fr: LocaleJson,
) => {
  try {
    console.error(`=== [network-slow-copy-source:${label}] snapshot ===`);
    console.error(`en.networkSlowSwitching=${JSON.stringify(en.player?.networkSlowSwitching)}`);
    console.error(`en.networkSlowToast=${JSON.stringify(en.player?.networkSlowToast)}`);
    console.error(`fr.networkSlowSwitching=${JSON.stringify(fr.player?.networkSlowSwitching)}`);
    console.error(`fr.networkSlowToast=${JSON.stringify(fr.player?.networkSlowToast)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("auto-fallback launch-timeout copy stays neutral", () => {
  console.info("[network-slow-copy-source:setup] reading en + fr locale JSON");
  const en = readLocale("src/renderer/src/i18n/en.json");
  const fr = readLocale("src/renderer/src/i18n/fr.json");

  it("keeps both network-slow keys in en and fr", () => {
    console.info(
      `[network-slow-copy-source:keys] en.switching type=${typeof en.player?.networkSlowSwitching} en.toast type=${typeof en.player?.networkSlowToast} fr.switching type=${typeof fr.player?.networkSlowSwitching} fr.toast type=${typeof fr.player?.networkSlowToast}`,
    );
    if (
      typeof en.player?.networkSlowSwitching !== "string" ||
      typeof en.player?.networkSlowToast !== "string" ||
      typeof fr.player?.networkSlowSwitching !== "string" ||
      typeof fr.player?.networkSlowToast !== "string"
    ) {
      dumpNetworkSlowCopySnapshot("keys", en, fr);
    }
    expect(typeof en.player?.networkSlowSwitching).toBe("string");
    expect(typeof en.player?.networkSlowToast).toBe("string");
    expect(typeof fr.player?.networkSlowSwitching).toBe("string");
    expect(typeof fr.player?.networkSlowToast).toBe("string");
  });

  it("keeps the {{quality}} interpolation token in every variant", () => {
    console.info("[network-slow-copy-source:token] checking {{quality}} in all 4 strings");
    if (
      !en.player?.networkSlowSwitching?.includes("{{quality}}") ||
      !en.player?.networkSlowToast?.includes("{{quality}}") ||
      !fr.player?.networkSlowSwitching?.includes("{{quality}}") ||
      !fr.player?.networkSlowToast?.includes("{{quality}}")
    ) {
      dumpNetworkSlowCopySnapshot("token", en, fr);
    }
    expect(en.player?.networkSlowSwitching).toContain("{{quality}}");
    expect(en.player?.networkSlowToast).toContain("{{quality}}");
    expect(fr.player?.networkSlowSwitching).toContain("{{quality}}");
    expect(fr.player?.networkSlowToast).toContain("{{quality}}");
  });

  it("does not blame the user's connection (en)", () => {
    const enSwitching = (en.player?.networkSlowSwitching ?? "").toLowerCase();
    const enToast = (en.player?.networkSlowToast ?? "").toLowerCase();
    console.info(
      `[network-slow-copy-source:blame-en] switching=${JSON.stringify(enSwitching)} toast=${JSON.stringify(enToast)}`,
    );
    if (
      enSwitching.includes("slow") ||
      enSwitching.includes("connection") ||
      enToast.includes("slow") ||
      enToast.includes("connection")
    ) {
      dumpNetworkSlowCopySnapshot("blame-en", en, fr);
    }
    expect(enSwitching).not.toContain("slow");
    expect(enSwitching).not.toContain("connection");
    expect(enToast).not.toContain("slow");
    expect(enToast).not.toContain("connection");
  });

  it("does not blame the user's connection (fr)", () => {
    const frSwitching = (fr.player?.networkSlowSwitching ?? "").toLowerCase();
    const frToast = (fr.player?.networkSlowToast ?? "").toLowerCase();
    console.info(
      `[network-slow-copy-source:blame-fr] switching=${JSON.stringify(frSwitching)} toast=${JSON.stringify(frToast)}`,
    );
    if (
      frSwitching.includes("lente") ||
      frSwitching.includes("connexion") ||
      frToast.includes("lente") ||
      frToast.includes("connexion")
    ) {
      dumpNetworkSlowCopySnapshot("blame-fr", en, fr);
    }
    expect(frSwitching).not.toContain("lente");
    expect(frSwitching).not.toContain("connexion");
    expect(frToast).not.toContain("lente");
    expect(frToast).not.toContain("connexion");
  });
});
