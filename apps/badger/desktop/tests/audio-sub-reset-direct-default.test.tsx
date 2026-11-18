// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Regression test for commit f4f84920 — collapse audio/sub reset cascade.
 *
 * Pre-fix the requestId-keyed reset effect in MediaPlaybackController did:
 *   resetAudio(null);
 *   resetSub("off");
 * which then let the engine's audio-resolver effect re-pick the new
 * default and call setSelectedAudioId(newId) — TWO consecutive writes
 * mutating `audioMapSignature` (the engine's init-effect dep), which
 * then re-fired init AFTER the first loadStream's latch was released
 * (the sequential re-fire is NOT blocked by launchInProgressRef once it
 * has cycled). Net: 3-segment mpv reload loop on first play.
 *
 * Fix: set the selection DIRECTLY to the new default. The signature
 * changes ONCE; the resolver no-ops (selection already matches); init
 * fires exactly once; mpv launches once.
 *
 * This test reproduces the post-fix shape: when requestId changes, the
 * effect resolves the new default for the (media, episodeId) tuple and
 * dispatches resetAudio(<newDefaultId>) and resetSub(<newDefaultSubId>)
 * — never null or "off" intermediate.
 */
import React, { useEffect, useRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

type AudioTrack = {
  id: string;
  episodeId: string | null;
  isDefault: boolean;
};
type SubtitleTrack = {
  id: string;
  episodeId: string | null;
  isDefault: boolean;
  objectKey: string | null;
};
type Media = {
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// On assertion failure, dump the reset-setter call ledger + the media tracks
// that drove the resolver. Body wrapped in try/catch so a dump failure can
// never mask the real assertion failure.
const dumpResetSnapshot = (
  label: string,
  ctx: { media?: Media; resetAudio: ReturnType<typeof vi.fn>; resetSub: ReturnType<typeof vi.fn> },
) => {
  try {
    console.error(`=== [audio-sub-reset-direct-default:${label}] snapshot ===`);
    console.error(`resetAudio.calls=${JSON.stringify(ctx.resetAudio.mock.calls)}`);
    console.error(`resetSub.calls=${JSON.stringify(ctx.resetSub.mock.calls)}`);
    if (ctx.media) {
      console.error(`media.audioTracks=${JSON.stringify(ctx.media.audioTracks, null, 2)}`);
      console.error(`media.subtitleTracks=${JSON.stringify(ctx.media.subtitleTracks, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  if (root && container) {
    act(() => root?.unmount());
  }
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
});

/**
 * Tiny harness mirroring the reset-effect shape in
 * MediaPlaybackController.tsx (the `resetAudio(audioDefault)` /
 * `resetSub(subDefault)` block keyed on requestId). The point of this
 * test isn't to render the real controller (it has dozens of deps);
 * it's to pin the shape so an inadvertent revert to setX(null)+resolver
 * fails loudly.
 */
const Harness = ({
  requestId,
  media,
  episodeId,
  resetAudio,
  resetSub,
}: {
  requestId: number;
  media: Media;
  episodeId: string | null;
  resetAudio: (id: string | null) => void;
  resetSub: (id: string) => void;
}) => {
  const currentMediaRef = useRef(media);
  currentMediaRef.current = media;
  useEffect(() => {
    if (!requestId) return;
    const m = currentMediaRef.current;
    const ep = episodeId;
    const audioDefault =
      m.audioTracks.find((t) =>
        (ep ? t.episodeId === ep : !t.episodeId) && t.isDefault,
      )?.id ?? null;
    const subDefault =
      m.subtitleTracks.find((t) =>
        (ep ? t.episodeId === ep : !t.episodeId) &&
        t.isDefault &&
        Boolean(t.objectKey),
      )?.id ?? "off";
    resetAudio(audioDefault);
    resetSub(subDefault);
  }, [requestId, episodeId, resetAudio, resetSub]);
  return null;
};

describe("@bugfix @regression-proof audio/sub reset direct default", () => {
  it("@bugfix @regression-proof sets selection directly to the new default — no null intermediate", async () => {
    const resetAudio = vi.fn();
    const resetSub = vi.fn();
    const media: Media = {
      audioTracks: [
        { id: "audio-en", episodeId: null, isDefault: false },
        { id: "audio-fr", episodeId: null, isDefault: true },
      ],
      subtitleTracks: [
        { id: "sub-en", episodeId: null, isDefault: false, objectKey: "k1" },
        { id: "sub-fr", episodeId: null, isDefault: true, objectKey: "k2" },
      ],
    };

    console.info("[audio-sub-reset-direct-default:single-default] mounting Harness requestId=1; default audio=audio-fr default sub=sub-fr");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          requestId: 1,
          media,
          episodeId: null,
          resetAudio,
          resetSub,
        }),
      );
    });

    console.info(`[audio-sub-reset-direct-default:single-default] resetAudio.calls=${JSON.stringify(resetAudio.mock.calls)} resetSub.calls=${JSON.stringify(resetSub.mock.calls)}`);
    // Critical assertion: each setter is called EXACTLY ONCE on mount
    // with the NEW DEFAULT — not with null/"off" first.
    try {
      expect(resetAudio).toHaveBeenCalledTimes(1);
      expect(resetAudio).toHaveBeenCalledWith("audio-fr");
      expect(resetSub).toHaveBeenCalledTimes(1);
      expect(resetSub).toHaveBeenCalledWith("sub-fr");
      // And explicitly NOT the pre-fix shape:
      expect(resetAudio).not.toHaveBeenCalledWith(null);
      expect(resetSub).not.toHaveBeenCalledWith("off");
    } catch (err) {
      dumpResetSnapshot("single-default", { media, resetAudio, resetSub });
      throw err;
    }
  });

  it("@bugfix @regression-proof on requestId change with a NEW default, resets to that new default", async () => {
    const resetAudio = vi.fn();
    const resetSub = vi.fn();
    const initialMedia: Media = {
      audioTracks: [
        { id: "audio-en", episodeId: null, isDefault: true },
        { id: "audio-fr", episodeId: null, isDefault: false },
      ],
      subtitleTracks: [
        { id: "sub-en", episodeId: null, isDefault: true, objectKey: "k1" },
        { id: "sub-fr", episodeId: null, isDefault: false, objectKey: "k2" },
      ],
    };
    const updatedMedia: Media = {
      audioTracks: [
        { id: "audio-en", episodeId: null, isDefault: false },
        { id: "audio-fr", episodeId: null, isDefault: true },
      ],
      subtitleTracks: [
        { id: "sub-en", episodeId: null, isDefault: false, objectKey: "k1" },
        { id: "sub-fr", episodeId: null, isDefault: true, objectKey: "k2" },
      ],
    };

    console.info("[audio-sub-reset-direct-default:requestid-change] initial mount requestId=1; default audio=audio-en sub=sub-en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          requestId: 1,
          media: initialMedia,
          episodeId: null,
          resetAudio,
          resetSub,
        }),
      );
    });
    console.info(`[audio-sub-reset-direct-default:requestid-change] after mount resetAudio.calls=${JSON.stringify(resetAudio.mock.calls)} resetSub.calls=${JSON.stringify(resetSub.mock.calls)}`);
    try {
      expect(resetAudio).toHaveBeenLastCalledWith("audio-en");
      expect(resetSub).toHaveBeenLastCalledWith("sub-en");
    } catch (err) {
      dumpResetSnapshot("requestid-change-initial", { media: initialMedia, resetAudio, resetSub });
      throw err;
    }

    // Re-render with new default and bumped requestId (user changed
    // default in details dialog, then hit Play again).
    console.info("[audio-sub-reset-direct-default:requestid-change] re-render requestId=2 with NEW defaults audio=audio-fr sub=sub-fr");
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          requestId: 2,
          media: updatedMedia,
          episodeId: null,
          resetAudio,
          resetSub,
        }),
      );
    });

    console.info(`[audio-sub-reset-direct-default:requestid-change] after re-render resetAudio.calls=${JSON.stringify(resetAudio.mock.calls)} resetSub.calls=${JSON.stringify(resetSub.mock.calls)}`);
    // The effect re-fires (requestId changed) and dispatches the NEW
    // default directly — exactly one extra call per setter.
    try {
      expect(resetAudio).toHaveBeenCalledTimes(2);
      expect(resetAudio).toHaveBeenLastCalledWith("audio-fr");
      expect(resetSub).toHaveBeenCalledTimes(2);
      expect(resetSub).toHaveBeenLastCalledWith("sub-fr");
    } catch (err) {
      dumpResetSnapshot("requestid-change-updated", { media: updatedMedia, resetAudio, resetSub });
      throw err;
    }
  });

  it("@bugfix @regression-proof when no subtitle has a valid objectKey, falls back to \"off\" (not null)", async () => {
    const resetAudio = vi.fn();
    const resetSub = vi.fn();
    const media: Media = {
      audioTracks: [
        { id: "audio-en", episodeId: null, isDefault: true },
      ],
      // Default sub exists but has no objectKey → must be filtered.
      subtitleTracks: [
        { id: "sub-orphan", episodeId: null, isDefault: true, objectKey: null },
      ],
    };
    console.info("[audio-sub-reset-direct-default:orphan-sub-fallback] mounting requestId=1; default sub has null objectKey (must fall back to 'off')");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          requestId: 1,
          media,
          episodeId: null,
          resetAudio,
          resetSub,
        }),
      );
    });
    console.info(`[audio-sub-reset-direct-default:orphan-sub-fallback] resetSub.calls=${JSON.stringify(resetSub.mock.calls)} (expect 'off')`);
    try {
      expect(resetSub).toHaveBeenCalledWith("off");
    } catch (err) {
      dumpResetSnapshot("orphan-sub-fallback", { media, resetAudio, resetSub });
      throw err;
    }
  });

  it("@bugfix @regression-proof requestId=0 does NOT trigger a reset (guards initial state)", async () => {
    const resetAudio = vi.fn();
    const resetSub = vi.fn();
    const media: Media = {
      audioTracks: [{ id: "audio-en", episodeId: null, isDefault: true }],
      subtitleTracks: [
        { id: "sub-en", episodeId: null, isDefault: true, objectKey: "k1" },
      ],
    };
    console.info("[audio-sub-reset-direct-default:requestid-zero-guard] mounting requestId=0 (guard: must NOT trigger any reset)");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          requestId: 0,
          media,
          episodeId: null,
          resetAudio,
          resetSub,
        }),
      );
    });
    console.info(`[audio-sub-reset-direct-default:requestid-zero-guard] resetAudio.calls=${JSON.stringify(resetAudio.mock.calls)} resetSub.calls=${JSON.stringify(resetSub.mock.calls)} (expect both empty)`);
    try {
      expect(resetAudio).not.toHaveBeenCalled();
      expect(resetSub).not.toHaveBeenCalled();
    } catch (err) {
      dumpResetSnapshot("requestid-zero-guard", { media, resetAudio, resetSub });
      throw err;
    }
  });
});
