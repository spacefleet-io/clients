/**
 * @test-id UI-PROFILES-SHARED-001
 * @level unit
 * @req REL-FAM-03[badger-desktop]
 * @req REL-FAM-03[parrot]
 * @why Quality audit #3350 S32/S60: Parrot's desktop and web player each kept their own avatar menu and Settings ›
 *   Profiles section, and four apps each wrote their own "no library moves" and localStorage wrappers for the
 *   shared profile store. They now come from one place (`@space/ui/profiles`, `NO_LIBRARY_MOVES` and
 *   `localStorageProfileStorage` in `@space/shared/profileStore`). This reads the client apps' sources and fails if
 *   one grows its own copy again; profiles-shared.web-apps.test.ts checks the website and web players.
 * @tags @bugfix @regression-proof
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownCopies, ROOT } from "./profiles-owned";

const SOURCES = ["apps/badger/desktop/src", "apps/badger/mobile/src", "apps/parrot/desktop/src", "apps/parrot/mobile/src", "apps/parrot/mobile/App.tsx", "packages/ui/src"];

describe("apps share the profile store's pieces and Parrot's profile UI", () => {
  it("no client app keeps its own copy", () => {
    const found = ownCopies(SOURCES);
    console.info(`[UI-PROFILES-SHARED-001] own copies=${JSON.stringify(found)}`);
    expect(found).toEqual([]);
  });

  it("Parrot's desktop draws the shared Profiles section", () => {
    const file = "apps/parrot/desktop/src/renderer/src/AccountSettings.tsx";
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text, file).toContain("@space/ui/profiles");
    expect(text, file).toContain("<ParrotProfilesSection");
  });
});
