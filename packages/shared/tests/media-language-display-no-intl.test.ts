import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMediaLanguageLabelForUi,
  formatTrackDisplayLabel,
  sortedMediaLanguageOptionsForUi,
} from "../src/mediaLanguageDisplay";

const TAG = "[media-language-display-no-intl]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media language names without Intl.DisplayNames (Hermes, the phone's engine, has none)", () => {
  it("@bugfix @regression-proof names languages from the language list instead of throwing", () => {
    // Intl's members are not enumerable: inherit them (Hermes has Collator) and hide only DisplayNames. A UI language
    // no earlier test cached, so the module cannot reuse a DisplayNames built before the stub.
    vi.stubGlobal("Intl", Object.assign(Object.create(globalThis.Intl), { DisplayNames: undefined }));
    const fr = formatMediaLanguageLabelForUi("fr", "nl");
    const nlSelf = formatMediaLanguageLabelForUi("nl", "nl");
    const track = formatTrackDisplayLabel("fre", "SDH", "nl");
    const options = sortedMediaLanguageOptionsForUi("nl");
    log("labels", { fr, nlSelf, track, firstOptions: options.slice(0, 3) });
    expect(fr, "another language reads in English").toBe("French");
    expect(nlSelf, "the UI language reads in its own name").toBe("Nederlands");
    expect(track).toBe("French - SDH");
    expect(options.find((option) => option.code === "de")?.label).toBe("German 🇩🇪");
  });

  it("keeps Intl.DisplayNames names where the engine has it", () => {
    const label = formatMediaLanguageLabelForUi("fr", "de");
    log("intl label", { label });
    expect(label).toBe("Französisch");
  });
});
