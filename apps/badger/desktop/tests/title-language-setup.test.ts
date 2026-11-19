/**
 * @req ACCT-PROF-03[badger-desktop]
 * @req UX-SETUP-01[badger-desktop]
 * @req UX-SETUP-10[badger-desktop]
 * @test-id DESKTOP-TITLE-SETUP-001..009
 * @level unit
 *
 * Why: in this computer's first setup "Your profile" is "Step 2 of N" right after the library key when the profile
 * owes it, "How should titles appear?" follows it, and this computer's own questions count on after both. A profile
 * created before a question existed is never asked, and a question shown outside a setup run has no step count.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  noteProfileStepSaving,
  noteSetupRun,
  profileSetupStep,
  resetSetupRunForTests,
  settleProfileStep,
  settleTitleQuestion,
  setupRunState,
  titleQuestionExpected,
  titleQuestionStep,
} from "@/lib/titleLanguageSetup";

const LOG = "[title-language-setup]";

beforeEach(() => resetSetupRunForTests());

describe("where the profile questions sit in the first setup (ACCT-PROF-03, UX-SETUP-01, UX-SETUP-10)", () => {
  it("DESKTOP-TITLE-SETUP-001: only a profile created since the question exists is counted", () => {
    const before = titleQuestionExpected({ createdAt: "2026-11-16T10:00:00.000Z" });
    const after = titleQuestionExpected({ createdAt: "2026-11-17T00:00:00.000Z" });
    console.info(`${LOG}:001 before=${before} after=${after}`);
    expect(before).toBe(false);
    expect(after).toBe(true);
    expect(titleQuestionExpected(null)).toBe(false);
  });

  it("DESKTOP-TITLE-SETUP-002: counted by the key screen alone, the title question is step 2 and the computer's questions follow it", () => {
    expect(titleQuestionStep(), "outside a setup run: no step count").toBeNull();
    noteSetupRun({ total: 4, profileStep: false, titleStep: true });
    console.info(`${LOG}:002 step=${JSON.stringify(titleQuestionStep())}`);
    expect(profileSetupStep(), "not counted: no profile step").toBeNull();
    expect(titleQuestionStep()).toEqual({ current: 2, total: 4 });
    settleTitleQuestion(true);
    expect(titleQuestionStep(), "answered: the run moves on").toBeNull();
  });

  it("DESKTOP-TITLE-SETUP-003: a profile that turns out not to need the question frees the run without counting it", () => {
    noteSetupRun({ total: 3, profileStep: false, titleStep: true });
    settleTitleQuestion(false);
    settleTitleQuestion(true); // a late answer does not change a settled run
    console.info(`${LOG}:003 step=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toBeNull();
  });

  it("DESKTOP-TITLE-SETUP-004: \"Your profile\" is step 2, the title question step 3, and the computer's questions start at 4", () => {
    noteSetupRun({ total: 6, profileStep: true, titleStep: true });
    console.info(`${LOG}:004 profile=${JSON.stringify(profileSetupStep())} title=${JSON.stringify(titleQuestionStep())}`);
    expect(profileSetupStep()).toEqual({ current: 2, total: 6 });
    expect(setupRunState().waiting, "FirstSetup waits for both").toBe(true);
    settleProfileStep(true);
    expect(profileSetupStep(), "answered: shown no more").toBeNull();
    expect(titleQuestionStep()).toEqual({ current: 3, total: 6 });
    settleTitleQuestion(true);
    const state = setupRunState();
    console.info(`${LOG}:004 state=${JSON.stringify(state)}`);
    expect(state).toEqual({ waiting: false, stepsBefore: 3, profileStep: null, titleStep: null });
  });

  it("DESKTOP-TITLE-SETUP-005: a profile step that turns out not to be owed leaves the title question at step 2", () => {
    noteSetupRun({ total: 5, profileStep: true, titleStep: true });
    settleProfileStep(false);
    console.info(`${LOG}:005 title=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toEqual({ current: 2, total: 5 });
    settleTitleQuestion(true);
    expect(setupRunState()).toEqual({ waiting: false, stepsBefore: 2, profileStep: null, titleStep: null });
  });

  it("DESKTOP-TITLE-SETUP-006: \"Your profile\" alone (no title question) is step 2 and FirstSetup follows at 3", () => {
    noteSetupRun({ total: 4, profileStep: true, titleStep: false });
    expect(profileSetupStep()).toEqual({ current: 2, total: 4 });
    expect(titleQuestionStep()).toBeNull();
    settleProfileStep(true);
    const state = setupRunState();
    console.info(`${LOG}:006 state=${JSON.stringify(state)}`);
    expect(state).toEqual({ waiting: false, stepsBefore: 2, profileStep: null, titleStep: null });
  });

  it("DESKTOP-TITLE-SETUP-007: while the answer saves, the saved profile does not read as not owed; the title question stays step 3", () => {
    noteSetupRun({ total: 3, profileStep: true, titleStep: true });
    noteProfileStepSaving(true);
    // The store applies the saved profile before the save returns: the gate then sees one that no longer owes the step.
    settleProfileStep(false);
    expect(profileSetupStep(), "still counted while it saves").toEqual({ current: 2, total: 3 });
    settleProfileStep(true);
    console.info(`${LOG}:007 title=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toEqual({ current: 3, total: 3 });
  });

  it("DESKTOP-TITLE-SETUP-008: a failed save leaves the step to come, and a later not-owed reading settles it", () => {
    noteSetupRun({ total: 3, profileStep: true, titleStep: true });
    noteProfileStepSaving(true);
    noteProfileStepSaving(false);
    expect(profileSetupStep()).toEqual({ current: 2, total: 3 });
    settleProfileStep(false);
    console.info(`${LOG}:008 title=${JSON.stringify(titleQuestionStep())}`);
    expect(titleQuestionStep()).toEqual({ current: 2, total: 3 });
  });

  it("DESKTOP-TITLE-SETUP-009: the state the screens read carries each question's step and changes when the run moves on", () => {
    noteSetupRun({ total: 3, profileStep: true, titleStep: true });
    const asked = setupRunState();
    expect(asked).toMatchObject({ profileStep: { current: 2, total: 3 }, titleStep: { current: 2, total: 3 } });
    expect(setupRunState(), "unchanged run: the same object").toBe(asked);
    noteProfileStepSaving(true);
    settleProfileStep(true);
    const after = setupRunState();
    console.info(`${LOG}:009 after=${JSON.stringify(after)}`);
    expect(after, "a new object, so the title question shows its new step").not.toBe(asked);
    expect(after).toMatchObject({ profileStep: null, titleStep: { current: 3, total: 3 } });
  });
});
