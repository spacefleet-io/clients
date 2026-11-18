// Types of the loopback media proxy's JS bridge (`PlaybackBridge`, `MediaProxy`).

/**
 * Configuration accepted by `PlaybackBridge.startProxy`. `storage-tunnel`
 * serves from the gateway (downloaded objects are served from disk first);
 * `offline` serves exclusively from disk.
 */
export type StartProxyConfig =
  | ({
      clientKind: "storage-tunnel";
      authToken: string;
      appId: "badger" | "parrot" | (string & {});
      /**
       * API id of the profile this playback is for (STOR-BW-11): sent in the `POST /storage/tunnel/session` body of
       * every `playback` session. Always a real id, the main profile's too; the native proxy refuses an empty one.
       */
      profileId: string;
      clientType?: string;
      clientVersion?: string;
    } & (
  | {
      /**
       * Phase 2B: ordered list of gateway base URLs. The native client walks
       * them sequentially with a 3s per-attempt timeout and uses the first
       * one that successfully creates a session. The winner is sticky for
       * the rest of the session and remembered across `startProxy` calls so
       * the next session retries the previous winner first.
       *
       * Build this from the storage placement policy's
       * `policy.shards[i].addresses[]` plus `policy.shards[i].gatewayUrl`,
       * deduped, in placement-pick order. Pass a single-element list to
       * disable waterfall and behave identically to `gatewayBaseUrl`.
       */
      gatewayBaseUrls: string[];
      gatewayBaseUrl?: never;
    }
  | {
      /**
       * Phase 2A: single gateway URL, no waterfall fallback.
       * Equivalent to `gatewayBaseUrls: [gatewayBaseUrl]`.
       */
      gatewayBaseUrl: string;
      gatewayBaseUrls?: never;
    }
    )
  )
  | {
      /**
       * Offline playback of a fully downloaded file: every object is read from
       * the encrypted on-disk store (see `DownloadsBridge`), no network.
       */
      clientKind: "offline";
    };

export type StartProxyArgs = {
  metadataJson: string;
  libraryKeyBase64: string;
  config: StartProxyConfig;
};

/** Backend of a proxy started without an HLS session (`MediaProxy.start`): the same configs `startProxy` takes. */
export type MediaProxyStartArgs = {
  libraryKeyBase64: string;
  config: StartProxyConfig;
};

/** One stored piece of a chunked file: the SFV1 object `objectKey` holds plaintext bytes `[plainOffset, plainOffset + plainSize)`. */
export type ChunkedFileChunk = {
  objectKey: string;
  plainOffset: number;
  plainSize: number;
};

/**
 * A file stored whole as encrypted plaintext chunks (a Parrot `track_files` row and its `track_file_chunks`, PAR-FMT-01).
 * The chunks must tile `[0, sizeBytes)` exactly, in any order.
 */
export type ChunkedFile = {
  id: string;
  mime: string;
  sizeBytes: number;
  chunks: ChunkedFileChunk[];
};

