import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { LibraryDb } from "@space/library-db-runtime";
import { sealLibraryKey } from "@space/pairing-crypto";
import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import type { ApiProfile } from "@space/shared/profiles";
import { mergeTrackPrefs, parseTrackPrefs, serializeTrackPrefs, trackPrefsKey, type TrackPrefsPatch } from "@space/shared/trackPrefs";
import { loadIntegrationConfig } from "../src/config";
import { IntegrationRuntime } from "../src/runtime";
import { handleIntegrationRequest, type IntegrationDeps, type IntegrationStatus } from "../src/server";

/**
 * INTG-PROF-01 (badger-jellyfin): the plugin follows one account and ONE of its profiles, picked while pairing.
 * Viewing keys: the main profile uses the library's own storage,
 * any other profile `p:<profileId>:` keys (media_progress_v1 / episode_resume_v1 / track_prefs_v1).
 */

const API = "http://api.test";
const libraryKey = crypto.randomBytes(32);
const libraryKeyBase64 = libraryKey.toString("base64");

const phase = (test: string, message: string, data?: unknown) =>
  console.info(`[${test}] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const profile = (id: string, name: string, isMain: boolean, createdAt: string): ApiProfile => ({ id, name, avatar: 0, avatarId: "raccoon" as const, createdAt, isMain });
const MAIN = profile("main-id", "Chris", true, "2026-01-01T00:00:00.000Z");
const KID = profile("kid-id", "Kid", false, "2026-02-01T00:00:00.000Z");

type FakeApi = {
  profiles: ApiProfile[];
  approved: boolean;
  publicKey: string;
  requestId: string;
  calls: string[];
  /** `METHOD /path?query body` of every request, for STOR-BW-11. */
  requests: string[];
  logouts: string[];
  profileListFails: boolean;
  /** When set, playback session opens are refused with this answer (INTG-PROF-01: the followed profile is gone). */
  sessionRefusal: { status: number; error: string } | null;
};

/** Stand-in for the api: pairing routes, /profiles, /auth/me, /auth/logout; anything else answers `{exists:false}` (library meta). */
const installFakeApi = (overrides: Partial<FakeApi> = {}) => {
  const api: FakeApi = {
    profiles: [MAIN, KID],
    approved: true,
    publicKey: "",
    requestId: "11111111-2222-4333-8444-555555555555",
    calls: [],
    requests: [],
    logouts: [],
    profileListFails: false,
    sessionRefusal: null,
    ...overrides,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const auth = init?.headers ? new Headers(init.headers).get("authorization") : input instanceof Request ? input.headers.get("authorization") : null;
    api.calls.push(`${method} ${url.pathname}`);
    api.requests.push(`${method} ${url.pathname}${url.search} ${typeof init?.body === "string" ? init.body : ""}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // One silo answering on the api host; its session opens are refused at once (final, no retry): the STOR-BW-11 test reads the bodies.
    if (url.pathname === "/storage/placement" && method === "GET") return json({ policy: { epoch: 1, shards: [{ id: "s1", gatewayUrl: API, addresses: [], status: "active", weight: 1 }] } });
    if (url.pathname === "/storage/tunnel/session" && method === "POST") {
      if (api.sessionRefusal) return json({ error: api.sessionRefusal.error }, api.sessionRefusal.status);
      return json({ error: "subscription_unpaid" }, 402);
    }
    if (url.pathname === "/storage/traffic" && method === "GET") {
      return json({ traffic: { state: "normal", playbackBufferSeconds: null, saturated: false, qualityCap: null, playbackStopped: false } });
    }
    if (url.pathname === "/pairing/requests" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { publicKey: string };
      api.publicKey = body.publicKey;
      return json(
        { requestId: api.requestId, pollSecret: "secret", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: new Date(Date.now() + 300_000).toISOString() },
        201
      );
    }
    if (url.pathname === `/pairing/requests/${api.requestId}`) {
      if (!api.approved) return json({ status: "pending" });
      const sealed = sealLibraryKey({ devicePublicKey: api.publicKey, requestId: api.requestId, libraryKey: new Uint8Array(libraryKey) });
      return json({ status: "approved", token: "paired-token", user: { id: "u1", email: "me@example.com" }, sealedKey: sealed });
    }
    if (url.pathname === "/profiles" && method === "GET") {
      if (api.profileListFails) return json({ error: "unavailable" }, 503);
      if (auth !== "Bearer paired-token" && auth !== "Bearer stored-token") return json({ error: "unauthorized" }, 401);
      return json({ profiles: api.profiles, maxProfiles: 5 });
    }
    if (url.pathname === "/auth/me") return json({ user: { id: "u1", email: "me@example.com" }, access: { state: "paid", paidUntil: null, wipeAt: null } });
    if (url.pathname === "/auth/logout") {
      api.logouts.push(auth ?? "");
      return json({ ok: true });
    }
    return json({ exists: false });
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
  };
  return { api, restore };
};

