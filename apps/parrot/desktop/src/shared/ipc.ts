import type { HiddenJobNoticesBridge } from "@space/desktop-shell/hidden-job-notices-preload";
import type { ErrorReportsBridge } from "@space/error-report/desktop";
import type { UpdaterBridge } from "@space/desktop-shell/updater";
import type { LibraryKeyEraseOutcome } from "@space/desktop-shell/library-key-erase";
import type { AccountKeyResult } from "@space/desktop-shell/account-key-check";
import type { DesktopPasswordResetActions } from "@space/desktop-shell/password-reset";
import type { DesktopFeedbackInput } from "@space/error-report/desktop-feedback";
import type { SignInFailure } from "@space/shared/signInError";
import type { KeyStepMetaErrorClass } from "@space/shared/keyStepMetaRead";
import type { StorageUnitBase } from "@space/shared/format";
import type { ProviderReturnBridge, ProviderSignInErrorCode } from "@space/shared/providerSignIn";
import type { AccountNoticesList, SignInProvider } from "@space/shared/api";
import type { AccountAccess } from "@space/shared/accountAccess";
import type { ResendVerificationFailure, SignUpFailure, VerifyEmailFailure } from "@space/shared/signUp";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import type { CreditsProduct, SourceCredits } from "@space/metadata-client/credits";
import type { ProfileFeatures } from "@space/shared/appFeatures";
import type { ParrotImportEdit, ParrotImportScan, ParrotLibraryAlbum, ParrotLibraryArtist, ParrotLibraryTrack } from "@space/parrot-ingest";
import type { KeepCopyChoice, KeptKind, KeptStatus, ParrotEditTarget, ParrotLyrics, ParrotManageTarget, ParrotOwnLyrics, ParrotPlaylist, ParrotPlaylistEdit } from "@space/parrot-core";
import type { ParrotPhotoCredit } from "@space/parrot-library-db-definition";
import type { ParrotCoverCrop, ParrotImportPlacedFile, ParrotImportUnidentifiedFile } from "@space/parrot-core";
import type { ParrotLibraryPatch } from "./libraryPatch";
import type { KeyChangeFailure } from "@space/shared/keyChangeFailure";
import type { KeyChangeOutcome, KeyChangeState, UnreadableFile } from "@space/media-reseal";
import type { KeyRotationReadiness } from "@space/shared/keyChange";

import type { ParrotEditCover, ParrotEditSuggestion, ParrotEditSuggestQuery, ParrotEditValues } from "@space/parrot-core";

export type { ParrotEditCover, ParrotEditValues } from "@space/parrot-core";
export type { KeyChangeState, UnreadableFile } from "@space/media-reseal";

/** The key change dialog opened: a new key's words to write down, and whether the account has a password (ACCT-AUTH-04). */
export type ParrotKeyChangeOpen = { ok: true; words: string[]; hasPassword: boolean } | { ok: false };

/** How a key change step ended: switched (signed out), copying paused, waiting on another device, or refused. */
export type ParrotKeyChangeResult = { status: KeyChangeOutcome } | KeyChangeFailure;

/** The media library key change (ACCT-KEYCHG-01, STOR-RESEAL-01), run in main on the controller Badger runs too. */
export type ParrotKeyChangeBridge = {
  /** ACCT-KEYCHG-04: `GET /library/recovery/rotate`; null while unknown (the entry stays hidden). */
  readiness(): Promise<KeyRotationReadiness | null>;
  open(): Promise<ParrotKeyChangeOpen>;
  /** Start (password and code, ACCT-KEYCHG-03) from the form; Finish once the run is open (no reauth). */
  submit(password: string, twoFactorCode?: string): Promise<ParrotKeyChangeResult>;
  switchNow(): Promise<ParrotKeyChangeResult>;
  poll(): Promise<ParrotKeyChangeResult>;
  stop(): Promise<ParrotKeyChangeResult>;
  /** Leaving Settings: the copying pauses between files. */
  pause(): Promise<void>;
  unreadableFiles(): Promise<UnreadableFile[]>;
  /** True once deleted. */
  deleteUnreadableFiles(files: UnreadableFile[]): Promise<boolean>;
  onState(listener: (state: KeyChangeState) => void): () => void;
};
export type { ParrotImportEdit, ParrotImportScan, ParrotScanEntry } from "@space/parrot-ingest";
/** The songs the user ticked in the confirm dialog, with the names they confirmed (PAR-UP-05); their lyrics come with {@link ParrotImportLyricsChoice}. */
export type ParrotImportSelection = Array<Omit<ParrotImportEdit, "lyrics"> & { file: string }>;
/**
 * PAR-LYR-09: a lyrics file of the waiting scan the user left placed on a song in the review: one of the import's (its
 * audio file) or of the library (its id). A same-name `.lrc` not among them was removed from its song.
 */
export type ParrotImportLyricsChoice = { lyricsFile: string; song: { file: string } | { trackId: string } };
/** Settings › Manage offline content (OFFL-MANAGE-01): each kept item's song files, and the bytes each kept file takes here. */
export type ParrotKeptSizes = { entries: Array<{ kind: KeptKind; id: string; fileIds: string[] }>; bytes: Record<string, number> };
import type { BillingStatus, PaidPlanId, PaymentOutcome, SubscriptionChangeAnswer } from "@space/shared/billingCheckout";
import type { MusicAlbum, MusicAlbumTrack, ScheduledPlanChange } from "@space/shared/api";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import type { BillingPeriod } from "@space/shared/storagePlans";
import type { ApprovePairingProof, ApprovePairingResult, PairingRequestView } from "@space/pairing-crypto";
import type { PairedKeyCheck, PairingPollResult, PairingStartOptions, PairingStartResult } from "@space/desktop-shell/pairing";
import type { SiblingSignInActions } from "@space/desktop-shell/sibling";
import type { StreamSlotAnswer, StreamSlotGateState } from "@space/stream-slots";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";
import type { FounderStatusResponse } from "@space/shared/founder";

/** What the main process and the window exchange. The session token never leaves main; the library key only once, when made for a new account. */

export type ParrotLanguage = "en" | "fr" | "nl" | "de" | "es";
export const PARROT_LANGUAGES: readonly ParrotLanguage[] = ["en", "fr", "nl", "de", "es"];

/**
 * UX-SETUP-06, on a computer: the setup screens, in order. Sign-in is not one of them: it is its own screen before
 * setup (Chris 2026-11-09). "Your profile" (UX-SETUP-10) shows only while the main profile still owes it; otherwise
 * setup skips it and does not count it.
 */
