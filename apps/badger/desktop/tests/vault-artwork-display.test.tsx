// @vitest-environment jsdom
/**
 * @test-id META-ART-DISPLAY-DESKTOP-001
 * @level component (real MediaImage + useMediaImage; storage, keys and the metadata client are fakes)
 * @req META-ART-01
 * @req META-ART-02
 *
 * Why this exists: browsing asked the metadata service for every provider path it showed (1,454 image lookups in
 * three days, 986 of them repeats), when the artwork is copied into the user's storage at import. Browsing now
 * shows only the user's copy, read once from storage into the local decrypted cache and from the cache after that;
 * a title without a copy shows the placeholder and never asks the metadata service.
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "[vault-artwork-display]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakes = vi.hoisted(() => ({
  resolveArtwork: vi.fn(async () => ({ status: "ok", url: "data:image/jpeg;base64,SERVICE" })),
  getDecryptedAssetUrl: vi.fn(async () => "blob:vault-copy"),
  cache: new Map<string, string>(),
}));

vi.mock("@/auth", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("@/lib/onboarding", () => ({ getStoredLibraryKey: async () => "library-key" }));
vi.mock("@/lib/assets", () => ({
  getDecryptedAssetUrl: fakes.getDecryptedAssetUrl,
  isAssetKey: (value: string | null) => !!value && (value.startsWith("asset:") || value.startsWith("assets/")),
}));
vi.mock("@/lib/artworkHeal", () => ({ getDesktopArtworkHealer: () => null }));
vi.mock("@/lib/metadataTickets", () => ({
  resolveArtwork: fakes.resolveArtwork,
  resolveMetadataImage: fakes.resolveArtwork,
  onMetadataTicketsAvailable: () => () => undefined,
}));
vi.mock("@/lib/artworkCache", () => ({
  getRendererArtworkStore: () => ({
    get: async (key: string) => fakes.cache.get(key) ?? null,
    put: async (key: string, value: string) => {
      fakes.cache.set(key, value);
    },
    clear: async () => fakes.cache.clear(),
  }),
  currentArtworkSession: () => 1,
  mayWriteArtwork: () => true,
}));
vi.mock("@/lib/playbackBackdrop", () => ({ objectUrlToDataUrl: async () => "data:image/jpeg;base64,COPY" }));

import MediaImage from "../src/renderer/src/components/MediaImage";

const REF = "asset:image/jpeg::assets/poster-1.txt";
let container: HTMLDivElement;
let root: Root;

const show = async (path: string | null) => {
  await act(async () => {
    root.render(<MediaImage path={path} alt="art" />);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return container.querySelector("img")?.getAttribute("src") ?? null;
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  fakes.resolveArtwork.mockClear();
  fakes.getDecryptedAssetUrl.mockClear();
  fakes.cache.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("desktop browsing shows the user's own artwork copy (META-ART-01/02)", () => {
  it("@req META-ART-01[badger-desktop] @req META-ART-02 a title without a copy shows the loading frame (no picture) and never asks the metadata service", async () => {
    log("phase: provider path");
    const src = await show("/poster.jpg");
    const look = container.querySelector("[data-artwork]")?.getAttribute("data-artwork");
    log("phase: shown", { src, look, service: fakes.resolveArtwork.mock.calls.length });
    expect(src).toBeNull();
    expect(look).toBe("loading");
    expect(fakes.resolveArtwork).not.toHaveBeenCalled();
    expect(fakes.getDecryptedAssetUrl).not.toHaveBeenCalled();
  });

  it("@req META-ART-01[badger-desktop] a copy is read from storage once, then from the local decrypted cache", async () => {
    log("phase: cache miss");
    expect(await show(REF)).toBe("blob:vault-copy");
    expect(fakes.getDecryptedAssetUrl).toHaveBeenCalledTimes(1);
    log("phase: cached", Object.fromEntries(fakes.cache));
    expect(fakes.cache.get(`vault|${REF}`)).toBe("data:image/jpeg;base64,COPY");

    log("phase: remount (an app restart keeps the cache)");
    act(() => root.unmount());
    root = createRoot(container);
    expect(await show(REF)).toBe("data:image/jpeg;base64,COPY");
    expect(fakes.getDecryptedAssetUrl).toHaveBeenCalledTimes(1);
    expect(fakes.resolveArtwork).not.toHaveBeenCalled();
  });

  it("@req META-ART-02 no display or playback file reaches the metadata service for a picture", () => {
    const files = [
      "src/renderer/src/lib/useMediaImage.ts",
      "src/renderer/src/components/MediaImage.tsx",
      "src/renderer/src/components/DashboardContinueHero.tsx",
      "src/renderer/src/components/MediaPlaybackController.tsx",
      "src/renderer/src/lib/playbackBackdrop.ts",
      "src/renderer/src/lib/useMpvPlaybackEngine.ts",
    ];
    const offenders = files.filter((file) =>
      /\b(resolveArtwork|resolveMetadataImage|imageUrl)\b/.test(readFileSync(resolve(process.cwd(), file), "utf8"))
    );
    log("phase: scan", { files: files.length, offenders });
    expect(offenders).toEqual([]);
  });
});
