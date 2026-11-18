/// <reference types="vite/client" />

// Type aliases for `@space/mpv-protocol` are referenced via inline
// `import(...)` syntax below — using top-level `import type` would turn
// this file into a module and break the global Window augmentation.
type _MpvCommand = import("@space/mpv-protocol").MpvCommand;
type _MpvResponse = import("@space/mpv-protocol").MpvResponse;
type _MpvExternalMessage = import("@space/mpv-protocol").MpvExternalMessage;
type _OscActionFile = import("@space/mpv-protocol").OscActionFile;
type _SubtitleEntry = import("@space/mpv-protocol").SubtitleEntry;
type _DeviceTranscodeSettings = import("../../shared/transcodeDefault").DeviceTranscodeSettings;
type _DeviceUploadsDuringPlaybackSettings = import("../../shared/uploadPlaybackDefault").DeviceUploadsDuringPlaybackSettings;
type _UploadsDuringPlayback = import("../../shared/uploadPlaybackDefault").UploadsDuringPlayback;
type _DeviceCapacityValues = import("../../shared/deviceCapacity").DeviceCapacityValues;
type _DeviceCapacitySettings = import("../../shared/deviceCapacity").DeviceCapacitySettings;
type _UploadsFirstRunAnswer = import("../../shared/uploadPlaybackDefault").UploadsFirstRunAnswer;
type _ErrorReportsState = import("@space/error-report/desktop").ErrorReportsState;
type _PairingStartResult = import("@space/desktop-shell/pairing").PairingStartResult;
type _PlaybackSaturationState = import("../../shared/playbackSaturation").PlaybackSaturationState;
type _PairingPollResult = import("@space/desktop-shell/pairing").PairingPollResult;

type _ToolAccessSnapshot = import("@space/tool-access/contracts").ToolAccessSnapshot;

type _ClientIdentity = import("@space/shared/appVersion").ClientIdentity;
type _ProviderReturn = import("@space/shared/providerSignIn").ProviderReturn;

