/**
 * @req ACCT-PROF-03[badger-desktop]
 * @req UX-SETUP-01[badger-desktop]
 * @test-id DESKTOP-TITLE-SETUP-001..003
 * @level unit
 *
 * Why: in this computer's first setup "How should titles appear?" is a numbered step right after the library key
 * ("Step 2 of N"), and this computer's own questions count on after it. A profile created before the question
 * existed is never asked, and the question shown outside a setup run has no step count.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  noteSetupRunCountsTitle,
  resetSetupRunForTests,
  settleTitleQuestion,
  titleQuestionExpected,
  titleQuestionStep,
} from "@/lib/titleLanguageSetup";

const LOG = "[title-language-setup]";

beforeEach(() => resetSetupRunForTests());

describe("where the title question sits in the first setup (ACCT-PROF-03, UX-SETUP-01)", () => {
  it("DESKTOP-TITLE-SETUP-001: only a profile created since the question exists is counted", () => {
    const before = titleQuestionExpected({ createdAt: "2026-11-16T10:00:00.000Z" });
    const after = titleQuestionExpected({ createdAt: "2026-11-17T00:00:00.000Z" });
    console.info(`${LOG}:001 before=${before} after=${after}`);
    expect(before).toBe(false);
    expect(after).toBe(true);
    expect(titleQuestionExpected(null)).toBe(false);
  });

  it("DESKTOP-TITLE-SETUP-002: counted by the key screen, the question is step 2 and the computer's questions follow it", () => {
    expect(titleQuestionStep(), "outside a setup run: no step count").toBeNull();
    noteSetupRunCountsTitle(4);
    console.info(`${LOG}:002 step=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toEqual({ current: 2, total: 4 });
    settleTitleQuestion(true);
    expect(titleQuestionStep(), "answered: the run moves on").toBeNull();
  });

  it("DESKTOP-TITLE-SETUP-003: a profile that turns out not to need the question frees the run without counting it", () => {
    noteSetupRunCountsTitle(3);
    settleTitleQuestion(false);
    settleTitleQuestion(true); // a late answer does not change a settled run
    console.info(`${LOG}:003 step=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toBeNull();
  });
});