export const PARROT_SETUP_STEPS = ["language", "libraryKey", "profile", "folders", "startAtLogin", "errorReports"] as const;
export type ParrotSetupStep = (typeof PARROT_SETUP_STEPS)[number];

/** The screens of this setup run: "Your profile" only while it is counted (the main profile owes it, or answered it here). */
export const parrotSetupSteps = (withProfile: boolean): readonly ParrotSetupStep[] =>
  withProfile ? PARROT_SETUP_STEPS : PARROT_SETUP_STEPS.filter((step) => step !== "profile");

/** Setup answers, saved on every Next so a quit resumes at the same screen with the same answers (UX-SETUP-07). */
export type ParrotSetupState = {
  step: ParrotSetupStep;
  done: boolean;
  language: ParrotLanguage;
  /** Folders to import once at the end of setup; empty = "no folder for now". */
  folders: string[];
  startAtLogin: boolean;
  errorReports: boolean;
};

export type ParrotUser = { id: string; email: string };

export type ParrotState = {
  setup: ParrotSetupState;
  user: ParrotUser | null;
  hasLibraryKey: boolean;
  /** ACCT-DEV-03: this computer holds the library key, so the user's own Sign out first asks whether it was saved. */
  asksKeySavedBeforeSignOut: boolean;
  apiBaseUrl: string;
  isDevBuild: boolean;
  /** The system's Music folder when it exists (UX-SETUP-06), else null. */
  musicFolder: string | null;
  appVersion: string;
};

export type ParrotSignInResult =
  | { ok: true; user: ParrotUser }
  /** `retryAfterMinutes`: when to try again after too many attempts (`rateLimited`, ACCT-AUTH-11). */
  | { ok: false; failure: SignInFailure; retryAfterMinutes: number };

/** ACCT-AUTH-10: creating an account here. Success sends the verification code by email; the window then asks for it. */
export type ParrotSignUpResult = { ok: true } | { ok: false; failure: SignUpFailure; retryAfterMinutes: number };
/** The emailed code accepted signs this computer in, like a sign-in. */
export type ParrotVerifyEmailResult =
  | { ok: true; user: ParrotUser }
  | { ok: false; failure: VerifyEmailFailure; retryAfterMinutes: number };
export type ParrotResendVerificationResult =
  | { ok: true }
  | { ok: false; failure: ResendVerificationFailure; retryAfterMinutes: number };

/** ACCT-SIGNIN-05: a Google, Apple or Microsoft sign-in opened in the system browser, or why it did not start. */
export type ParrotProviderStartResult = { ok: true } | { ok: false; failure: SignInFailure; retryAfterMinutes: number };
/**
 * The returned code traded for a session. `error`: the code is spent (`invalid_code`, `account_deletion_pending`, or
 * `provider_failed` for anything unexpected); `failure`: the sign-in can go on (the second step, a wrong code, too
 * many attempts, no network), with the same code.
 */
export type ParrotProviderCompleteResult =
  | { ok: true; user: ParrotUser }
  | { ok: false; error: ProviderSignInErrorCode }
  | { ok: false; failure: SignInFailure; method?: "email" | "totp"; retryAfterMinutes: number };
/**
 * ACCT-SIGNIN-05: the provider rows. Main talks to the API and keeps the session; the window keeps the secret whose
 * hash started the sign-in and pulls the outcome the `parrot://auth/provider` link brought back (`takeReturn`).
 */
export type ParrotProviderSignInBridge = ProviderReturnBridge & {
  /** The providers that are on, in row order; empty (no rows) when none is, or the API did not answer. */
  list(): Promise<SignInProvider[]>;
  start(provider: SignInProvider, clientChallenge: string): Promise<ParrotProviderStartResult>;
  complete(input: { code: string; verifier: string; twoFactorCode?: string; resendTwoFactor?: boolean }): Promise<ParrotProviderCompleteResult>;
};

/** What an approved phone sign-in tells the window: main keeps the token and the key, the window only learns the check. */
export type ParrotPairedSignIn = { check: PairedKeyCheck };

export type ParrotImportStatus = {
  running: boolean;
  /**
   * `review`: a scan is done and waits in the confirm dialog; nothing is uploaded until confirmImport (PAR-UP-05).
   * `cancelled`: the user stopped it with the Jobs panel's X; the songs published before that stay (UX-JOBS-02).
   */
  phase: "idle" | "scanning" | "review" | "uploading" | "publishing" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  imported: number;
  skipped: number;
  failed: number;
  /** Bytes of the picked files through so far, of `bytesTotal` (PAR-UP-04). */
  bytesDone: number;
  bytesTotal: number;
  /** Library versions published by this import so far; the window reloads the library on each (PAR-UP-03). */
  published: number;
  currentFile: string | null;
  error: string | null;
  /** PAR-UP-07: the albums this import is adding songs to; the library shows them greyed until it ends. */
  importingAlbums?: string[];
  /** PAR-UP-07: the artists whose photo this import is still fetching; they show a loading picture, not a drawn one. */
  fetchingArtists?: string[];
  /**
   * UX-ADD-01: on scanImport's answer only, the sources waiting behind the import under way (running, or its scan in
   * the review); they are scanned once it ends or its review is answered.
   */
  queuedSources?: number;
};

/**
 * One import as the top bar's Jobs panel lists it (UX-JOBS-01): from the scan to its end, with every file that did
 * not make it in and why. Main keeps the finished ones per account across restarts until the user removes them.
 */
export type ParrotImportJob = {
  id: string;
  /** The folders or files the import was started from. */
  sources: string[];
  startedAt: number;
  finishedAt: number | null;
  status: ParrotImportStatus;
  /** Files the scan could not read and files whose upload failed, with the reason; `status.failed` counts them. */
  failures: Array<{ file: string; error: string }>;
  /** The albums the import added songs to, for that album's Jobs tab (UX-JOBS-02); absent on imports saved before. */
  albumIds?: string[];
  /**
   * UX-JOBS-03: on an import that stopped or left files out, true when none of what "Import again" would read is
   * still where it was; main checks each time it sends the list.
   */
  sourcesMissing?: boolean;
  /**
   * UX-JOBS-02 / PAR-UP-13: the running import's songs, one bucket each with its song's job and its light-copy job,
   * read from the job engine; absent once the import ended (its card then counts what it added).
   */
  songs?: ParrotImportSong[];
};

