// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportReviewPicker } from "../src/import-review";

afterEach(cleanup);

const props = {
  icon: <span />,
  title: "Add media",
  subtitle: "Pick files or a folder",
  browseFilesLabel: "Browse files",
  browseFoldersLabel: "Browse folders",
};

// @req UX-ADD-01[badger-desktop,parrot]
describe("the + opens one shared file-or-folder picker in Badger and Parrot", () => {
  it("offers files and a folder and reports which one was picked", () => {
    const onBrowse = vi.fn();
    const view = render(<ImportReviewPicker {...props} onBrowse={onBrowse} />);
    fireEvent.click(view.getByTestId("import-pick-files"));
    fireEvent.click(view.getByTestId("import-pick-folders"));
    expect(onBrowse.mock.calls).toEqual([["file"], ["folder"]]);
  });

  it("shows the scan error and swaps the buttons for the busy line while reading", () => {
    const view = render(<ImportReviewPicker {...props} onBrowse={() => {}} error="Could not read" busy="Reading…" />);
    expect(view.getByText("Could not read")).toBeTruthy();
    expect(view.getByTestId("import-picker-busy").textContent).toBe("Reading…");
    expect(view.queryByTestId("import-pick-files")).toBeNull();
  });
});
