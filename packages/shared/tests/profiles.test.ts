/**
 * @req ACCT-PROF-01
 * @req ACCT-PROF-02
 * @req ACCT-SQUAD-02
 *
 * Pure logic shared by the API and every client for profiles held by the API
 * (`/profiles`): creation and deletion limits, name validation, main = oldest
 * profile, and the viewing-key prefix of the cross-client contract. Plan limits and avatar rules
 * are server-only and tested on the server side.
 */
import { describe, expect, it } from "vitest";
import {
  PROFILE_CONFIG_KEYS,
  PROFILE_ERRORS,
  PROFILE_NAME_MAX,
  canCreateProfile,
  canDeleteProfile,
  normalizeProfileName,
  orderProfiles,
  profileKeyPrefix,
  profileScopedKey,
} from "../src/profiles";

const T1 = "2026-10-16T20:00:00.000Z";
const T2 = "2026-10-17T08:00:00.000Z";
const T3 = "2026-10-18T08:00:00.000Z";

const log = (phase: string, data?: unknown) => console.info(`[shared-profiles] ${phase}`, data === undefined ? "" : JSON.stringify(data));

describe("profile limits (ACCT-PROF-01)", () => {
  it("@req ACCT-PROF-01 a new profile is refused once the count reaches the limit", () => {
    expect(canCreateProfile(1, 5)).toBe(true);
    expect(canCreateProfile(4, 5)).toBe(true);
    expect(canCreateProfile(5, 5)).toBe(false);
    expect(canCreateProfile(1, 1)).toBe(false);
    // After a downgrade without the choose-the-survivor step, nothing new is allowed.
    expect(canCreateProfile(3, 1)).toBe(false);
  });

  it("@req ACCT-PROF-01 the error codes are stable strings every client matches on", () => {
    log("errors", PROFILE_ERRORS);
    expect(PROFILE_ERRORS).toEqual({
      limit: "profile_limit",
      last: "last_profile",
      invalid: "invalid_profile",
      notFound: "profile_not_found",
    });
  });
});

describe("deleting (ACCT-PROF-02)", () => {
  it("@req ACCT-PROF-02 any profile can go while another remains, never the last one", () => {
    expect(canDeleteProfile(2)).toBe(true);
    expect(canDeleteProfile(5)).toBe(true);
    expect(canDeleteProfile(1)).toBe(false);
    expect(canDeleteProfile(0)).toBe(false);
  });

  it("@req ACCT-PROF-02 the oldest profile is main, and the oldest remaining one becomes main after it is deleted", () => {
    const profiles = [
      { id: "b", createdAt: T2, name: "Kids" },
      { id: "a", createdAt: T1, name: "Chris" },
      { id: "c", createdAt: T3, name: "Guest" },
    ];
    const ordered = orderProfiles(profiles);
    log("ordered", ordered);
    expect(ordered.map((p) => [p.id, p.isMain])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    const afterDelete = orderProfiles(ordered.filter((p) => p.id !== "a"));
    log("afterDelete", afterDelete);
    expect(afterDelete.map((p) => [p.id, p.isMain])).toEqual([
      ["b", true],
      ["c", false],
    ]);
  });

  it("@req ACCT-PROF-02 equal creation dates order by id so every client picks the same main", () => {
    const ordered = orderProfiles([
      { id: "z", createdAt: T1 },
      { id: "m", createdAt: T1 },
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["m", "z"]);
    expect(ordered[0]?.isMain).toBe(true);
  });
});

describe("viewing keys (ACCT-SQUAD-02)", () => {
  it("@req ACCT-SQUAD-02 the main profile keeps unprefixed keys, other profiles use p:<id>:", () => {
    expect(profileKeyPrefix({ id: "a", isMain: true })).toBe("");
    expect(profileKeyPrefix({ id: "7d2f", isMain: false })).toBe("p:7d2f:");
    expect(profileScopedKey("7d2f", "episode_resume_v1:e1")).toBe("p:7d2f:episode_resume_v1:e1");
    expect(profileScopedKey("7d2f", "client_config_v1")).toBe("p:7d2f:client_config_v1");
    expect(() => profileScopedKey("", "x")).toThrow();
  });

  it("@req ACCT-SQUAD-02 only the viewer fields of client_config belong to a profile", () => {
    expect([...PROFILE_CONFIG_KEYS]).toEqual([
      "uiTheme",
      "trailerLanguages",
      "autoplayNextEpisode",
      "introSkipEnabled",
      "creditsSkipEnabled",
      "skipMode",
    ]);
  });
});

describe("names", () => {
  it("@req ACCT-PROF-01 a name is 1 to 40 code points after trimming", () => {
    expect(PROFILE_NAME_MAX).toBe(40);
    expect(normalizeProfileName("  Kids ")).toBe("Kids");
    expect(normalizeProfileName("")).toBeNull();
    expect(normalizeProfileName("   ")).toBeNull();
    expect(normalizeProfileName("x".repeat(40))).toBe("x".repeat(40));
    expect(normalizeProfileName("x".repeat(41))).toBeNull();
    // Code points, not UTF-16 units: 40 emoji fit, 41 do not.
    expect(normalizeProfileName("😀".repeat(40))).toBe("😀".repeat(40));
    expect(normalizeProfileName("😀".repeat(41))).toBeNull();
  });
});
