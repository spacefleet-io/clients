// What only `@space/shared/profileStore` and `@space/ui/profiles` may write (UI-PROFILES-SHARED-001), shared by
// profiles-shared.test.ts (the client apps) and profiles-shared.web-apps.test.ts (the website and web players, which
// stay private, so the public client repository leaves that file out).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const sources = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => (name === "node_modules" ? [] : sources(join(path, name))));
};

/** What only `@space/shared/profileStore` and `@space/ui/profiles` may write; `only` limits a pattern to some sources. */
const OWNED = [
  { what: "a library with no profile moves (use NO_LIBRARY_MOVES)", pattern: /listViewingProfileIds:\s*async\s*\(\)\s*=>\s*\[\]/ },
  { what: "a localStorage wrapper (use localStorageProfileStorage)", pattern: /getItem:\s*async\s*\(\w+\)\s*=>\s*(window\.)?localStorage\.getItem/ },
  { what: "Parrot's own avatar menu or Profiles section", pattern: /function (ParrotWebProfileMenu|ProfilesSection)\(|parrotProfileMoves|parrotWebMoves/, only: "apps/parrot/" },
];

/** Every own copy of an OWNED piece under `dirs` (repo-relative), as `<file>: <what>`. */
export const ownCopies = (dirs: readonly string[]): string[] =>
  dirs.flatMap((dir) =>
    sources(join(ROOT, dir)).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return OWNED.filter(({ pattern, only }) => (!only || file.includes(`/${only}`)) && pattern.test(text)).map(({ what }) => `${file.slice(ROOT.length + 1)}: ${what}`);
    }),
  );
