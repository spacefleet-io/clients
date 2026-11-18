// @vitest-environment jsdom
/**
 * @req PLAY-SUBGET-05[badger-desktop,badger-web-player]
 * @req PLAY-SUBGET-12[badger-desktop,badger-web-player]
 * @req PLAY-SUBGET-18[badger-desktop,badger-web-player]
 * @req PLAY-SUBGET-24[badger-desktop,badger-web-player]
 * @req PLAY-SUBGET-25[badger-desktop,badger-web-player]
 *
 * The shared "Get subtitles" flow: looks first, lists only the languages that exist (names only, nothing
 * preselected), says what is happening while storing, then says it was added; the unavailable, empty and offline
 * cases show a message with Back.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleFetchCandidate } from "@space/shared/subtitleFetch";
import { SubtitleFetchFlow, type SubtitleFetchFlowProps } from "../src/badger/subtitle-fetch";

afterEach(cleanup);

let nextId = 1;
const candidate = (language: string, overrides: Partial<SubtitleFetchCandidate> = {}): SubtitleFetchCandidate => ({
  fileId: nextId++,
  language,
  hearingImpaired: false,
  foreignPartsOnly: false,
  release: "Sandglass (2021) 1080p WEB-DL",
  fileName: "sandglass.srt",
  downloadCount: 10,
  ready: true,
  ...overrides,
});

const renderFlow = (props: Partial<SubtitleFetchFlowProps>) =>
  render(
    <SubtitleFetchFlow
      uiLanguage="en"
      existingTracks={[]}
      search={async () => ({ reachable: true, subtitles: [] })}
      store={async () => {}}
      onClose={() => {}}
      {...props}
    />
  );

describe("SubtitleFetchFlow", () => {
  it("looks first, then lists the languages that exist with nothing preselected (PLAY-SUBGET-05)", async () => {
    const { promise, resolve } = Promise.withResolvers<{ reachable: boolean; subtitles: SubtitleFetchCandidate[] }>();
    renderFlow({ search: () => promise });
    expect(screen.getByTestId("subtitle-fetch-looking").textContent).toContain("Looking for subtitles");
    await act(async () => resolve({ reachable: true, subtitles: [candidate("es"), candidate("es"), candidate("fr")] }));
    const entries = screen.getAllByTestId("subtitle-fetch-entry");
    expect(entries.map((entry) => entry.textContent)).toEqual(["French", "Spanish"]);
    expect(document.activeElement?.getAttribute("data-testid")).not.toBe("subtitle-fetch-entry");
  });

  it("says so straight away when no language has a subtitle", async () => {
    renderFlow({});
    await waitFor(() => expect(screen.getByTestId("subtitle-fetch-none")).toBeTruthy());
  });

  it("shows the credit the service sends under the pick list, its name linked, and none when it sends none (PLAY-SUBGET-25)", async () => {
    const credit = { text: "Subtitles provided by", name: "Example Subtitles", url: "https://subtitles.example" };
    renderFlow({ search: async () => ({ reachable: true, subtitles: [candidate("fr")], credit }) });
    const line = await screen.findByTestId("subtitle-fetch-credit");
    expect(line.textContent).toBe("Subtitles provided by Example Subtitles");
    const link = line.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://subtitles.example");
    expect(link?.textContent).toBe("Example Subtitles");
    cleanup();
    renderFlow({ search: async () => ({ reachable: true, subtitles: [candidate("fr")] }) });
    await screen.findAllByTestId("subtitle-fetch-entry");
    expect(screen.queryByTestId("subtitle-fetch-credit")).toBeNull();
  });

  it("reaches the added message under StrictMode's development remount", async () => {
    render(
      <React.StrictMode>
        <SubtitleFetchFlow
          uiLanguage="en"
          existingTracks={[]}
          search={async () => ({ reachable: true, subtitles: [candidate("fr")] })}
          store={async (_entry, report) => report("saving")}
          onClose={() => {}}
        />
      </React.StrictMode>
    );
    fireEvent.click(await screen.findByTestId("subtitle-fetch-entry"));
    await waitFor(() => expect(screen.getByTestId("subtitle-fetch-added")).toBeTruthy());
  });

  it("shows the working-on-it message with Back when nothing can be offered (PLAY-SUBGET-12)", async () => {
    const onClose = vi.fn();
    renderFlow({ search: async () => ({ reachable: false, subtitles: [] }), onClose });
    await waitFor(() => expect(screen.getByTestId("subtitle-fetch-unavailable").textContent).toContain("working on it"));
    fireEvent.click(screen.getByTestId("subtitle-fetch-back"));
    expect(onClose).toHaveBeenCalled();
  });

  it("treats a failed search like an unavailable service", async () => {
    renderFlow({ search: async () => Promise.reject(new Error("503")) });
    await waitFor(() => expect(screen.getByTestId("subtitle-fetch-unavailable")).toBeTruthy());
  });

  it("does not search offline and says it needs a connection (PLAY-SUBGET-12)", () => {
    const search = vi.fn(async () => ({ reachable: true, subtitles: [] }));
    renderFlow({ offline: true, search });
    expect(screen.getByTestId("subtitle-fetch-offline").textContent).toBe("Needs an internet connection");
    expect(search).not.toHaveBeenCalled();
  });

  it("walks getting, downloading, saving, then added (PLAY-SUBGET-02)", async () => {
    let report!: (stage: "downloading" | "saving") => void;
    const stored = Promise.withResolvers<void>();
    const onAdded = vi.fn();
    const onClose = vi.fn();
    renderFlow({
      search: async () => ({ reachable: true, subtitles: [candidate("es")] }),
      store: (_entry, reportStage) => {
        report = reportStage;
        return stored.promise;
      },
      onAdded,
      onClose,
    });
    const [entry] = await screen.findAllByTestId("subtitle-fetch-entry");
    await act(async () => fireEvent.click(entry!));
    expect(screen.getByTestId("subtitle-fetch-progress").textContent).toBe("Getting Spanish subtitles");
    act(() => report("downloading"));
    expect(screen.getByTestId("subtitle-fetch-progress").textContent).toBe("Downloading");
    act(() => report("saving"));
    expect(screen.getByTestId("subtitle-fetch-progress").textContent).toBe("Saving to your media library");
    await act(async () => stored.resolve());
    expect(screen.getByTestId("subtitle-fetch-added").textContent).toBe("Spanish added");
    fireEvent.click(screen.getByTestId("subtitle-fetch-done"));
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ trackName: "Spanish" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("marks languages already present and never downloads them again (PLAY-SUBGET-18, PLAY-SUBGET-24)", async () => {
    const store = vi.fn(async () => {});
    renderFlow({
      search: async () => ({ reachable: true, subtitles: [candidate("es"), candidate("fr"), candidate("de")] }),
      existingTracks: [
        { language: "es", label: "Spanish", source: "upload" },
        { language: "fr", label: "French", source: "fetched" },
      ],
      store,
    });
    const entries = await screen.findAllByTestId("subtitle-fetch-entry");
    expect(screen.getAllByTestId("subtitle-fetch-already")).toHaveLength(2);
    const french = entries.find((entry) => entry.dataset.language === "fr")!;
    expect((french as HTMLButtonElement).disabled).toBe(true);
    const spanish = entries.find((entry) => entry.dataset.language === "es")!;
    expect((spanish as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(spanish));
    expect(store).not.toHaveBeenCalled();
    const german = entries.find((entry) => entry.dataset.language === "de")!;
    await act(async () => fireEvent.click(german));
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ trackName: "German" }), expect.any(Function), expect.any(AbortSignal));
  });

  it("shows the failure and the list again when storing fails", async () => {
    renderFlow({
      search: async () => ({ reachable: true, subtitles: [candidate("es")] }),
      store: async () => Promise.reject(new Error("upload")),
    });
    const [entry] = await screen.findAllByTestId("subtitle-fetch-entry");
    await act(async () => fireEvent.click(entry!));
    expect(screen.getByTestId("subtitle-fetch-failed").textContent).toContain("Couldn't add Spanish");
    expect(screen.getAllByTestId("subtitle-fetch-entry")).toHaveLength(1);
  });
});