interface Window {
  sf?: {
    version?: string;
    /** REL-CD-29: this build's identity (null for an unpackaged run), stated on every API call. */
    clientIdentity?: _ClientIdentity | null;
    /** STOR-UNIT-01: the storage unit base main worked out from the platform and desktop (null if main did not say). */
    storageUnitBase?: 1000 | 1024 | null;
    e2ePerfEnabled?: boolean;
    /** SF_FIRST_TOUR=off: test harnesses silence the first-open tour and the player tip (UX-TOUR-01..03). */
    firstTourOff?: boolean;
    getPlaybackBaseUrl?: () => Promise<string | null>;
    getMpvFlags?: () => { smokeTest: boolean; externalPlayer: boolean };
    setMediaKey?: (key: string | null) => Promise<void>;
    forwardKeyToRuntime?: (userId: string, keyBase64: string) => Promise<void>;
    hideAppWindow?: () => Promise<void>;
    showAppWindow?: () => Promise<void>;
    getAppWindowVisibility?: () => Promise<{ hidden: boolean; atMs: number; reason: string } | null>;
    onAppWindowVisibility?: (
      callback: (state: { hidden: boolean; atMs: number; reason: string }) => void,
    ) => () => void;
    onEscapeKey?: (callback: () => void) => () => void;
    signalPlaybackReady?: () => Promise<void>;
    launchExternalMpv?: (payload: {
      url: string;
      audioUrl?: string | null;
      backdropUrl?: string | null;
      startTime?: number | null;
      paused?: boolean;
      hlsBitrateBps?: number | null;
      /** PLAY-TRACK-04: per-load tracks for a launch on the stream itself (#2762). */
      audioTrack?: number | "no" | null;
      subtitleTrack?: number | "no" | null;
    }) => Promise<{
      bin: string;
      args: string[];
      backdropUsed?: boolean;
      /**
       * Main-process launch stages: handler entry → spawn (includes warmupWaitMs, the wait for the bundled
       * mpv's first exec), spawn → mpv IPC socket ready.
       */
      timings?: { prepareMs: number; warmupWaitMs: number; startMs: number | null };
    }>;
    /**
     * One answer per entry, in order: `url` is the cached file path, or "" when it is not on disk (fetch failed, or
     * `cachedOnly` and not cached yet: nothing is fetched then).
     */
    cacheExternalMpvSubtitles?: (
      payload: _SubtitleEntry[],
      options?: { cachedOnly?: boolean }
    ) => Promise<Array<{ url: string; title?: string | null; lang?: string | null }>>;
    clearExternalMpvSubtitleCache?: () => Promise<{ ok: true }>;
    /**
     * MPV-PREV-01: the playing video's seek-bar preview record (source format `previewSheets`, null = none).
     * MPV-PREV-06: `missing` {formatId, hint} for the "Previews are being prepared" line when there is no record.
     */
    setExternalMpvPreviewSheets?: (previewSheets: unknown, missing?: { formatId: string | null; hint: string }) => Promise<void>;
    getFfmpegCapabilities?: () => Promise<{
      ffmpegPath?: string | null;
      ffprobePath?: string | null;
      encoderOutputSample?: string | null;
      hwaccelOutputSample?: string | null;
      gpu: { vendor?: string | null; device?: string | null; driverVersion?: string | null; renderer?: string | null } | null;
      encoders: string[];
      hwaccels: string[];
      preferredEncoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
      lastTest?: { encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu"; ok: boolean; message?: string; logTail?: string; testedAt: string };
    }>;
    testFfmpegEncoder?: (encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu") => Promise<{
      encoder: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
      ok: boolean;
      message?: string;
      testedAt: string;
    }>;
    uploadSubtitleFile?: (payload: { token: string; path: string; placementId?: string | null }) => Promise<{
      key: string;
      sizeBytes: number;
      checksum: string;
    }>;
    /** "Get subtitles" (PLAY-SUBGET-01): encrypts and uploads subtitle text fetched from the metadata service. */
    uploadSubtitleContent?: (payload: {
      token: string;
      content: string;
      format: string;
      placementId?: string | null;
    }) => Promise<{ key: string; sizeBytes: number; checksum: string }>;
    sendExternalMpvCommand?: (command: _MpvCommand) => Promise<_MpvResponse>;
    // A raw JSON-IPC passthrough: main forwards the command to mpv unvalidated, and nothing in the renderer calls it
    // (it is a diagnostics channel for e2e/integration tests, which read properties outside the typed MpvProperty set).
    sendExternalMpvRequest?: (command: { command: [string, ...unknown[]] }) => Promise<_MpvResponse>;
    stopExternalMpv?: () => Promise<void>;
    isExternalMpvAlive?: () => Promise<boolean>;
    /** Runs the bundled mpv's first exec off the main thread, once per session (Defender scan, #928). */
    warmExternalMpv?: () => Promise<void>;
    onMpvExternalMessage?: (
      callback: (msg: _MpvExternalMessage) => void
    ) => () => void;
    getPendingOscAction?: () => Promise<{ action: _OscActionFile; seq: number } | null>;
    ackOscAction?: (seq: number) => void;
    __e2eSetPendingOscAction?: (action: _OscActionFile) => Promise<number>;
    setPlaybackToken?: (token: string | null) => Promise<void>;
    setAuthToken?: (token: string | null) => Promise<void>;
    createPlaybackStream?: (payload: {
      initKey: string;
      initSize: number;
      chunks: Array<{ key: string; sizeBytes: number }>;
      contentType: string;
    }) => Promise<{ id: string; url: string; totalSize: number }>;
    releasePlaybackStream?: (streamId: string) => Promise<void>;
    createPlaybackHlsSession?: (payload: {
      mode?: "vod" | "event";
      videos: Array<{
        id: string;
        quality: string;
        bitrateKbps: number | null;
        width: number | null;
        height: number | null;
        track: { initKey: string; codecString: string | null; segments: Array<{ key: string; durationSeconds: number }> };
      }>;
      audio: Array<{
        id: string;
        language: string;
        label: string;
        isDefault: boolean;
        track: { initKey: string; codecString: string | null; segments: Array<{ key: string; durationSeconds: number }> };
      }>;
    }) => Promise<{ id: string; url: string }>;
    releasePlaybackHlsSession?: (sessionId: string) => Promise<void>;
    /**
     * Auto quality (#25): upstream link throughput (bits/s) measured in main
     * over the tunnel fetches of HLS video media segments (busy-time EWMA),
     * capped by the test throttle while it is active. bps 0 / updatedAtMs
     * null until the first sample; reset on every new HLS session.
     */
    getPlaybackLinkEstimate?: () => Promise<{
      bps: number;
      sampleCount: number;
      updatedAtMs: number | null;
      throttleKbps: number;
    }>;
    /**
     * STOR-BW-07, STOR-BW-08, PLAY-QUAL-07: the saturation state of the silo serving the playback in progress (quality
     * cap, refused and stopped counters). Read once, then pushed. `reportPlaybackStopped` ends the playback from the
     * player side (no rung under the cap) so the stopped message shows.
     */
    getPlaybackSaturationState?: () => Promise<_PlaybackSaturationState>;
    onPlaybackSaturationChange?: (callback: (state: _PlaybackSaturationState) => void) => () => void;
    reportPlaybackStopped?: () => Promise<void>;
    /**
     * Offline-mode (Phase 2): open a range-served session over a single
     * locally-downloaded file. Main resolves the on-disk path from the
     * device-local media_local_downloads table by fileId. Works offline.
     */
    createPlaybackOfflineSession?: (payload: {
      fileId: string;
      mediaId?: string | null;
      localPath?: string;
    }) => Promise<{ id: string; url: string; totalSize: number }>;
    releasePlaybackOfflineSession?: (sessionId: string) => Promise<void>;
    prewarmPlaybackHlsSession?: (payload: {
      sessionId: string;
      videoId?: string | null;
      audioId?: string | null;
      startSeconds?: number | null;
    }) => Promise<{ warmedKeys: string[]; missedKeys: string[]; elapsedMs: number }>;
    resetPlaybackSignedUrlMetrics?: () => Promise<void>;
    getPlaybackSignedUrlMetrics?: () => Promise<{ resetAt: number; requests: number }>;
    libraryDb?: {
      open?: (payload: { token: string; keyBase64: string; userId: string }) => Promise<{ handle: string }>;
      openLocal?: (payload: { token: string; keyBase64: string; userId: string }) => Promise<{ handle: string }>;
      getLocalCacheBytes?: (keyBase64?: string) => Promise<Uint8Array | null>;
      hasLocalCache?: () => Promise<boolean>;
      clearLocalCache?: () => Promise<void>;
      /** ACCT-SQUAD-02: the chosen profile; kept by main and applied to every library it opens until sign-out. */
      setActiveProfile?: (profile: { id: string; isMain: boolean } | null) => Promise<{ applied: boolean }>;
      call?: (payload: { handle?: string; method: string; args?: unknown[] }) => Promise<unknown>;
      snapshot?: () => Promise<unknown>;
      // Phase 6: main now sends `{ snapshot, version }` (preferred) but
      // the legacy bare-snapshot shape is still accepted by the renderer
      // for back-compat with older preload bundles.
      onSnapshot?: (callback: (payload: unknown) => void) => () => void;
      onDatasetStatus?: (callback: (status: unknown) => void) => () => void;
    };
    pairing?: {
      start: (options?: import("@space/desktop-shell/pairing").PairingStartOptions) => Promise<_PairingStartResult>;
      poll: (requestId: string) => Promise<_PairingPollResult>;
      cancel: () => Promise<void>;
      deviceName: () => Promise<string>;
    };
    apiHost?: {
      get?: () => Promise<{
        apiBaseUrl: string;
        customApiBaseUrl: string | null;
        defaultApiBaseUrl: string;
        /** `SF_METADATA_URL` of the main process, or null. */
        metadataUrl?: string | null;
      }>;
      set?: (payload: {
        apiBaseUrl?: string | null;
        baseUrl?: string | null;
      }) => Promise<{
        apiBaseUrl: string;
        customApiBaseUrl: string | null;
        defaultApiBaseUrl: string;
      }>;
    };
    getDummyManifest?: () => Promise<unknown>;
    readDummyObject?: (key: string) => Promise<Uint8Array>;
    decodeSupSubtitles?: (
      url: string,
      preview?: boolean
    ) => Promise<Array<{ startMs: number; endMs: number; imageBase64: string }>>;
    probeMedia?: (path: string) => Promise<{
      video: { codec: string | null; width: number | null; height: number | null } | null;
      audio: { count: number; languages: string[] };
      subtitles: { count: number; languages: string[] };
      chapters: { count: number };
      durationSeconds: number | null;
      audioTracks: Array<{ index: number; language: string; label: string; codec: string | null; channels: number | null }>;
      subtitleTracks: Array<{ index: number; language: string; label: string; codec: string | null }>;
    }>;
    sampleAudioTrack?: (payload: { path: string; index: number; startSeconds?: number; durationSeconds?: number }) => Promise<string>;
    sampleSubtitleText?: (payload: { path: string; index?: number; external?: boolean; sampleIndex?: number }) => Promise<{
      kind: "text" | "image" | "message";
      value: string;
    }>;
    scanFiles?: (paths: string[]) => Promise<Array<{ path: string; name: string; size: number; kind: "video" | "subtitle" }>>;
    getPathForFile?: (file: File) => string;
    openFileDialog?: (options: { properties: string[] }) => Promise<string[]>;
    setWindowProcessingState?: (active: boolean) => void;
    reportUiLanguage?: (language: string) => void;
    /** Runs `callback` synchronously before main destroys the window for close-to-tray (pagehide does not fire). */
    onBeforeWindowDestroy?: (callback: () => void) => () => void;
    /** STOR-BW-11: the server refused the profile named on a playback (`profile_not_owned` or `profile_required`). */
    onPlaybackProfileRefused?: (callback: (code: string) => void) => () => void;
    runtime?: {
      getStatus?: () => Promise<{ status: string }>;
      onStatusChange?: (callback: (payload: { status: string }) => void) => () => void;
      restart?: () => Promise<{ ok: boolean }>;
      getBaseUrl?: () => Promise<{ baseUrl: string }>;
      /** RT-SEC-05: the runtime's current owner secret, asked of the main process at each login (never stored). null while no runtime has published one. */
      getOwnerSecret?: () => Promise<string | null>;
    };
    /**
     * #25: durable main-process copy of the signed-in session
     * (main/sessionStore.ts, `<userData>/session.json`), so an abrupt kill / crash
     * cannot sign the user out when Chromium's localStorage comes back empty.
     */
    session?: {
      /** Entries main held at preload time (read synchronously, before any renderer module runs). */
      snapshot: Record<string, string>;
      /** Replace main's copy with exactly these session entries (fsynced before it resolves). */
      replace: (entries: Record<string, string>) => Promise<{ ok: boolean }>;
    };
    /**
     * DEV-LIB-01: third-party tools that asked the local runtime for library access. Main holds the runtime
     * session (main/toolAccessIpc.ts); the renderer shows the approval prompt and the Connected tools list.
     */
    toolAccess?: {
      getSnapshot: () => Promise<_ToolAccessSnapshot>;
      decide: (payload: { requestId: string; decision: "approve" | "deny"; mode?: "read" | "write" }) => Promise<{ ok: boolean }>;
      revoke: (grantId: string) => Promise<{ ok: boolean }>;
      /** Pushed whenever a request arrives or is settled, or a grant is made or revoked. Returns the unsubscribe. */
      onUpdate: (callback: (snapshot: _ToolAccessSnapshot) => void) => () => void;
    };
    /**
     * PLAT-WEB-05: the web player hand-off. Main (main/handoffIpc.ts) holds the runtime session and reports the
     * playback; the renderer starts the playback in the hidden window and reports one it could not start.
     */
    handoff?: {
      /** Main asks to play `mediaId`. Returns the unsubscribe. */
      onPlay: (callback: (request: { handoffId: string; mediaId: string }) => void) => () => void;
      /** A play sent before this renderer listened (window still loading), once; null if none. */
      takePending: () => Promise<{ handoffId: string; mediaId: string } | null>;
      reportFailed: (payload: { handoffId: string; error: string }) => Promise<{ ok: boolean }>;
    };
    /** ACCT-PAY-05: the browser came back from Stancer's payment page through `badger://billing/return`. */
    billing?: {
      /** Main hands over the payment id. Returns the unsubscribe. */
      onPaymentReturn: (callback: (paymentId: string) => void) => () => void;
    };
    /** ACCT-SIGNIN-05: a Google, Apple or Microsoft sign-in came back through `badger://auth/provider`. */
    providerSignIn?: {
      /** Main nudges: an outcome waits in `takeReturn`. Returns the unsubscribe. */
      onReturn: (callback: () => void) => () => void;
      /** The waiting outcome (code or error), once; null when none waits. */
      takeReturn: () => Promise<_ProviderReturn | null>;
    };
    /**
     * #25: values that belong to THIS computer (main/deviceSettings.ts,
     * `<userData>/device-settings.json`), never synced to the account.
     */
    deviceSettings?: {
      /** This computer's fallback-360p-copy value; detects hardware on the first start. */
      getTranscode: () => Promise<_DeviceTranscodeSettings>;
      /** First-setup answer: agree with the recommendation or take the opposite; ignored once answered. */
      answerFirstRun: (answer: "accepted" | "overridden") => Promise<_DeviceTranscodeSettings>;
      /** Settings → Transcoding toggle. */
      setFallbackCopy: (value: boolean) => Promise<_DeviceTranscodeSettings>;
      /** What uploads do while a video plays on this computer (full / throttle / pause); derived from hardware on the first start. */
      getUploadsDuringPlayback: () => Promise<_DeviceUploadsDuringPlaybackSettings>;
      /** One-time first-run answer; ignored once answered. */
      answerUploadsFirstRun: (answer: _UploadsFirstRunAnswer) => Promise<_DeviceUploadsDuringPlaybackSettings>;
      /** Settings → Transcoding choice; takes effect live, even during playback. */
      setUploadsDuringPlayback: (value: _UploadsDuringPlayback) => Promise<_DeviceUploadsDuringPlaybackSettings>;
      /** ACCT-SQUAD-03: the one-time copy of the synced capacity values; returns this computer's values if it has some. */
      adoptCapacity: (seed: _DeviceCapacityValues) => Promise<_DeviceCapacitySettings>;
      /** Settings change of this computer's parallel transcodes, parallel extractions or watched folders. */
      setCapacity: (values: _DeviceCapacityValues) => Promise<_DeviceCapacitySettings>;
    };
    /**
     * REL-LOG-06: whether this computer sends error reports to SpaceFleet (@space/error-report/desktop-main,
     * `<userData>/error-reports.json`), never synced to the account. Off until the user opts in.
     */
    errorReports?: {
      get: () => Promise<_ErrorReportsState>;
      /** Stores the answer and starts or stops reporting at once. */
      set: (decision: "on" | "off") => Promise<_ErrorReportsState>;
    };
    /**
     * V2 ingest IPC surface. Backs the renderer's v2 hook. Always exposed; the
     * renderer chooses between v1 and v2 paths via `runtimeEngineV2Enabled`
     * (default true; set to false in localStorage for rollback).
     */
    runtimeJobs?: {
      /** Returns a ws:// URL the renderer can pass to createRuntimeJobsV2Stream. */
      getStreamUrl?: () => Promise<{ url: string; httpBaseUrl: string; token: string }>;
      list?: (filter?: {
        mediaId?: string;
        includeDismissed?: boolean;
      }) => Promise<{ jobs: unknown[]; maxEventId: number }>;
      cancel?: (payload: { jobId: string; reason?: string }) => Promise<{ cancelled: boolean }>;
      cancelByGroup?: (payload: {
        groupId: string;
        reason?: string;
      }) => Promise<{ cancelled: number; dismissed: number }>;
      dismiss?: (payload: { jobId: string }) => Promise<
        { dismissed: true } | { dismissed: false; errorCode: "not-terminal" }
      >;
      retry?: (payload: { jobId: string }) => Promise<{ retried: boolean; newJobId?: string }>;
      submitSources?: (payload: {
        userId: string;
        sources: Array<{
          filename: string;
          sizeMb?: number | null;
          sourceQuality?: string;
          desiredFormats?: string[];
          hints?: {
            mediaId?: string;
            pendingMediaPayload?: unknown;
            season?: number;
            episode?: number;
            matchedTitle?: string;
          };
          audioOverrides?: Array<{ index: number; language: string; label: string }>;
          subtitleOverrides?: Array<{ index: number; language: string; label: string }>;
        }>;
      }) => Promise<{
        submitted: Array<{
          groupId: string;
          sourceJobId: string;
          placementId: string | null;
          formatJobIds: Array<{ variant: string; jobId: string }>;
        }>;
      }>;
      /**
       * Binds the desktop ingest-concurrency settings to the live engineV2
       * lane caps. `maxParallelTranscodes` → format lane, `maxParallelExtractions`
       * → source lane. Both are clamped 1..3. `applied: false` (caps omitted)
       * means engineV2 was unavailable; the call still resolves without error.
       */
      configureScheduling?: (payload: {
        maxParallelTranscodes: number;
        maxParallelExtractions: number;
      }) => Promise<
        | { applied: boolean; caps?: { format: number; source: number } }
        | {
            __runtimeJobsError: true;
            status: number;
            errorCode: string | null;
            message: string | null;
          }
      >;
      attachAuth?: (payload: { userId: string; token: string }) => Promise<{ ok: true }>;
      /**
       * Post-ingest quality re-plan. Adds new transcoded qualities (queued as
       * `retranscode` format jobs streaming from the closest higher resolution
       * already in storage) and/or removes existing non-source formats from a
       * committed media file. Refusal is atomic: when `errorCode` is set, both
       * arrays are empty. See packages/runtime-contracts/src/badger/ingest.ts
       * and the post-ingest-qualities plan, Phase 4 + Phase 8.
       */
      replanQualities?: (payload: {
        mediaId: string;
        fileId: string;
        addQualities: string[];
        removeFormatIds: string[];
      }) => Promise<
        | {
            addedJobIds: Array<{ variant: string; jobId: string }>;
            removedFormatIds: string[];
            errorCode?:
              | "source-protected"
              | "quality-exists"
              | "cannot-transcode-up"
              | "media-not-found";
          }
        | {
            __runtimeJobsError: true;
            status: number;
            errorCode: string | null;
            message: string | null;
          }
      >;
    };
    storageGc?: {
      run?: (payload?: { dryRun?: boolean }) => Promise<{
        orphanedKeys: number;
        deletedKeys: number;
        reclaimedBytes: number;
        failedKeys: number;
        missingKeys: number;
      }>;
    };
    /**
     * Offline-mode bridge. Mirrors the typed Zod commands in
     * `@space/runtime-contracts/badger/offline` — main owns the
     * runtime-client session and Zod-validated sendCommand calls. The
     * result type is `unknown` here on purpose: renderer code MUST re-parse
     * via the contract's result schema (or call helpers that do so) to
     * narrow the union. See `lib/offlineIpc.ts` for the typed helpers.
     */
    offline?: {
      estimate?: (payload: {
        mediaIds: string[];
        /** Quality picked in the download prompt (OFFL-QUAL-01); absent = each file's highest. */
        quality?: string;
        container: "mkv" | "mp4";
        /** Optional narrow-scope filter — episode/season scopes pass the
         *  precise file ids so the runtime restricts the estimate to that
         *  subset. Absent for movie/show scopes. */
        fileIds?: string[];
      }) => Promise<unknown>;
      downloadSubmit?: (payload: {
        mediaIds: string[];
        quality?: string;
        container: "mkv" | "mp4";
        skipAlreadyLocal?: boolean;
        /** Optional narrow-scope filter — same precedence as estimate. */
        fileIds?: string[];
      }) => Promise<unknown>;
      deleteLocal?: (payload: {
        scope:
          | { type: "media"; mediaId: string }
          | { type: "season"; mediaId: string; seasonNumber: number }
          | { type: "file"; fileId: string };
      }) => Promise<unknown>;
      listLocal?: (payload?: { mediaIds?: string[] }) => Promise<unknown>;
      reconcile?: (payload?: { mediaIds?: string[] }) => Promise<unknown>;
    };
  };
  /**
   * Desktop updater bridge (REL-UPD-01), shared with Parrot. Backs the update button, the update modals and Settings.
   * An unpackaged dev build still exposes it, but `check` resolves `{ status: "unsupported" }`.
   */
  spaceBadger?: {
    updater?: import("@space/desktop-shell/updater").UpdaterBridge;
  };
}