/** UX-JOBS-02: one job row of a song in the Jobs panel: the song's own job (upload), or its light copy (PAR-UP-13). */
export type ParrotImportRow = {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  /** The step it is at (`probe`, `identify`, `extract`, `transcode`, `upload`, `commit`), or `queued`. */
  stage: string;
  progressPct: number;
  /** 1-based place among the jobs of its kind still waiting to start; null once it runs or ended. */
  placeInLine: number | null;
  error: string | null;
};

/** UX-JOBS-02: a song of the running import, its bucket in the Jobs panel. */
export type ParrotImportSong = { file: string; source: ParrotImportRow; light: ParrotImportRow | null };

/**
 * PAR-UP-15: what imports do while a song plays on this computer (full speed, slowed down, or paused until it stops).
 * `picked` is false while the user never chose: `mode` is then this computer's hardware recommendation.
 */
export type ParrotUploadsWhilePlaying = { mode: "full" | "throttle" | "pause"; recommended: "full" | "throttle" | "pause"; picked: boolean };

/**
 * UX-JOBS-03: the answer to "Import again" or "Find the folder". Started, the job is replaced by the new import,
 * which stops at the review like any import. Not started: another import is running, the files are gone (the card
 * turns to "Find the folder"), or the job is no longer in the list.
 */
export type ParrotImportRetry = { started: true } | { started: false; reason: "busy" | "missing" | "gone" };

/** UX-JOBS-03: an ended import the card offers to try again: it stopped, or some of its files were not added. */
export const importJobRetryable = (job: ParrotImportJob): boolean =>
  !job.status.running && (job.status.phase === "failed" || (job.status.phase === "done" && job.failures.length > 0));

/**
 * Slow work Parrot runs on its own after an import or a sign-in (UX-JOBS-02): a quiet line in the Jobs panel says
 * how far it is, like Badger's crew line. `done` of `total` items (songs or artists) handled so far.
 */
export type ParrotBackgroundWork = { kind: "lyrics" | "artistPhotos" | "covers"; done: number; total: number };

/** The error of an import cut short because Parrot quit while it ran; the window shows its own sentence for it. */
export const IMPORT_INTERRUPTED = "interrupted";

/**
 * "Download everything" (OFFL-FILE-01, ACCT-EXPORT-01, Chris 2026-11-21): the whole library saved as plain audio
 * files into a folder the user picks. How many songs it would save and their size, for its confirm.
 */
export type ParrotExportPreview = { songs: number; bytes: number };

/**
 * One export in the Jobs panel. An export Parrot's closing cut short goes on at the next start (ACCT-EXPORT-01).
 * `error` is `EXPORT_NO_SPACE` (the disk filled up, OFFL-SAFE-02) or the reason as it came.
 */
export type ParrotExportJob = {
  id: string;
  /** The folder the user picked. */
  dest: string;
  startedAt: number;
  finishedAt: number | null;
  phase: "queued" | "running" | "done" | "cancelled" | "failed";
  doneSongs: number;
  totalSongs: number;
  doneBytes: number;
  totalBytes: number;
  /** The song being written now. */
  current: string | null;
  error: string | null;
  /** Songs that could not be saved, with the reason; the others are in the folder. */
  failures: Array<{ title: string; reason: string }>;
};

/** Why an export did not start: no folder picked, nothing to save, or not enough room on that disk (OFFL-SAFE-02). */
export type ParrotExportStart =
  | { ok: true; job: ParrotExportJob }
  | { ok: false; reason: "no-folder" | "empty" | "no-library" }
  | { ok: false; reason: "no-space"; neededBytes: number; freeBytes: number };

export const EXPORT_NO_SPACE = "no-space";
/** An export Parrot's closing cut short whose folder is gone at the next start (a memory stick taken out). */
export const EXPORT_FOLDER_MISSING = "folder-missing";

/**
 * An album as the window gets it: instead of the cover's storage keys, the addresses main serves the opened cover from
 * (PAR-META-04, the picture built into the music files), or null when the album has none (the drawn tile). `coverUrl`
 * is the large copy (album page, system media panel); `coverThumbUrl` the small one (tiles, now-playing bar), which is
 * the large copy again for an album imported before small copies existed.
 */
export type ParrotDesktopAlbum = Omit<ParrotLibraryAlbum, "coverObjectKey" | "coverThumbObjectKey"> & {
  coverUrl: string | null;
  coverThumbUrl: string | null;
};

/**
 * An artist as the window gets it (PAR-META-15): instead of the photo's storage keys, the addresses main serves it from
 * (null while the artist has none: the drawn circle), and the photo's credit line parts when it needs one.
 */
export type ParrotDesktopArtist = Omit<
  ParrotLibraryArtist,
  "pictureObjectKey" | "pictureThumbObjectKey" | "pictureAuthor" | "pictureLicence" | "pictureLicenceUrl"
> & {
  pictureUrl: string | null;
  pictureThumbUrl: string | null;
  pictureCredit: ParrotPhotoCredit | null;
};

export type ParrotLibrary = {
  snapshotVersion: number | null;
  artists: ParrotDesktopArtist[];
  albums: ParrotDesktopAlbum[];
  tracks: ParrotLibraryTrack[];
  /** Liked songs first, then the user's playlists by name (PAR-PL-01). */
  playlists: ParrotPlaylist[];
};

export type ParrotLibraryResult = { ok: true; library: ParrotLibrary } | { ok: false; error: string };
/** A song's loudness measured from its decoded audio (PAR-PLAY-03 item 2): ReplayGain 2.0 gain in dB and sample peak. */
export type ParrotMeasuredLoudness = { trackId: string; gainDb: number; peak: number };
/** PAR-LYR-05: `found` with the song's lyrics now kept in the library, or `none` when our lyrics library had none. */
export type ParrotFetchLyricsResult = { ok: true; outcome: "found" | "none"; lyrics: ParrotLyrics | null } | { ok: false; error: string };
/** PAR-LYR-08/11: the user's own lyrics kept or removed, with what the Lyrics tab shows now. */
export type ParrotOwnLyricsResult = { ok: true; lyrics: ParrotLyrics | null } | { ok: false; error: string };

/** What deleting a song, an album or an artist would remove, for the confirm dialog (PAR-LIB-03). */
export type ParrotDeletePreview = { ok: true; trackCount: number; albumCount: number } | { ok: false; error: string };
/**
 * PAR-META-18: what our music library suggests for what is typed in the edit dialog, ranked against all its fields;
 * a lookup that fails says why (the dialog keeps the library's own suggestions).
 */