const row = (id: string, type: "movie" | "tv", progressPct = 0): MediaRow => ({
  id,
  type,
  tmdbId: null,
  externalIds: null,
  title: id,
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  hasFiles: true,
  progressPct,
  lastWatchedAt: progressPct > 0 ? "2026-03-01T00:00:00.000Z" : null,
  totalEpisodes: type === "tv" ? 2 : null,
  episodeCount: type === "tv" ? 2 : 0,
});

const format = (mediaId: string, fileId: string) => ({
  id: `fmt-${fileId}`,
  mediaId,
  fileId,
  quality: "1080p",
  codec: "h264",
  bitrateKbps: 5000,
  sizeMb: 100,
  durationSeconds: 1000,
  chunks: [],
});

/** In-memory LibraryDb: the methods the runtime calls, with the main profile's own storage behaving like the real one. */
class FakeLibraryDb {
  readonly settings = new Map<string, { value: string; updatedAt: string }>();
  readonly setProgressCalls: unknown[][] = [];
  readonly setTrackPrefsCalls: unknown[][] = [];
  readonly settingWrites: Array<{ key: string; value: string }> = [];
  closed = false;
  readonly rows: MediaRow[] = [row("movie-1", "movie", 50), row("show-1", "tv", 10)];

  getVersion() {
    return 7;
  }
  listMedia() {
    return this.rows;
  }
  getMediaDetails(mediaId: string): MediaDetails | null {
    const base = this.rows.find((entry) => entry.id === mediaId);
    if (!base) return null;
    const movie = base.type === "movie";
    return {
      ...base,
      cast: [],
      playlistIds: [],
      seasons: movie ? [] : [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: null }],
      episodes: movie
        ? []
        : [
            { id: "ep-1", seasonNumber: 1, episodeNumber: 1, name: "One", overview: null, stillPath: null, airDate: "2020-01-01" },
            { id: "ep-2", seasonNumber: 1, episodeNumber: 2, name: "Two", overview: null, stillPath: null, airDate: "2020-01-08" },
          ],
      trailers: [],
      files: movie
        ? [{ id: "f-movie", filename: "m.mkv", season: null, episode: null, desiredFormats: [] }]
        : [
            { id: "f-e1", filename: "e1.mkv", season: 1, episode: 1, desiredFormats: [] },
            { id: "f-e2", filename: "e2.mkv", season: 1, episode: 2, desiredFormats: [] },
          ],
      formats: movie ? [format(mediaId, "f-movie")] : [format(mediaId, "f-e1"), format(mediaId, "f-e2")],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
      chapters: [],
      skipMarkers: [],
    } as unknown as MediaDetails;
  }
  getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  setSetting(key: string, value: string) {
    this.settings.set(key, { value, updatedAt: new Date().toISOString() });
    this.settingWrites.push({ key, value });
    return Promise.resolve();
  }
  setProgress(...args: unknown[]) {
    this.setProgressCalls.push(args);
    return Promise.resolve();
  }
  getTrackPrefs(mediaId: string) {
    return parseTrackPrefs(this.settings.get(trackPrefsKey(mediaId))?.value);
  }
  setTrackPrefs(mediaId: string, patch: TrackPrefsPatch) {
    this.setTrackPrefsCalls.push([mediaId, patch]);
    const merged = mergeTrackPrefs(this.getTrackPrefs(mediaId), patch, new Date().toISOString());
    this.settings.set(trackPrefsKey(mediaId), { value: serializeTrackPrefs(merged), updatedAt: merged.updatedAt });
    return Promise.resolve();
  }
  flushPending() {
    return Promise.resolve();
  }
  syncFromRemoteIfNewer() {
    return Promise.resolve(false);
  }
  close() {
    this.closed = true;
  }
}

