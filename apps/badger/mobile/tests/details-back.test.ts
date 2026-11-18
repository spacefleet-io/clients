import { describe, expect, it } from "vitest";
import { detailsBackTarget } from "../src/lib/detailsBack";

// @bugfix @regression-proof
// Android Back on the movie page closed the whole page (and a second press left
// the app) while a trailer or a picker was open. Back must close the topmost
// layer only.
describe("detailsBackTarget", () => {
  const none = { trailerOpen: false, trailerPickerOpen: false, playlistPickerOpen: false, seasonPickerOpen: false };

  it("closes the playing trailer first", () => {
    expect(detailsBackTarget({ ...none, trailerOpen: true, trailerPickerOpen: true })).toBe("trailer");
  });

  it("closes an open picker before the page", () => {
    expect(detailsBackTarget({ ...none, trailerPickerOpen: true })).toBe("trailerPicker");
    expect(detailsBackTarget({ ...none, playlistPickerOpen: true })).toBe("playlistPicker");
    expect(detailsBackTarget({ ...none, seasonPickerOpen: true })).toBe("seasonPicker");
  });

  it("closes the page when nothing is layered on top", () => {
    expect(detailsBackTarget(none)).toBe("sheet");
  });
});
