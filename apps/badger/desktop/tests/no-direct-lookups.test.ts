/**
 * The desktop has no direct lookup mode (META-DIRECT-03): the own-TMDB-key setting was removed, every TMDB
 * lookup and every picture goes through the metadata service with a ticket (META-ART-02), and the copy users
 * read never calls Badger a proxy for TMDB (UX-COPY-03).
 *
 * Source scans over the desktop's renderer, main, preload and shared code, the desktop locales, and the config
 * migration that drops a saved own-key mode so that user falls back to the ticket path.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadClientConfig } from "../src/renderer/src/lib/config";

const P = "[no-direct-lookups.test]";
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["src/renderer", "src/main", "src/preload", "src/shared"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|html|json)$/;

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path);
    return SOURCE_EXT.test(name) ? [path] : [];
  });

const scan = (pattern: RegExp) => {
  const files = SOURCE_DIRS.flatMap((dir) => listFiles(join(DESKTOP_ROOT, dir)));
  const offenders = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(DESKTOP_ROOT, file)}:${index + 1}: ${line.trim()}`] : []))
  );
  return { scanned: files.length, offenders };
};

describe("desktop TMDB access goes only through the metadata service", () => {
  // @req META-ART-02[badger-desktop]
  it("no desktop code references TMDB's image CDN", () => {
    const result = scan(/image\.tmdb\.org/);
    console.info(P, "image CDN scan", JSON.stringify(result));
    expect(result.scanned).toBeGreaterThan(100);
    expect(result.offenders).toEqual([]);
  });

  // @req META-DIRECT-03[badger-desktop]
  it("no desktop code calls TMDB's API or keeps an own-TMDB-key setting", () => {
    const api = scan(/api\.themoviedb\.org|themoviedb\.org\/3/);
    const ownKey = scan(/metadataAccess|usesOwnTmdbKey|tmdbHealthCheck|TMDB_KEY_REQUIRED|tmdbOwnKey|tmdbKeyRequired/);
    // lib/config.ts names the old field only to erase it from a saved config (migration tested below).
    const MIGRATION_FILE = "src/renderer/src/lib/config.ts:";
    const ownKeyOutsideMigration = ownKey.offenders.filter((line) => !line.startsWith(MIGRATION_FILE));
    console.info(P, "TMDB API scan", JSON.stringify(api), "own-key scan", JSON.stringify(ownKey));
    expect(api.offenders).toEqual([]);
    expect(ownKeyOutsideMigration).toEqual([]);
  });
});

describe("desktop copy never calls Badger a proxy", () => {
  // @req UX-COPY-03[badger-desktop]
  it("no desktop locale string says proxy, relay or 'through our services'", () => {
    const localeDir = join(DESKTOP_ROOT, "src/renderer/src/i18n");
    const locales = readdirSync(localeDir).filter((name) => name.endsWith(".json"));
    const pattern = /\b(proxy|proxies|relay|relays|relais|go-between|intermédiaire)\b|through our services|par nos services/i;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string, locale: string) => {
      if (typeof node === "string") {
        if (pattern.test(node)) offenders.push(`${locale}:${path}: ${node}`);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key, locale);
      }
    };
    for (const locale of locales) walk(JSON.parse(readFileSync(join(localeDir, locale), "utf8")), "", locale);
    console.info(P, "locale scan", JSON.stringify({ locales, offenders }));
    expect(locales.length).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});

describe("config migration drops the removed own-TMDB-key mode", () => {
  const CONFIG_KEY = "sf_client_config_v1";
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fakeStorage = (initial: Record<string, string>) => {
    const map = new Map(Object.entries(initial));
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key);
        map.set(key, value);
      },
      removeItem: (key: string) => void map.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
    return { map, writes };
  };

  // @req META-DIRECT-03[badger-desktop]
  it("a user who had direct mode on silently falls back to the ticket path, and the saved key is erased", () => {
    const saved = {
      playbackQuality: "720p",
      metadataAccess: { tmdb: { mode: "direct", apiKey: "secret-user-key", validated: true } },
    };
    const { map, writes } = fakeStorage({ [CONFIG_KEY]: JSON.stringify(saved) });

    const config = loadClientConfig();
    const stored = map.get(CONFIG_KEY) ?? "";
    console.info(P, "migrated config", JSON.stringify(config), "stored", stored, "writes", JSON.stringify(writes));
    expect("metadataAccess" in config).toBe(false);
    expect(config.playbackQuality).toBe("720p");
    expect(stored).not.toContain("secret-user-key");
    expect(stored).not.toContain("metadataAccess");
    expect(writes).toEqual([CONFIG_KEY]);

    // Once migrated, loading again writes nothing.
    loadClientConfig();
    console.info(P, "writes after second load", JSON.stringify(writes));
    expect(writes).toEqual([CONFIG_KEY]);
  });

  it("a config without the old setting is read without a write", () => {
    const { writes } = fakeStorage({ [CONFIG_KEY]: JSON.stringify({ playbackQuality: "480p" }) });
    const config = loadClientConfig();
    console.info(P, "plain config", JSON.stringify(config), "writes", JSON.stringify(writes));
    expect(config.playbackQuality).toBe("480p");
    expect(writes).toEqual([]);
  });
});