type Harness = { dir: string; stateDir: string; keyFile: string; db: FakeLibraryDb; open: Mock; logs: Array<{ message: string; meta?: Record<string, unknown> }> };

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const harness = (test: string): Harness => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-profiles-"));
  dirs.push(dir);
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new FakeLibraryDb();
  const open = vi.fn(async () => db as unknown as LibraryDb);
  vi.spyOn(LibraryDb, "open").mockImplementation(open);
  const logs: Harness["logs"] = [];
  phase(test, "harness", { stateDir });
  return { dir, stateDir, keyFile: path.join(dir, "library.key"), db, open, logs };
};

const newRuntime = (test: string, h: Harness) => {
  const config = loadIntegrationConfig({ HEADLESS_STATE_DIR: h.stateDir, HEADLESS_LIBRARY_KEY_FILE: h.keyFile, HEADLESS_API_URL: API, HEADLESS_DEV_TICKET_KEY: "1" });
  const runtime = new IntegrationRuntime(config, (message, meta) => {
    h.logs.push({ message, meta });
    console.info(`[${test}] runtime: ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  });
  cleanups.push(() => runtime.stop());
  return runtime;
};

/** An already paired server: session, key file and (optionally) a stored profile choice. */
const seedSession = (h: Harness, stored?: { id: string; name: string; prefix: string }) => {
  fs.writeFileSync(h.keyFile, `${libraryKeyBase64}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(h.stateDir, "auth.json"), JSON.stringify({ token: "stored-token", email: "me@example.com", userId: "u1", apiUrl: API }));
  if (stored) fs.writeFileSync(path.join(h.stateDir, "profile.json"), JSON.stringify(stored));
};

const readJsonFile = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

const snapshot = (test: string, label: string, runtime: IntegrationRuntime, h: Harness) => {
  const status = runtime.status();
  phase(test, `${label} status`, {
    state: status.state,
    signedIn: status.signedIn,
    pairing: status.pairing?.state ?? null,
    profile: status.profile,
    profiles: status.profiles?.map((entry) => entry.id) ?? null,
    authFile: fs.existsSync(path.join(h.stateDir, "auth.json")),
    keyFile: fs.existsSync(h.keyFile),
    profileFile: readJsonFile(path.join(h.stateDir, "profile.json")),
    opens: h.open.mock.calls.length,
  });
  return status;
};

describe("INTG-PROF-01 pairing picks the profile", () => {
  it("@req INTG-PROF-01[badger-jellyfin] @req ACCT-PAIR-01[badger-jellyfin] an account with two profiles: pairing waits for the pick (no stored session, no library, no sync), then stores it and never asks again", async () => {
    const test = "prof-pair-two";
    const h = harness(test);
    const { api, restore } = installFakeApi();
    cleanups.push(restore);
    const runtime = newRuntime(test, h);
    await runtime.start();
    phase(test, "start pairing");
    await runtime.startPairing({ deviceName: "Jf" });
    await vi.waitFor(() => expect(runtime.status().state).toBe("needs_profile"), { timeout: 5_000 });
    const waiting = snapshot(test, "approved, waiting for pick", runtime, h);
    expect(waiting.pairing?.state).toBe("needs_profile");
    expect(waiting.signedIn).toBe(false);
    expect(waiting.profiles?.map((entry) => entry.id)).toEqual(["main-id", "kid-id"]);
    expect(fs.existsSync(path.join(h.stateDir, "auth.json"))).toBe(false);
    expect(fs.existsSync(h.keyFile)).toBe(false);
    expect(h.open).not.toHaveBeenCalled();
    expect(api.calls).toContain("GET /profiles");

    phase(test, "pick the second profile");
    await runtime.chooseProfile("kid-id");
    const chosen = snapshot(test, "after pick", runtime, h);
    expect(chosen.state).toBe("ok");
    expect(chosen.pairing?.state).toBe("approved");
    expect(chosen.profile).toEqual({ id: "kid-id", name: "Kid", isMain: false });
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    expect(readJsonFile(path.join(h.stateDir, "auth.json"))?.token).toBe("paired-token");
    expect(h.open).toHaveBeenCalledTimes(1);
    await runtime.stop();

    phase(test, "restart: no question again");
    const restarted = newRuntime(test, h);
    await restarted.start();
    const again = snapshot(test, "after restart", restarted, h);
    expect(again.state).toBe("ok");
    expect(again.profile?.id).toBe("kid-id");
    expect(again.pairing).toBeNull();
  });

  it("@req INTG-PROF-01[badger-jellyfin] @req ACCT-PAIR-01[badger-jellyfin] an account with one profile uses it without asking", async () => {
    const test = "prof-pair-one";
    const h = harness(test);
    const { restore } = installFakeApi({ profiles: [MAIN] });
    cleanups.push(restore);
    const runtime = newRuntime(test, h);
    await runtime.start();
    await runtime.startPairing({ deviceName: "Jf" });
    await vi.waitFor(() => expect(runtime.status().state).toBe("ok"), { timeout: 5_000 });
    const status = snapshot(test, "paired", runtime, h);
    expect(status.pairing?.state).toBe("approved");
    expect(status.profile).toEqual({ id: "main-id", name: "Chris", isMain: true });
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "main-id", name: "Chris", prefix: "" });
  });

  it("@req INTG-PROF-01[badger-jellyfin] cancelling while the pick is pending drops the session and signs the token out", async () => {
    const test = "prof-pair-cancel";
    const h = harness(test);
    const { api, restore } = installFakeApi();
    cleanups.push(restore);
    const runtime = newRuntime(test, h);
    await runtime.start();
    await runtime.startPairing({ deviceName: "Jf" });
    await vi.waitFor(() => expect(runtime.status().state).toBe("needs_profile"), { timeout: 5_000 });
    runtime.cancelPairing();
    await vi.waitFor(() => expect(api.logouts).toEqual(["Bearer paired-token"]));
    const status = snapshot(test, "cancelled", runtime, h);
    expect(status.state).toBe("needs_login");
    await expect(runtime.chooseProfile("kid-id")).rejects.toThrow("not_signed_in");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("@req INTG-PROF-01[badger-jellyfin] a session stored before profiles existed, on an account with several, waits for the owner's pick and never follows one silently", async () => {
    const test = "prof-legacy-session";
    const h = harness(test);
    const { api, restore } = installFakeApi();
    cleanups.push(restore);
    seedSession(h);
    const runtime = newRuntime(test, h);
    await runtime.start();
    const status = snapshot(test, "legacy session", runtime, h);
    expect(status.state).toBe("needs_profile");
    expect(status.profileNeeded).toBe("choose");
    expect(status.profile).toBeNull();
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toBeNull();
    expect(h.open).not.toHaveBeenCalled();
    // No hammering: further state-machine steps (the private timer step) send no more profile requests.
    const stepper: { tick(): Promise<void> } = runtime as unknown as { tick(): Promise<void> };
    const listCalls = api.calls.filter((entry) => entry === "GET /profiles").length;
    await stepper.tick();
    await stepper.tick();
    phase(test, "profile requests", { before: listCalls, after: api.calls.filter((entry) => entry === "GET /profiles").length });
    expect(api.calls.filter((entry) => entry === "GET /profiles").length).toBe(listCalls);

    await runtime.chooseProfile("kid-id");
    const picked = snapshot(test, "after pick", runtime, h);
    expect(picked.state).toBe("ok");
    expect(picked.profileNeeded).toBeNull();
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    expect(h.open).toHaveBeenCalledTimes(1);
    await expect(runtime.chooseProfile("nobody")).rejects.toThrow("profile_not_found");
  });

  it("@req INTG-PROF-01[badger-jellyfin] a session stored before profiles existed, on an account with one profile, uses it without asking", async () => {
    const test = "prof-legacy-single";
    const h = harness(test);
    const { restore } = installFakeApi({ profiles: [MAIN] });
    cleanups.push(restore);
    seedSession(h);
    const runtime = newRuntime(test, h);
    await runtime.start();
    const status = snapshot(test, "legacy single", runtime, h);
    expect(status.state).toBe("ok");
    expect(status.profile).toEqual({ id: "main-id", name: "Chris", isMain: true });
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "main-id", name: "Chris", prefix: "" });
    expect(h.open).toHaveBeenCalledTimes(1);
  });
});

