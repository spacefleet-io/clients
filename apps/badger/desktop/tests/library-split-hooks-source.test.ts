import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

// On a contract miss, dump exactly which token was expected/forbidden and which
// of the two failed, so the failing source file is obvious without re-grepping.
const dumpSplitHooksSnapshot = (
  label: string,
  file: string,
  source: string,
  required: string[],
  forbidden: string[],
) => {
  try {
    console.error(`=== [library-split-hooks-source:${label}] snapshot ===`);
    console.error(`file=${file} sourceLength=${source.length}`);
    for (const token of required) {
      console.error(`required "${token}" present=${source.includes(token)}`);
    }
    for (const token of forbidden) {
      console.error(`forbidden "${token}" present=${source.includes(token)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert a file's required/forbidden token contract, dumping on the first miss.
const assertHookContract = (
  label: string,
  file: string,
  source: string,
  required: string[],
  forbidden: string[],
) => {
  console.info(
    `[library-split-hooks-source:check] ${file} required=${JSON.stringify(required)} forbidden=${JSON.stringify(forbidden)}`,
  );
  const missing = required.filter((t) => !source.includes(t));
  const leaked = forbidden.filter((t) => source.includes(t));
  if (missing.length > 0 || leaked.length > 0) {
    dumpSplitHooksSnapshot(label, file, source, required, forbidden);
  }
  for (const token of required) expect(source).toContain(token);
  for (const token of forbidden) expect(source).not.toContain(token);
};

describe("renderer split library hook source contracts", () => {
  it("keeps secondary routes on split library contexts", () => {
    console.info(`[library-split-hooks-source:setup] reading secondary route sources`);
    // The settings page is now a thin shell that delegates to per-section
    // components; the library-context consumption moved into the sections.
    // The split-context guard (never the monolithic `useLibrary()`) still
    // applies to every settings file that touches the library.
    const settingsShell = readSource("src/renderer/src/components/settings/SettingsLayout.tsx");
    const generalSection = readSource("src/renderer/src/components/settings/sections/GeneralSection.tsx");
    const trailersSection = readSource("src/renderer/src/components/settings/sections/TrailersSection.tsx");
    const playlists = readSource("src/renderer/src/pages/Playlists.tsx");
    const onboardingKey = readSource("src/renderer/src/pages/OnboardingKey.tsx");

    // ACCT-PROF-03 took the library-wide title language (and its re-fetch) out of General: it reads no library now.
    assertHookContract("general-section", "GeneralSection.tsx", generalSection, [], ["useLibrary()"]);
    assertHookContract("trailers-section", "TrailersSection.tsx", trailersSection, ["useLibraryActions"], ["useLibrary()"]);
    assertHookContract("settings-shell", "SettingsLayout.tsx", settingsShell, [], ["useLibrary()"]);
    assertHookContract(
      "playlists",
      "Playlists.tsx",
      playlists,
      ["useLibraryActions", "useLibraryData"],
      ["useLibrary()"],
    );
    assertHookContract(
      "onboarding-key",
      "OnboardingKey.tsx",
      onboardingKey,
      ["useLibraryActions", "useLibraryShell"],
      ["useLibrary()"],
    );
  });

  it("keeps heavy playback and media dialogs on split library contexts", () => {
    console.info(`[library-split-hooks-source:setup] reading heavy dialog sources`);
    const mediaDetails = readSource("src/renderer/src/components/MediaDetailsDialog.tsx");
    const mediaPlaybackController = readSource("src/renderer/src/components/MediaPlaybackController.tsx");
    const fileIngestion = readSource("src/renderer/src/components/FileIngestionDialog.tsx");

    assertHookContract(
      "media-details",
      "MediaDetailsDialog.tsx",
      mediaDetails,
      ["useLibraryActions", "useLibraryData", "useLibraryShell"],
      ["useLibrary()"],
    );
    assertHookContract(
      "playback-controller",
      "MediaPlaybackController.tsx",
      mediaPlaybackController,
      ["useLibraryActions", "useLibraryShell"],
      ["useLibrary()"],
    );
    assertHookContract(
      "file-ingestion",
      "FileIngestionDialog.tsx",
      fileIngestion,
      ["useLibraryActions", "useLibraryData"],
      ["useLibrary()"],
    );
  });
});