export type ParrotEditSuggestResult = { ok: true; results: ParrotEditSuggestion[] } | { ok: false; error: string };

/** PAR-UP-05: an album of our music library with its 500 px cover as a data: URL (null when it has none). */
export type ParrotImportFoundAlbum = { album: MusicAlbum; cover: string | null };
/** An album the lookup placed files on, with its full tracklist and those files (`sure` false: "Check"). */
export type ParrotImportMatchedAlbum = ParrotImportFoundAlbum & { tracklistKnown: boolean; files: ParrotImportPlacedFile[] };
/**
 * PAR-UP-08: one album of the waiting scan looked up on its own. `albums` are the albums its files really match;
 * `unidentified` the files matching nothing (`lookup-failed` when the lookup could not be asked), imported as is.
 * `stopped`: "Import as is" stopped the lookup (or the scan was answered), the album is imported from its tags.
 */
export type ParrotImportAlbumMatch =
  | { kind: "found"; albums: ParrotImportMatchedAlbum[]; unidentified: ParrotImportUnidentifiedFile[] }
  | { kind: "stopped" };
/** PAR-UP-08 "Wrong album? Search": the albums our music library found for what the user typed. */
export type ParrotImportAlbumSearch = { kind: "found"; results: ParrotImportFoundAlbum[] } | { kind: "failed" };
/**
 * PAR-UP-08: a picture the review can make an album's cover (built into the album's files, or an image file the user
 * picked): `id` names it in the confirm, `data` is what the window shows (a JPEG or PNG at most 500 px wide), `width`
 * and `height` the picture's own size, `files` how many of the album's files carry it.
 */
export type ParrotImportPicture = { id: string; data: string; width: number; height: number; files: number };
/** PAR-META-22: a cover main cannot decode (WebP, GIF), sent to the window to be cut to its square on a canvas. */
export type ParrotCoverCutRequest = { id: string; bytes: Uint8Array; mime: string; crop: ParrotCoverCrop | null };
/** PAR-UP-06: a matched artist's photo as a data: URL (null when no source has one) and its credit (Commons photos only). */
export type ParrotImportArtistPhoto = { photo: string | null; credit: ParrotPhotoCredit | null };

/**
 * A billing call made by main with the session token (ACCT-PAY-01). `code` is the API's error code
 * (`billing_unavailable`, `checkout_in_progress`, `library_too_large`, ...) or `request_failed`, so the
 * shared plan change words it the way it does in Badger; `excessBytes` rides a `library_too_large`
 * refusal (ACCT-PLAN-08).
 */
export type ParrotBillingResult<T> = { ok: true; value: T } | { ok: false; code: string; excessBytes?: number };

/** The account's plan, as `GET /account/subscription` gives it, with a booked change and a held renewal (ACCT-PLAN-07/11). */
export type ParrotSubscription = {
  plan: string;
  /** `null` = unlimited (admin, ACCT-PLAN-14): no plan shown, no plans or checkout offered. */
  storageLimitGb: number | null;
  storageUsedGb: number;
  storageAddonCount: number;
  paidUntil: string | null;
  billingPeriod: BillingPeriod | null;
  scheduledChange: ScheduledPlanChange | null;
  renewalHold: { chargeAt: string } | null;
};

export type ParrotPlanOptions = { billingPeriod: BillingPeriod; addonCount: number };
export type ParrotCheckoutInput = ParrotPlanOptions & { plan: PaidPlanId; lang: string };

/**
 * A profile call made by main with the session token (ACCT-PROF-01, ACCT-PROF-02). A refusal keeps the API's `status`
 * and `code` (`profile_limit`, `last_profile`, ...) so the window's shared profile store words it as in Badger;
 * `offline` is a network failure.
 */
export type ParrotProfilesResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string } | { ok: false; offline: true };
export type ParrotProfileAnswer = ProfilesResponse & { profile: ApiProfile };

