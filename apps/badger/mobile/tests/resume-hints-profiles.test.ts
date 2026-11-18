/**
 * @test-id MOBILE-RESUME-HINTS-PROFILES-001
 * @level unit
 * @bugfix ACCT-PROF-02 / ACCT-SQUAD-02 (badger-mobile): the device-local "last played episode" hints
 * (`sf:resume:episode:[p:<pid>:]<mediaId>`, AsyncStorage) follow profile deletions on every device. After each fresh
 * profile list, a deleted profile's hints are removed, and when the main profile changed the bare hints (the deleted
 * main's) are replaced with the new main's prefixed ones. Running it again changes nothing.
 *
 * @req ACCT-PROF-02[badger-mobile]
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, getAllKeys: async () => [] },
}));

import { RESUME_HINTS_MAIN_KEY, reconcileResumeHints } from "../src/lib/resume";

const TAG = "[resume-hints-profiles]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakeStorage = (initial: Record<string, string>) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      getAllKeys: async () => [...map.keys()],
      getItem: async (key: string) => map.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: async (key: string) => {
        map.delete(key);
      },
    },
  };
};

const snapshot = (map: Map<string, string>) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

describe("resume hints follow profile deletions (ACCT-PROF-02)", () => {
  /** @req ACCT-PROF-02[badger-mobile] */
  it("@req ACCT-PROF-02 @bugfix the first list only records the main profile; nothing moves", async () => {
    const { map, storage } = fakeStorage({ "sf:resume:episode:show1": "e1", "sf:resume:episode:p:kids:show1": "e5" });
    await reconcileResumeHints("ada", ["ada", "kids"], storage);
    log("first", snapshot(map));
    expect(snapshot(map)).toEqual({
      "sf:resume:episode:p:kids:show1": "e5",
      "sf:resume:episode:show1": "e1",
      [RESUME_HINTS_MAIN_KEY]: "ada",
    });
  });

  /** @req ACCT-PROF-02[badger-mobile] */
  it("@req ACCT-PROF-02 @bugfix a deleted non-main profile's hints are removed, nobody else's", async () => {
    const { map, storage } = fakeStorage({
      [RESUME_HINTS_MAIN_KEY]: "ada",
      "sf:resume:episode:show1": "e1",
      "sf:resume:episode:p:kids:show1": "e5",
      "sf:resume:episode:p:kids:show2": "e7",
      "sf:resume:episode:p:guest:show1": "e2",
      "sf_profiles:user-1": "[]",
    });
    await reconcileResumeHints("ada", ["ada", "guest"], storage);
    log("wiped", snapshot(map));
    expect(snapshot(map)).toEqual({
      "sf:resume:episode:p:guest:show1": "e2",
      "sf:resume:episode:show1": "e1",
      [RESUME_HINTS_MAIN_KEY]: "ada",
      "sf_profiles:user-1": "[]",
    });
  });

  /** @req ACCT-PROF-02[badger-mobile] */
  it("@req ACCT-PROF-02 @bugfix when the main profile is deleted, the new main's hints replace the bare ones, once", async () => {
    const { map, storage } = fakeStorage({
      [RESUME_HINTS_MAIN_KEY]: "ada",
      "sf:resume:episode:show1": "ada-e1",
      "sf:resume:episode:show9": "ada-e9",
      "sf:resume:episode:p:kids:show1": "kids-e5",
      "sf:resume:episode:p:kids:show2": "kids-e7",
      "sf:resume:episode:p:guest:show1": "guest-e2",
    });
    await reconcileResumeHints("kids", ["kids", "guest"], storage);
    const after = snapshot(map);
    log("promoted", after);
    expect(after).toEqual({
      "sf:resume:episode:p:guest:show1": "guest-e2",
      "sf:resume:episode:show1": "kids-e5",
      "sf:resume:episode:show2": "kids-e7",
      [RESUME_HINTS_MAIN_KEY]: "kids",
    });
    await reconcileResumeHints("kids", ["kids", "guest"], storage);
    expect(snapshot(map)).toEqual(after);
  });
});