describe("INTG-PROF-01 viewing state follows the chosen profile", () => {
  const signedInRuntime = async (test: string, stored: { id: string; name: string; prefix: string }, profiles = [MAIN, KID]) => {
    const h = harness(test);
    const fake = installFakeApi({ profiles });
    cleanups.push(fake.restore);
    seedSession(h, stored);
    const runtime = newRuntime(test, h);
    await runtime.start();
    const status = snapshot(test, "started", runtime, h);
    expect(status.state).toBe("ok");
    return { h, runtime, deps: runtime.buildDeps(), api: fake.api };
  };

  it("@req INTG-PROF-01[badger-jellyfin] a non-main profile reads and writes only its p:<id>: keys, never the main profile's progress", async () => {
    const test = "prof-keys-kid";
    const { h, deps } = await signedInRuntime(test, { id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    // The main profile watched half of movie-1 (row progress 50) and resumed ep-1: the kid has started nothing.
    h.db.settings.set("episode_resume_v1:ep-1", { value: JSON.stringify({ progressPct: 40, updatedAt: "2026-03-01T00:00:00.000Z", positionSeconds: 400 }), updatedAt: "2026-03-01T00:00:00.000Z" });
    h.db.settings.set("track_prefs_v1:movie-1", { value: serializeTrackPrefs({ audioLanguage: "fr", subtitle: null, updatedAt: "2026-03-01T00:00:00.000Z" }), updatedAt: "2026-03-01T00:00:00.000Z" });

    const before = deps.getLibrary();
    phase(test, "library before kid writes", { movie: before.movies[0]?.resume, ep1: before.shows[0]?.seasons[0]?.episodes[0]?.resume, audio: before.movies[0]?.preferredAudioLanguage });
    expect(before.movies[0]?.resume).toBeNull();
    expect(before.shows[0]?.seasons[0]?.episodes[0]?.resume).toBeNull();
    expect(before.movies[0]?.preferredAudioLanguage).toBeNull();
    expect(deps.getTrackPrefs("movie-1").audioLanguage).toBeNull();

    await deps.recordProgress({ mediaId: "movie-1", episodeId: null, write: { kind: "resume", progressPct: 30, positionSeconds: 300, durationSeconds: 1000 } });
    await deps.recordProgress({ mediaId: "show-1", episodeId: "ep-2", write: { kind: "watched", progressPct: 100, positionSeconds: 990, durationSeconds: 1000 } });
    await deps.setTrackPrefs("movie-1", { audioLanguage: "en" });
    phase(test, "setting writes", h.db.settingWrites);
    expect(h.db.setProgressCalls).toEqual([]);
    expect(h.db.setTrackPrefsCalls).toEqual([]);
    const written = Object.fromEntries(h.db.settingWrites.map((entry) => [entry.key, JSON.parse(entry.value)]));
    expect(written["p:kid-id:media_progress_v1:movie-1"]).toMatchObject({ progressPct: 30 });
    expect(written["p:kid-id:episode_resume_v1:ep-2"]).toMatchObject({ progressPct: 100, positionSeconds: 990, durationSeconds: 1000 });
    // Show aggregate over the kid's own episodes only: ep-2 watched of 2 aired = 50 (the main profile's ep-1 does not count).
    expect(written["p:kid-id:media_progress_v1:show-1"]).toMatchObject({ progressPct: 50 });
    expect(written["p:kid-id:track_prefs_v1:movie-1"]).toMatchObject({ audioLanguage: "en" });
    expect(h.db.getSetting("track_prefs_v1:movie-1")?.value).toContain('"fr"');

    const after = deps.getLibrary();
    phase(test, "library after kid writes", { movie: after.movies[0]?.resume, ep2: after.shows[0]?.seasons[0]?.episodes[1]?.resume, audio: after.movies[0]?.preferredAudioLanguage });
    expect(after.movies[0]?.resume).toMatchObject({ progressPct: 30, positionSeconds: 300, watched: false });
    expect(after.shows[0]?.seasons[0]?.episodes[1]?.resume).toMatchObject({ progressPct: 100, watched: true });
    expect(after.shows[0]?.seasons[0]?.episodes[0]?.resume).toBeNull();
    expect(after.movies[0]?.preferredAudioLanguage).toBe("en");
    expect(deps.getTrackPrefs("movie-1").audioLanguage).toBe("en");

    // "" = absent: a blanked key reads as not started.
    h.db.settings.set("p:kid-id:media_progress_v1:movie-1", { value: "", updatedAt: "2026-04-01T00:00:00.000Z" });
    await deps.recordProgress({ mediaId: "show-1", episodeId: "ep-1", write: { kind: "clear", progressPct: 0 } });
    expect(deps.getLibrary().movies[0]?.resume).toBeNull();
    expect(JSON.parse(h.db.getSetting("p:kid-id:episode_resume_v1:ep-1")?.value ?? "{}")).toMatchObject({ progressPct: 0 });
  });

  it("@req INTG-PROF-01[badger-jellyfin] the main profile keeps the library's own storage", async () => {
    const test = "prof-keys-main";
    const { h, deps } = await signedInRuntime(test, { id: "main-id", name: "Chris", prefix: "" });
    expect(deps.getLibrary().movies[0]?.resume).toMatchObject({ progressPct: 50 });
    await deps.recordProgress({ mediaId: "movie-1", episodeId: null, write: { kind: "resume", progressPct: 30, positionSeconds: 300, durationSeconds: 1000 } });
    await deps.setTrackPrefs("movie-1", { audioLanguage: "en" });
    phase(test, "main writes", { setProgress: h.db.setProgressCalls, setTrackPrefs: h.db.setTrackPrefsCalls, settings: h.db.settingWrites });
    expect(h.db.setProgressCalls).toEqual([["movie-1", 30, null, { positionSeconds: 300, durationSeconds: 1000 }]]);
    expect(h.db.setTrackPrefsCalls).toEqual([["movie-1", { audioLanguage: "en" }]]);
    expect(h.db.settingWrites.filter((entry) => entry.key.startsWith("p:"))).toEqual([]);
  });

  it("@req STOR-BW-11[badger-jellyfin] every playback tunnel session (video and subtitle reads) and every traffic poll names the paired profile; export reads do not", async () => {
    const test = "prof-playback-session";
    const { runtime, api } = await signedInRuntime(test, { id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    // The sidecar exposes neither its object reads nor its tunnel client; the test drives both as the HLS server and a held read do.
    type RuntimeInternals = {
      downloadObject(key: string, purpose: "playback" | "export"): Promise<Uint8Array>;
      tunnel: { refreshTraffic(token: string, objectKey?: string, options?: { minIntervalMs?: number }): Promise<unknown> };
    };
    const internals = runtime as unknown as RuntimeInternals;
    await internals.downloadObject("objects/video.bin", "playback").catch(() => undefined);
    await internals.downloadObject("assets/poster.bin", "export").catch(() => undefined);
    const sessions = api.requests.filter((entry) => entry.startsWith("POST /storage/tunnel/session "));
    const bodies = sessions.map((entry) => JSON.parse(entry.slice("POST /storage/tunnel/session ".length)) as Record<string, unknown>);
    const playback = bodies.filter((body) => (body.purpose ?? "playback") === "playback");
    const exports = bodies.filter((body) => body.purpose === "export");
    phase(test, "tunnel session bodies", { playback, exports });
    expect(playback.length).toBeGreaterThan(0);
    for (const body of playback) expect(body.profileId).toBe("kid-id");
    expect(exports.length).toBeGreaterThan(0);
    for (const body of exports) expect(body.profileId).toBeUndefined();

    const report = await internals.tunnel.refreshTraffic("stored-token", "objects/video.bin", { minIntervalMs: 0 });
    const polls = api.requests.filter((entry) => entry.startsWith("GET /storage/traffic"));
    phase(test, "traffic polls", { polls, report });
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) expect(new URLSearchParams(poll.slice(poll.indexOf("?"), poll.indexOf(" ", 4))).get("profileId")).toBe("kid-id");
    expect(report).toMatchObject({ state: "normal" });
  });

  it("@req INTG-PROF-01[badger-jellyfin] changing the profile in the settings keeps the synced media and only swaps the viewing state", async () => {
    const test = "prof-change";
    const { h, runtime, deps } = await signedInRuntime(test, { id: "main-id", name: "Chris", prefix: "" });
    h.db.settings.set("p:kid-id:media_progress_v1:movie-1", { value: JSON.stringify({ progressPct: 80, lastWatchedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" }), updatedAt: "2026-05-01T00:00:00.000Z" });
    const before = deps.getLibrary();
    const seqBefore = deps.currentVersion();
    expect(before.movies[0]?.resume?.progressPct).toBe(50);

    await runtime.chooseProfile("kid-id");
    const after = deps.getLibrary();
    const status = snapshot(test, "after change", runtime, h);
    phase(test, "resume before/after", { before: before.movies[0]?.resume, after: after.movies[0]?.resume, seqBefore, seqAfter: deps.currentVersion() });
    expect(status.profile).toEqual({ id: "kid-id", name: "Kid", isMain: false });
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    expect(after.movies.map((entry) => entry.id)).toEqual(before.movies.map((entry) => entry.id));
    expect(after.shows.map((entry) => entry.id)).toEqual(before.shows.map((entry) => entry.id));
    expect(after.movies[0]?.resume?.progressPct).toBe(80);
    // The change feed moves, so the plugin re-applies resume/watched to the owner's Jellyfin user.
    expect(deps.currentVersion()).toBeGreaterThan(seqBefore);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.db.closed).toBe(false);
  });

  it("@req INTG-PROF-01[badger-jellyfin] the prefix follows isMain from the latest /profiles list", async () => {
    const test = "prof-main-moves";
    // The kid was chosen while the main profile existed; the main one was then deleted elsewhere and the kid became main.
    const { h, runtime, deps } = await signedInRuntime(test, { id: "kid-id", name: "Kid", prefix: "p:kid-id:" }, [{ ...KID, isMain: true }]);
    await vi.waitFor(() => expect(runtime.status().profile?.isMain).toBe(true));
    snapshot(test, "after list refresh", runtime, h);
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "" });
    expect(deps.getLibrary().movies[0]?.resume?.progressPct).toBe(50);
  });

  it("@req INTG-PROF-01[badger-jellyfin] the followed profile deleted elsewhere: never switches, stops viewing writes and syncing, asks on the settings page, resumes after a pick keeping the media", async () => {
    const test = "prof-deleted";
    const { h, runtime, deps, api } = await signedInRuntime(test, { id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    api.profiles = [MAIN]; // the kid's profile was deleted on the phone
    await runtime.syncOnce("test");
    const paused = snapshot(test, "after delete", runtime, h);
    expect(paused.state).toBe("needs_profile");
    expect(paused.profileNeeded).toBe("deleted");
    // Never switched to the oldest remaining profile.
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "p:kid-id:" });

    const progress = { mediaId: "movie-1", episodeId: null, write: { kind: "resume", progressPct: 40, positionSeconds: 400, durationSeconds: 1000 } } as const;
    const writesBefore = { settings: h.db.settingWrites.length, progress: h.db.setProgressCalls.length, tracks: h.db.setTrackPrefsCalls.length };
    await expect(deps.recordProgress(progress)).rejects.toThrow("profile_needed");
    await expect(deps.setTrackPrefs("movie-1", { audioLanguage: "fr" })).rejects.toThrow("profile_needed");
    const writesAfter = { settings: h.db.settingWrites.length, progress: h.db.setProgressCalls.length, tracks: h.db.setTrackPrefsCalls.length };
    phase(test, "viewing writes while paused", { writesBefore, writesAfter });
    expect(writesAfter).toEqual(writesBefore);

    const listCalls = api.calls.filter((entry) => entry === "GET /profiles").length;
    await runtime.syncOnce("test");
    await runtime.syncOnce("test");
    expect(api.calls.filter((entry) => entry === "GET /profiles").length).toBe(listCalls);

    const listed = await runtime.listProfiles();
    expect(listed.required).toBe(true);
    expect(listed.profiles.map((entry) => entry.id)).toEqual(["main-id"]);

    const seqBefore = deps.currentVersion();
    await runtime.chooseProfile("main-id");
    const resumed = snapshot(test, "after pick", runtime, h);
    expect(resumed.state).toBe("ok");
    expect(resumed.profileNeeded).toBeNull();
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "main-id", name: "Chris", prefix: "" });
    expect(deps.currentVersion()).toBeGreaterThan(seqBefore); // the plugin re-applies viewing state
    expect(h.open).toHaveBeenCalledTimes(1); // the media stay: no reopen, no wipe
    expect(h.db.closed).toBe(false);
    await deps.recordProgress(progress);
  });

  it("@req INTG-PROF-01[badger-jellyfin] the api refusing the followed profile on playback (403 profile_not_owned) pauses the same way", async () => {
    const test = "prof-refused";
    const { h, runtime, api } = await signedInRuntime(test, { id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
    api.sessionRefusal = { status: 403, error: "profile_not_owned" };
    // Private: the tunnel read the HLS route runs; same access as the STOR-BW-11 test above.
    const reader: { downloadObject(key: string, purpose: "playback" | "export"): Promise<Uint8Array> } = runtime as unknown as { downloadObject(key: string, purpose: "playback" | "export"): Promise<Uint8Array> };
    const error = await reader.downloadObject("objects/video.bin", "playback").catch((caught: unknown) => caught);
    phase(test, "playback refusal", { error: error instanceof Error ? error.message : String(error), sessions: api.requests.filter((entry) => entry.startsWith("POST /storage/tunnel/session ")).length });
    const status = snapshot(test, "after refusal", runtime, h);
    expect(status.state).toBe("needs_profile");
    expect(status.profileNeeded).toBe("deleted");
    expect(readJsonFile(path.join(h.stateDir, "profile.json"))).toEqual({ id: "kid-id", name: "Kid", prefix: "p:kid-id:" });
  });
});

describe("INTG-PROF-01 sidecar profile routes", () => {
  const status = (overrides: Partial<IntegrationStatus> = {}): IntegrationStatus =>
    ({
      state: "needs_profile", signedIn: false, email: null, userId: null, accessState: "unknown", paidUntil: null, wipeAt: null, libraryVersion: null, mediaCount: 0,
      lastSyncAt: null, lastError: null, apiUrl: API, version: "0", pairing: null, signedOutReason: null, keyRejected: false, profile: null, profiles: [MAIN, KID], ...overrides,
    }) as IntegrationStatus;

  const deps = (overrides: Partial<IntegrationDeps>): IntegrationDeps =>
    ({
      getStatus: () => status(),
      isLibraryReady: () => false,
      isStarting: () => false,
      log: (message: string, meta?: unknown) => console.info(`[prof-routes] ${message} ${JSON.stringify(meta ?? {})}`),
      ...overrides,
    }) as IntegrationDeps;

  it("@req INTG-PROF-01[badger-jellyfin] POST profile picks before the library is open; GET profiles lists the choices", async () => {
    const chooseProfile = vi.fn(async () => status({ state: "ok", profile: { id: "kid-id", name: "Kid", isMain: false } }));
    const listProfiles = vi.fn(async () => ({ profile: null, profiles: [MAIN, KID], required: true }));
    const handlers = deps({ chooseProfile, listProfiles });
    const pick = await handleIntegrationRequest(new Request(`http://127.0.0.1:8790/integration/v1/profile`, { method: "POST", body: JSON.stringify({ profileId: "kid-id" }) }), handlers);
    phase("prof-routes", "pick", { status: pick.status });
    expect(pick.status).toBe(200);
    expect(chooseProfile).toHaveBeenCalledWith("kid-id");
    expect(((await pick.json()) as IntegrationStatus).profile?.id).toBe("kid-id");
    const list = await handleIntegrationRequest(new Request(`http://127.0.0.1:8790/integration/v1/profiles`), handlers);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { profiles: ApiProfile[] }).profiles).toHaveLength(2);
    const missing = await handleIntegrationRequest(new Request(`http://127.0.0.1:8790/integration/v1/profile`, { method: "POST", body: "{}" }), handlers);
    expect(missing.status).toBe(400);
    const unknown = await handleIntegrationRequest(
      new Request(`http://127.0.0.1:8790/integration/v1/profile`, { method: "POST", body: JSON.stringify({ profileId: "x" }) }),
      deps({ chooseProfile: async () => Promise.reject(Object.assign(new Error("profile_not_found"), { status: 404 })) })
    );
    expect(unknown.status).toBe(404);
  });
});