/** The API the preload script exposes as `window.parrot`. */
export type ParrotBridge = {
  getState(): Promise<ParrotState>;
  saveSetup(patch: Partial<ParrotSetupState>): Promise<ParrotState>;
  signIn(input: { email: string; password: string; twoFactorCode?: string }): Promise<ParrotSignInResult>;
  /**
   * ACCT-AUTH-10: creates an account in this computer's language (its emails, ACCT-EMAIL-01) with the News box as
   * ticked (ACCT-NEWS-01); the API emails a verification code (ACCT-AUTH-01).
   */
  signUp(input: { email: string; password: string; newsOptIn: boolean }): Promise<ParrotSignUpResult>;
  /** The emailed code: accepted, this computer is signed in to the new account. */
  verifyEmail(input: { email: string; code: string }): Promise<ParrotVerifyEmailResult>;
  resendVerification(email: string): Promise<ParrotResendVerificationResult>;
  /** ACCT-AUTH-05: "Forgot password?" — main mails the code and sets the new password (the shared desktop contract). */
  passwordReset: DesktopPasswordResetActions;
  providerSignIn: ParrotProviderSignInBridge;
  /**
   * UX-I18N-07: the signed-in account's language from a fresh `/auth/me` (`language: null` when the account has none);
   * `ok: false` when the server did not answer. Read once right after a sign-in to reconcile it with this computer's.
   */
  getAccountLanguage(): Promise<{ ok: true; language: ParrotLanguage | null } | { ok: false }>;
  /** UX-I18N-07: saves the account's one language (`PATCH /account/settings`), for every app and the emails; false when it failed. */
  saveAccountLanguage(language: ParrotLanguage): Promise<boolean>;
  /** ACCT-NEWS-01: whether the account gets News emails, from `GET /account/settings`; `ok: false` when the server did not answer. */
  getNewsOptIn(): Promise<{ ok: true; newsOptIn: boolean } | { ok: false }>;
  /** ACCT-NEWS-01: turns News emails on or off (`PATCH /account/settings`); the saved value, or `ok: false` when it failed. */
  saveNewsOptIn(newsOptIn: boolean): Promise<{ ok: true; newsOptIn: boolean } | { ok: false }>;
  /** WAIT-FOUND-04: the account's founder status (`GET /account/founder`, asked by main with the token); `ok: false` when the server did not answer. */
  getFounderStatus(): Promise<{ ok: true; status: FounderStatusResponse } | { ok: false }>;
  /** WAIT-FOUND-04: the one-time founder notice was shown (`POST /account/founder/notice-seen`); false when it failed. */
  markFounderNoticeSeen(): Promise<boolean>;
  /** SF_FIRST_TOUR=off: test harnesses silence the first-open tour and the player tip (PAR-TOUR-01..03). */
  readonly firstTourOff: boolean;
  /** SF_PROFILE_SETUP=off: test harnesses silence "Your profile" and "New in this update" (UX-SETUP-10, UX-UPDATE-01). */
  readonly profileSetupOff?: boolean;
  /**
   * ACCT-PAIR-01/05: "Sign in with your phone". Main runs the shared new-device client (keypair, poll secret, token and
   * library key stay in main); an approved poll signs in, checks the key and returns only the check.
   */
  pairing: {
    /** `{ mode: "key" }`: the key step asks another signed-in device for the library key only (no new session). */
    start(options?: PairingStartOptions): Promise<PairingStartResult>;
    poll(requestId: string): Promise<PairingPollResult<ParrotPairedSignIn>>;
    cancel(): Promise<void>;
  };
  /** ACCT-PAIR-07: "Continue with your Badger account" when Badger is signed in on this computer; the key check only. */
  sibling?: SiblingSignInActions<ParrotPairedSignIn>;
  signOut(): Promise<ParrotState>;
  /**
   * The key as base64 (typed words' `keyBase64`, or a new key once written down). Checked against the account; on an
   * account with no key yet it becomes the account's (its probe written) and is kept.
   */
  setLibraryKey(keyBase64: string): Promise<AccountKeyResult>;
  /**
   * The key step's first question: an account with no library and no key probe gets a new key's 12 words to show
   * (nothing kept until `setLibraryKey`); an account that has a key answers "hasLibrary" and the step asks for it.
   */
  createLibraryKey(): Promise<ParrotCreateKeyResult>;
  /**
   * PRIV-KEY-01: erases the account's whole vault (every app, every profile) after the password (and code), then this
   * computer's key and cache; setup goes back to the key step.
   */
  eraseLibrary(password: string, twoFactorCode?: string): Promise<LibraryKeyEraseOutcome>;
  /** ACCT-KEYCHG-01: Settings › Account's media library key change, run in main (Badger's library re-encrypted alongside). */
  keyChange: ParrotKeyChangeBridge;
  pickFolders(): Promise<string[]>;
  /** UX-ADD-01: song files picked from the "+" dialog; scanImport takes them like folders. */
  pickFiles(): Promise<string[]>;
  /** UX-ADD-01: the local path of a file dropped on the window (Electron's webUtils.getPathForFile). */
  getPathForFile(file: File): string;
  /**
   * PAR-UP-05: lists the songs in `folders` and reads their tags, uploading nothing. While it runs the status is
   * `scanning` (done of total files read); then `review`, and getImportScan returns what it found.
   */
  scanImport(folders: string[]): Promise<ParrotImportStatus>;
  /** The scan waiting for the user's answer, or null when none is. */
  getImportScan(): Promise<ParrotImportScan | null>;
  /**
   * PAR-UP-08: looks up one album of the waiting scan (`files`, named `id` by the review) on its own; answers
   * `stopped` once stopImportAlbumMatch stopped it.
   */
  matchImportAlbum(question: { id: string; files: string[] }): Promise<ParrotImportAlbumMatch>;
  /** PAR-UP-08 "Import as is": stops one album's lookup. */
  stopImportAlbumMatch(id: string): Promise<void>;
  /** Searches our music library for an album to place songs on (a failure answers `failed`). */
  searchImportAlbums(question: { artist: string; album: string }): Promise<ParrotImportAlbumSearch>;
  /** PAR-UP-08: the different pictures built into these files of the waiting scan, for an album's cover menu. */
  importAlbumPictures(files: string[]): Promise<ParrotImportPicture[]>;
  /** PAR-UP-08 "Choose an image file…": an image the user picks for an album's cover; null when none is picked. */
  pickImportCoverImage(): Promise<ParrotImportPicture | null>;
  /** PAR-META-22: main asks the window to cut a cover it cannot decode; the listener answers with coverCut. */
  onCoverCut(listener: (request: ParrotCoverCutRequest) => void): () => void;
  /** The cut cover (a JPEG, or a PNG when see-through), or null when the window could not draw it. */
  coverCut(id: string, bytes: Uint8Array | null): Promise<void>;
  /** A matched artist's photo for the import review (PAR-UP-06), asked once per waiting scan; a failure answers none. */
  importArtistPhoto(artistId: string): Promise<ParrotImportArtistPhoto>;
  /** A searched album's 500 px cover as a data: URL (PAR-UP-05), asked once per waiting scan; none or a failure answers null. */
  importCover(albumId: string): Promise<string | null>;
  /**
   * Uploads only the ticked songs of the waiting scan, with the user's edits, and keeps the lyrics files where the
   * review placed them (PAR-LYR-09); files not in that scan are ignored.
   */
  confirmImport(selection: ParrotImportSelection, lyrics: ParrotImportLyricsChoice[]): Promise<ParrotImportStatus>;
  /** Drops the waiting scan (nothing is uploaded), or stops the running import: the songs already published stay. */
  cancelImport(): Promise<ParrotImportStatus>;
  getImportStatus(): Promise<ParrotImportStatus>;
  onImportStatus(listener: (status: ParrotImportStatus) => void): () => void;
  /** The signed-in account's imports, newest first (UX-JOBS-01). */
  getImportJobs(): Promise<ParrotImportJob[]>;
  onImportJobs(listener: (jobs: ParrotImportJob[]) => void): () => void;
  /** Removes a finished or failed import from the list; a running one stays. */
  dismissImportJob(id: string): Promise<ParrotImportJob[]>;
  /** UX-JOBS-03 "Import again": scans the job's folders again, or only its files not added; the job gives way to the new import. */
  retryImportJob(id: string): Promise<ParrotImportRetry>;
  /** UX-JOBS-03 "Find the folder": main asks for the folder, then imports it in place of the job; nothing picked answers cancelled. */
  findImportJobFolder(id: string): Promise<ParrotImportRetry | { cancelled: true }>;
  /** UX-JOBS-02: tries a song's failed job (or its light copy) again while its import runs; false when it cannot. */
  retryImportSong(jobId: string): Promise<boolean>;
  /** UX-JOBS-02: stops one song's job (or its light copy) of the running import; false when it already ended. */
  cancelImportSong(jobId: string): Promise<boolean>;
  /** PAR-UP-15: this computer's "Uploads while playing" setting. */
  getUploadsWhilePlaying(): Promise<ParrotUploadsWhilePlaying>;
  setUploadsWhilePlaying(mode: ParrotUploadsWhilePlaying["mode"]): Promise<ParrotUploadsWhilePlaying>;
  /** PAR-UP-15: a song is playing (renewed every few seconds while it plays) or stopped. */
  playbackActive(active: boolean): void;
  /** OFFL-FILE-01 / ACCT-EXPORT-01: how many songs "Download everything" would save, and their size. */
  previewExport(): Promise<ParrotExportPreview>;
  /** Asks for a folder, then saves the whole library there as plain audio files, in the background (Jobs panel). */
  exportMusic(): Promise<ParrotExportStart>;
  /** The signed-in account's exports, newest first. */
  getExportJobs(): Promise<ParrotExportJob[]>;
  onExportJobs(listener: (jobs: ParrotExportJob[]) => void): () => void;
  /** Stops a running or waiting export: the songs already saved stay, nothing half-written is left. */
  cancelExport(id: string): Promise<ParrotExportJob[]>;
  /** Removes an ended export from the list (the files stay where they are). */
  dismissExportJob(id: string): Promise<ParrotExportJob[]>;
  /** The background lookups running now, for the Jobs panel's quiet line (UX-JOBS-02); empty when none runs. */
  getBackgroundWork(): Promise<ParrotBackgroundWork[]>;
  onBackgroundWork(listener: (work: ParrotBackgroundWork[]) => void): () => void;
  getLibrary(refresh: boolean): Promise<ParrotLibraryResult>;
  /**
   * One song's own lyrics from the open library (PAR-LYR-01), null when it has none or no library is open; `searching`
   * when it has none and the automatic lookup still has it queued or running (PAR-LYR-06).
   */
  getLyrics(trackId: string): Promise<ParrotLyrics | null>;
  /**
   * The automatic lyrics lookup kept new lyrics (or "no lyrics") for some songs, or songs entered or left its queue
   * (PAR-LYR-01, PAR-LYR-06): read the playing song's again.
   */
  onLyricsChanged(listener: () => void): () => void;
  /** The automatic artist-photo lookup kept new photos (PAR-META-15): read the library again from the opened copy. */
  onLibraryChanged(listener: () => void): () => void;
  /** An import published a song (PAR-UP-03): what changed in the library, to apply to the one shown (#2509). */
  onLibraryPatch(listener: (patch: ParrotLibraryPatch) => void): () => void;
  /** The albums the automatic cover lookup still has to ask (PAR-META-20): their covers show as on their way. */
  getCoversWaiting(): Promise<string[]>;
  onCoversWaiting(listener: (albumIds: string[]) => void): () => void;
  /** Saves playlist and heart edits into the encrypted library; the result is the library after the save (PAR-PL-03). */
  editPlaylists(edits: ParrotPlaylistEdit[]): Promise<ParrotLibraryResult>;
  /** Counts what deleting `target` would remove; changes nothing. */
  previewDelete(target: ParrotManageTarget): Promise<ParrotDeletePreview>;
  /** PAR-LIB-03: deletes the stored files first, then the rows, and publishes; the result is the library after it. */
  deleteFromLibrary(target: ParrotManageTarget): Promise<ParrotLibraryResult>;
  /** A song's or an album's current details, for the edit dialog. */
  getEditValues(target: ParrotManageTarget): Promise<ParrotEditValues>;
  /** PAR-META-31: an artist's name and the photo it shows now (custom or automatic), for the artist edit dialog. */
  getArtistEditValues(artistId: string): Promise<{ name: string; pictureUrl: string | null } | null>;
  /** PAR-META-16 / PAR-META-31: saves edited details (and an album's new cover or an artist's new photo), publishes; result is library after it. */
  editDetails(target: ParrotEditTarget, cover: ParrotEditCover | null): Promise<ParrotLibraryResult>;
  /** PAR-LYR-05: asks our lyrics library for a song whose file has none and keeps what it finds in the library. */
  fetchLyrics(trackId: string): Promise<ParrotFetchLyricsResult>;
  /** PAR-LYR-08: keeps the user's own lyrics of a song; they win over any found ones. */
  setOwnLyrics(trackId: string, lyrics: ParrotOwnLyrics): Promise<ParrotOwnLyricsResult>;
  /** PAR-LYR-11: removes the user's own lyrics; the song falls back to the usual sources. */
  removeOwnLyrics(trackId: string): Promise<ParrotOwnLyricsResult>;
  /**
   * PAR-COPY-01: a playing song never looked up goes first in the automatic lyrics pass (the window itself never looks
   * it up); it is "Looking for lyrics…" until the pass kept its answer.
   */
  wantLyrics(trackId: string): Promise<void>;
  /**
   * PAR-PLAY-03 item 2: keeps the loudness measured here for songs that had none, in one publish; a song that has a
   * value by now keeps it. The result is the library after it.
   */
  saveLoudness(measured: readonly ParrotMeasuredLoudness[]): Promise<ParrotLibraryResult>;
  /** PAR-META-18: asks our music library what fits what is typed in the edit dialog; changes nothing. */
  suggestEdit(query: ParrotEditSuggestQuery): Promise<ParrotEditSuggestResult>;
  /** PAR-META-18: the cover of an album picked in the edit dialog (500 px), null when none or the lookup fails. */
  suggestEditCover(coverId: string): Promise<ParrotEditCover | null>;
  /** A local address the in-app player streams the file from (PAR-PLAY-01). */
  playbackUrl(fileId: string): Promise<string>;
  /**
   * A local address the loudness pass reads the song's own file from (PAR-PLAY-03), beside the player: it picks no
   * copy and its downloads do not count as the player's (PAR-PLAY-02).
   */
  measureUrl(fileId: string): Promise<string>;
  /**
   * ACCT-STREAM-01..04: asks for one of the profile's streams before a song starts. `"cancel"`: the user chose Cancel
   * at "Already playing on {device}. Play here instead?". A song kept on this computer never asks.
   */
  streamAcquire(trackId: string): Promise<"play" | "cancel">;
  /** OPS-BIZ-20: the window opened a screen; adds one to the daily hello's screen tally. */
  noteScreen(): Promise<void>;
  streamAnswer(answer: StreamSlotAnswer): Promise<void>;
  /** Closes the "Playing on {device} now" notice. */
  streamDismiss(): Promise<void>;
  /** The music stopped: gives the place back. */
  streamRelease(): Promise<void>;
  getStreamState(): Promise<StreamSlotGateState>;
  /** The question to ask, or another device took the place over (stop the music). */
  onStreamState(listener: (state: StreamSlotGateState) => void): () => void;
  /** UX-SUP-05: the error log goes along only when `attachLog` is true. */
  sendFeedback(input: DesktopFeedbackInput): Promise<{ ok: boolean; error?: string }>;
  /** REL-LOG-06: the user's answer about error reports (kept by main in `<userData>/error-reports.json`). */
  errorReports: ErrorReportsBridge;
  /** REL-UPD-01: the in-app updater (`@space/desktop-shell/updater`). */
  updater: UpdaterBridge;
  /**
   * REL-CD-29: the API refused this build with "please update" (426). Only main talks to the API, so main latches the
   * first refusal and tells the window; `getAppUpdateRequired` reads it (null until refused), `onAppUpdateRequired`
   * fires once when it happens.
   */
  getAppUpdateRequired(): Promise<AppUpdateRequiredPayload | null>;
  onAppUpdateRequired(listener: (payload: AppUpdateRequiredPayload) => void): () => void;
  /** STOR-UNIT-01: the storage unit base main worked out from the platform and desktop (null if main did not say). */
  storageUnitBase: StorageUnitBase | null;
  /** Settings' data credits (META-SRC-09): main asks the lookups' metadata service (`GET /credits`); rejects offline. */
  sourceCredits(product: CreditsProduct, language: string): Promise<SourceCredits>;
  getSubscription(): Promise<ParrotBillingResult<ParrotSubscription>>;
  /**
   * ACCT-UNPAID-05/06: the account's access from a fresh `/auth/me` (null when the API gave none), for the unpaid sign
   * in the top bar and the setup step that creates the library.
   */
  getAccountAccess(): Promise<ParrotBillingResult<AccountAccess | null>>;
  /** UX-NOTICE-05: the account's news (`GET /account/notices`), for the bell's history. */
  listAccountNotices(): Promise<ParrotBillingResult<AccountNoticesList>>;
  /** `GET /billing/status`: the provider, `checkoutAllowed` and why not. */
  getBillingStatus(): Promise<ParrotBillingResult<BillingStatus>>;
  /** The server applies, books (`effectiveAt`), drops a booking, or refuses the plan (ACCT-PLAN-07/08/12). */
  updateSubscription(plan: string, options: ParrotPlanOptions): Promise<ParrotBillingResult<SubscriptionChangeAnswer>>;
  /** Stancer: the hosted payment page to open in the system browser, and the payment to complete. */
  startCheckout(input: ParrotCheckoutInput): Promise<ParrotBillingResult<{ url: string; paymentId: string; paid: boolean }>>;
  completePayment(paymentId: string): Promise<ParrotBillingResult<{ outcome: PaymentOutcome }>>;
  /** ACCT-PAY-05: the browser came back through `parrot://billing/return?payment=<id>`; returns the unsubscribe. */
  onPaymentReturn(listener: (paymentId: string) => void): () => void;
  /**
   * ACCT-PAIR-01/02: approve another device by the code it shows. Main runs the shared approver with the token and the
   * library key; the window only ever sees the request's view and an error kind.
   */
  lookupPairing(code: string): Promise<ApprovePairingResult<PairingRequestView>>;
  /**
   * Seals the library key for the looked-up request only; a wrong password (`wrong_password`) leaves it pending. An
   * account without a password sends `{ code }` instead (ACCT-AUTH-04): an empty one asks the API for it.
   */
  approvePairing(requestId: string, proof: ApprovePairingProof): Promise<ApprovePairingResult<{ sessionId: string | null }>>;
  denyPairing(requestId: string): Promise<ApprovePairingResult<null>>;
  /** PAR-OFFL-01/03: what is kept on this computer. */
  getKept(): Promise<KeptStatus>;
  /** OFFL-MANAGE-01: each kept item's song files and the bytes each kept file takes on this computer. */
  getKeptSizes(): Promise<ParrotKeptSizes>;
  /** The copies to ask about before keeping; two or more is a real choice to put to the user (PAR-OFFL-02). */
  keepChoices(kind: KeptKind, id: string): Promise<KeepCopyChoice[]>;
  keep(kind: KeptKind, id: string, choice: string | null): Promise<KeptStatus>;
  /** "Remove from this computer": the songs no other kept item holds are deleted. */
  unkeep(kind: KeptKind, id: string): Promise<KeptStatus>;
  onKept(listener: (status: KeptStatus) => void): () => void;
  /** UX-NOTICE-06: the hidden-window job notification's setting, and the Jobs request its click left. */
  hiddenJobNotices?: HiddenJobNoticesBridge;
  /** The account's profiles (`GET/POST /profiles`, `PATCH/DELETE /profiles/{id}`), asked by main with the token. */
  listProfiles(): Promise<ParrotProfilesResult<ProfilesResponse>>;
  createProfile(body: { name: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures }): Promise<ParrotProfilesResult<ParrotProfileAnswer>>;
  /** New name and/or avatar (ACCT-PROF-05). */
  updateProfile(id: string, body: { name?: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures }): Promise<ParrotProfilesResult<ParrotProfileAnswer>>;
  deleteProfile(id: string): Promise<ParrotProfilesResult<ProfilesResponse>>;
};

