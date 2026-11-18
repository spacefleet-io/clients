/**
 * MPV-PREV-01 / MPV-PREV-04: hands the playing file's seek-bar preview record to the main process, with what the seek
 * bar shows while it has none (MPV-PREV-06).
 *
 * Every metadata send hands it over (the main process keeps cached sheets for an equal record and re-tells the OSC).
 * Between sends, the runtime may record the sheets while the video already plays: an import decodes them after the
 * source commit, minutes for a film (MPV-PREV-02). `sendIfChanged` hands such a new record over at once, so the open
 * player shows them without being reopened.
 */
import type { MediaPreviewSheets } from "@space/shared/previewSheets";

export type PreviewSheetsHandoffPayload = {
  record: MediaPreviewSheets | null;
  /** MPV-PREV-06: the source format and the "being prepared" text, for when there is no record. */
  missing: { formatId: string | null; hint: string };
};

export type PreviewSheetsHandoffDeps = {
  /** The single IPC call to the main process (`sf-mpv-preview-sheets`). */
  deliver: (payload: PreviewSheetsHandoffPayload) => Promise<unknown> | undefined;
  log: (line: string, data: Record<string, unknown>) => void;
};

export type PreviewSheetsHandoff = {
  /** With every metadata send: hands the payload over, even unchanged. */
  send: (payload: PreviewSheetsHandoffPayload) => void;
  /** Mid-playback: hands the payload over when it differs from the last one handed over. True when it sent. */
  sendIfChanged: (payload: PreviewSheetsHandoffPayload) => boolean;
};

const summary = ({ record, missing }: PreviewSheetsHandoffPayload) => ({
  hasPreviews: record !== null,
  sheets: record?.sheets.length ?? 0,
  pictureCount: record?.pictureCount ?? 0,
  formatId: missing.formatId,
});

export const createPreviewSheetsHandoff = ({ deliver, log }: PreviewSheetsHandoffDeps): PreviewSheetsHandoff => {
  // Serialized payload last handed over; undefined before the first send and after a failed one.
  let lastSent: string | undefined;

  const send = (payload: PreviewSheetsHandoffPayload, reason: "metadata" | "changed") => {
    const serialized = JSON.stringify(payload);
    lastSent = serialized;
    const pending = deliver(payload);
    void pending?.catch((error: unknown) => {
      if (lastSent === serialized) lastSent = undefined;
      log("preview sheets handoff failed", { reason, ...summary(payload), message: error instanceof Error ? error.message : String(error) });
    });
  };

  return {
    send: (payload) => send(payload, "metadata"),
    sendIfChanged(payload) {
      if (JSON.stringify(payload) === lastSent) return false;
      log("preview sheets changed mid-playback, handing over", summary(payload));
      send(payload, "changed");
      return true;
    },
  };
};
