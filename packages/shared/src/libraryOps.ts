import type { IngestJob, IngestJobEvent, MediaDetails } from "./libraryTypes";

export type LibraryOpBase = {
  id: string;
  type: string;
  createdAt: string;
};

export type PlaylistCreateOp = LibraryOpBase & {
  type: "playlist.create";
  payload: {
    id: string;
    name: string;
    slug: string | null;
    isSystem: boolean;
    createdAt: string;
  };
};

export type PlaylistDeleteOp = LibraryOpBase & {
  type: "playlist.delete";
  payload: {
    id: string;
  };
};

export type PlaylistItemAddOp = LibraryOpBase & {
  type: "playlist.item.add";
  payload: {
    id: string;
    playlistId: string;
    mediaId: string;
    addedAt: string;
  };
};

export type PlaylistItemRemoveOp = LibraryOpBase & {
  type: "playlist.item.remove";
  payload: {
    playlistId: string;
    mediaId: string;
  };
};

export type MediaUpsertOp = LibraryOpBase & {
  type: "media.upsert";
  payload: {
    details: MediaDetails;
  };
};

export type MediaDeleteOp = LibraryOpBase & {
  type: "media.delete";
  payload: {
    mediaId: string;
  };
};

export type MediaProgressOp = LibraryOpBase & {
  type: "media.progress";
  payload: {
    mediaId: string;
    progressPct: number;
    lastWatchedAt: string | null;
    updatedAt: string;
  };
};

export type SettingSetOp = LibraryOpBase & {
  type: "setting.set";
  payload: {
    key: string;
    value: string;
    updatedAt: string;
  };
};

export type IngestJobUpsertOp = LibraryOpBase & {
  type: "ingest.job.upsert";
  payload: {
    job: IngestJob;
  };
};

export type IngestJobDeleteOp = LibraryOpBase & {
  type: "ingest.job.delete";
  payload: {
    jobId: string;
  };
};

export type IngestJobEventAddOp = LibraryOpBase & {
  type: "ingest.job.event.add";
  payload: {
    event: IngestJobEvent;
  };
};

export type IngestJobHistoryClearOp = LibraryOpBase & {
  type: "ingest.job.history.clear";
  payload: {
    mediaId: string;
  };
};

export type LibraryOp =
  | PlaylistCreateOp
  | PlaylistDeleteOp
  | PlaylistItemAddOp
  | PlaylistItemRemoveOp
  | MediaUpsertOp
  | MediaDeleteOp
  | MediaProgressOp
  | SettingSetOp
  | IngestJobUpsertOp
  | IngestJobDeleteOp
  | IngestJobEventAddOp
  | IngestJobHistoryClearOp;
