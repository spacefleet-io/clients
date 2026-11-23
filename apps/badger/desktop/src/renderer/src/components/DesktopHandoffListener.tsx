import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth";
import { useInlinePlayback } from "@/lib/useInlinePlayback";
import { rendererLogger } from "@/logger";

const handoffLog = rendererLogger.child({ scope: "handoff" });

type HandoffRequest = { handoffId: string; mediaId: string };

/**
 * PLAT-WEB-05: plays what the web player handed off to this desktop app. Main (main/handoffIpc.ts) receives the
 * runtime's `badger.handoff.play`, keeps the window hidden and sends `sf-handoff-play`; this listener starts the
 * playback through the same path as a library Play button (useInlinePlayback), resuming from the saved position
 * without the prompt nobody would see. A playback that cannot start is reported back (`sf-handoff-failed`); main
 * reports everything else from the external mpv messages. Renders only the playback controller mount.
 */
export default function DesktopHandoffListener() {
  const { user, loading } = useAuth();
  const { handlePlayMedia, playbackMount } = useInlinePlayback();
  const [queue, setQueue] = useState<HandoffRequest[]>([]);
  // A play pushed by main AND pulled through takePending is handled once.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const api = window.sf?.handoff;
    if (!api) return;
    const enqueue = (request: HandoffRequest, via: "push" | "pending") => {
      if (seenRef.current.has(request.handoffId)) {
        handoffLog.info({ ...request, via }, "[handoff] play already handled: ignored");
        return;
      }
      seenRef.current.add(request.handoffId);
      handoffLog.info({ ...request, via }, "[handoff] play received by the renderer");
      setQueue((current) => [...current, request]);
    };
    const unsubscribe = api.onPlay((request) => enqueue(request, "push"));
    void api
      .takePending()
      .then((pending) => {
        if (pending) enqueue(pending, "pending");
      })
      .catch((error: unknown) => {
        handoffLog.warn({ error: error instanceof Error ? error.message : String(error) }, "[handoff] takePending failed");
      });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (loading || queue.length === 0) return;
    const api = window.sf?.handoff;
    // Only the newest play matters: an older one was superseded by the web player.
    const request = queue[queue.length - 1];
    setQueue([]);
    if (!request) return;
    const reportFailed = (error: string) => {
      handoffLog.info({ ...request, error }, "[handoff] playback could not start: reporting failure");
      void api?.reportFailed({ handoffId: request.handoffId, error });
    };
    if (!user) {
      reportFailed("not_signed_in");
      return;
    }
    handoffLog.info({ ...request }, "[handoff] starting playback (auto-resume, no prompt)");
    handlePlayMedia(request.mediaId, { autoResume: true, onFailed: reportFailed });
  }, [handlePlayMedia, loading, queue, user]);

  return <>{playbackMount}</>;
}