/**
 * UX-KEY-01: a new key comes with its 12 words, which the user saves; `keyBase64` is what every key path uses.
 * UX-KEY-02: "network" means main could not tell whether the account has a key (its meta or library could not be
 * read, or not in time): the step shows Retry, and `errorClass` picks why.
 */
export type ParrotCreateKeyResult =
  | { ok: true; keyBase64: string; words: string[] }
  | { ok: false; error: "hasLibrary" }
  | { ok: false; error: "network"; message?: string; errorClass: KeyStepMetaErrorClass };

export const PARROT_IPC = {
  getState: "parrot:state:get",
  saveSetup: "parrot:setup:save",
  signIn: "parrot:auth:sign-in",
  signUp: "parrot:auth:sign-up",
  verifyEmail: "parrot:auth:verify-email",
  resendVerification: "parrot:auth:resend-verification",
  passwordResetRequest: "parrot:auth:password-reset-request",
  passwordResetConfirm: "parrot:auth:password-reset-confirm",
  signOut: "parrot:auth:sign-out",
  getAccountLanguage: "parrot:account:language-get",
  saveAccountLanguage: "parrot:account:language-save",
  getNewsOptIn: "parrot:account:news-get",
  saveNewsOptIn: "parrot:account:news-save",
  getFounderStatus: "parrot:account:founder-get",
  markFounderNoticeSeen: "parrot:account:founder-notice-seen",
  setLibraryKey: "parrot:key:set",
  createLibraryKey: "parrot:key:create",
  eraseLibrary: "parrot:key:erase",
  keyChangeReadiness: "parrot:key-change:readiness",
  keyChangeOpen: "parrot:key-change:open",
  keyChangeSubmit: "parrot:key-change:submit",
  keyChangeSwitchNow: "parrot:key-change:switch-now",
  keyChangePoll: "parrot:key-change:poll",
  keyChangeStop: "parrot:key-change:stop",
  keyChangePause: "parrot:key-change:pause",
  keyChangeUnreadableFiles: "parrot:key-change:unreadable-files",
  keyChangeDeleteUnreadableFiles: "parrot:key-change:unreadable-delete",
  keyChangeStateEvent: "parrot:key-change:state-event",
  pickFolders: "parrot:folders:pick",
  pickFiles: "parrot:files:pick",
  scanImport: "parrot:import:scan",
  getImportScan: "parrot:import:scan-get",
  matchImportAlbum: "parrot:import:match-album",
  stopImportAlbumMatch: "parrot:import:match-album-stop",
  searchImportAlbums: "parrot:import:search-albums",
  importAlbumPictures: "parrot:import:album-pictures",
  pickImportCoverImage: "parrot:import:cover-pick",
  coverCutEvent: "parrot:covers:cut-event",
  coverCut: "parrot:covers:cut",
  importArtistPhoto: "parrot:import:artist-photo",
  importCover: "parrot:import:cover",
  confirmImport: "parrot:import:confirm",
  cancelImport: "parrot:import:cancel",
  getImportStatus: "parrot:import:status",
  importStatusEvent: "parrot:import:status-event",
  getImportJobs: "parrot:import:jobs",
  importJobsEvent: "parrot:import:jobs-event",
  dismissImportJob: "parrot:import:jobs-dismiss",
  retryImportJob: "parrot:import:jobs-retry",
  retryImportSong: "parrot:import:song-retry",
  cancelImportSong: "parrot:import:song-cancel",
  getUploadsWhilePlaying: "parrot:uploads-while-playing:get",
  setUploadsWhilePlaying: "parrot:uploads-while-playing:set",
  playbackActive: "parrot:playback-active",
  findImportJobFolder: "parrot:import:jobs-find-folder",
  previewExport: "parrot:export:preview",
  exportMusic: "parrot:export:start",
  getExportJobs: "parrot:export:jobs",
  exportJobsEvent: "parrot:export:jobs-event",
  cancelExport: "parrot:export:cancel",
  dismissExportJob: "parrot:export:dismiss",
  getBackgroundWork: "parrot:background-work:get",
  backgroundWorkEvent: "parrot:background-work:event",
  getLibrary: "parrot:library:get",
  getLyrics: "parrot:library:lyrics",
  lyricsChangedEvent: "parrot:library:lyrics-changed",
  libraryChangedEvent: "parrot:library:changed",
  libraryPatchEvent: "parrot:library:patch",
  getCoversWaiting: "parrot:library:covers-waiting",
  coversWaitingEvent: "parrot:library:covers-waiting-event",
  editPlaylists: "parrot:playlists:edit",
  previewDelete: "parrot:library:delete-preview",
  deleteFromLibrary: "parrot:library:delete",
  getEditValues: "parrot:library:edit-values",
  getArtistEditValues: "parrot:library:artist-edit-values",
  editDetails: "parrot:library:edit",
  fetchLyrics: "parrot:library:fetch-lyrics",
  setOwnLyrics: "parrot:library:set-own-lyrics",
  removeOwnLyrics: "parrot:library:remove-own-lyrics",
  wantLyrics: "parrot:library:want-lyrics",
  saveLoudness: "parrot:library:save-loudness",
  suggestEdit: "parrot:library:suggest-edit",
  suggestEditCover: "parrot:library:suggest-edit-cover",
  playbackUrl: "parrot:player:url",
  measureUrl: "parrot:player:measure-url",
  streamAcquire: "parrot:stream:acquire",
  noteScreen: "parrot:usage:note-screen",
  streamAnswer: "parrot:stream:answer",
  streamDismiss: "parrot:stream:dismiss",
  streamRelease: "parrot:stream:release",
  getStreamState: "parrot:stream:state",
  streamStateEvent: "parrot:stream:state-event",
  sendFeedback: "parrot:feedback:send",
  lookupPairing: "parrot:pairing:lookup",
  approvePairing: "parrot:pairing:approve",
  denyPairing: "parrot:pairing:deny",
  pairingStart: "parrot:sign-in-pairing:start",
  pairingPoll: "parrot:sign-in-pairing:poll",
  pairingCancel: "parrot:sign-in-pairing:cancel",
  getSubscription: "parrot:billing:subscription",
  getAccountAccess: "parrot:account:access",
  listAccountNotices: "parrot:account:notices",
  getBillingStatus: "parrot:billing:status",
  sourceCredits: "parrot:credits:get",
  updateSubscription: "parrot:billing:update",
  startCheckout: "parrot:billing:checkout",
  completePayment: "parrot:billing:complete",
  paymentReturnEvent: "parrot:billing:payment-return",
  providerList: "parrot:provider-sign-in:list",
  providerStart: "parrot:provider-sign-in:start",
  providerComplete: "parrot:provider-sign-in:complete",
  providerTakeReturn: "parrot:provider-sign-in:take",
  providerReturnEvent: "parrot:provider-sign-in:return",
  getKept: "parrot:kept:get",
  getKeptSizes: "parrot:kept:sizes",
  keepChoices: "parrot:kept:choices",
  keep: "parrot:kept:keep",
  unkeep: "parrot:kept:unkeep",
  keptEvent: "parrot:kept:event",
  listProfiles: "parrot:profiles:list",
  createProfile: "parrot:profiles:create",
  updateProfile: "parrot:profiles:update",
  deleteProfile: "parrot:profiles:delete",
  getAppUpdateRequired: "parrot:app-update-required:get",
  appUpdateRequiredEvent: "parrot:app-update-required:event",
} as const;
