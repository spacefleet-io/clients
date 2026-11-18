/**
 * In-process mock release feed for the electron-updater E2E lifecycle test.
 *
 * Serves the three endpoints the desktop updater hits:
 *
 *   GET /desktop/<app>/latest-linux.yml   electron-updater feed YAML
 *   GET /desktop/<app>/release-status      mandatory-update probe JSON; for
 *                                          `platform=macos&arch=` also the
 *                                          `download` the API adds (REL-MAC-02)
 *   GET /desktop/<app>/<AppImage filename> fake AppImage (random bytes)
 *
 * The feed YAML declares both the version *and* the SHA-512 of the AppImage
 * payload; electron-updater hash-verifies the downloaded file against this
 * value, so we generate the random AppImage bytes first and bake the matching
 * digest into the feed.
 *
 * Why an in-process server instead of `nock` or fixtures on disk?
 *   - `electron-updater` runs in the Electron main process, not the test
 *     process — request interception in the test runner cannot reach it.
 *   - A real HTTP server matches what production hits.
 *
 * `slowDownloadMs` paces the AppImage response in N equal chunks so the
 * `download-progress` event fires multiple times, allowing the test to assert
 * a non-trivial progress curve rather than a single 100% event.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export type MockReleaseFeedOptions = {
  /** App slug used in the URL. */
  appSlug: "badger";
  /** Version string the feed advertises (must be > the current app version). */
  newVersion: string;
  /** AppImage filename advertised in the feed. */
  appImageFilename?: string;
  /** Size of the fake AppImage payload in bytes. Default 256 KiB. */
  appImageSize?: number;
  /** Release notes string written into the feed YAML. */
  releaseNotes?: string;
  /**
   * If set, paces the AppImage response into ~8 equal chunks separated by this
   * delay (ms). 0 / undefined = stream as fast as possible.
   */
  slowDownloadMs?: number;
  /**
   * `minClientVersion` reported by /release-status. When this is GREATER than
   * the current app version, the API computes `mandatory: true` and the
   * desktop renders the blocking-update modal. Default: returns
   * `mandatory: false`.
   */
  minClientVersion?: string;
};

export type MockReleaseFeed = {
  /** Base URL of the mock feed — pass this in as SF_API_BASE_URL. */
  baseUrl: string;
  /** SHA-512 (base64) of the AppImage payload — feed YAML matches. */
  appImageSha512Base64: string;
  /** Size in bytes of the AppImage payload. */
  appImageSize: number;
  /** Hit counters for endpoint-level assertions. */
  hits: {
    latestYaml: number;
    releaseStatus: number;
    appImage: number;
  };
  /** Stop the server and free the port. */
  close(): Promise<void>;
};

/**
 * Build a SHA-512 digest in base64 — the format electron-updater expects in
 * the feed YAML and verifies after download.
 */
const sha512Base64 = (buffer: Buffer): string =>
  createHash("sha512").update(buffer).digest("base64");

/**
 * Render the electron-updater "generic" provider feed YAML. The format is the
 * one electron-builder produces — keep this minimal but complete enough for
 * the provider to parse: `version`, `files[]` (url + sha512 + size), `path`,
 * `sha512`, `releaseDate`. We omit `blockMapSize` because the test forces
 * `disableDifferentialDownload = true` so the blockmap is never fetched.
 */
const renderFeedYaml = (
  version: string,
  filename: string,
  sha512: string,
  size: number,
  releaseNotes: string,
): string => {
  const releaseDate = new Date().toISOString();
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    `releaseNotes: |`,
    ...releaseNotes.split("\n").map((line) => `  ${line}`),
    "",
  ].join("\n");
};

/**
 * Numeric semver-ish compare matching the API's logic — enough to drive the
 * `mandatory` decision in /release-status. Returns -1 | 0 | 1.
 */
const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const seg = (v: string) =>
    v.split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const av = seg(a);
  const bv = seg(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

export const startMockReleaseFeed = async (
  options: MockReleaseFeedOptions,
): Promise<MockReleaseFeed> => {
  const appSlug = options.appSlug;
  const newVersion = options.newVersion;
  const filename = options.appImageFilename ?? `Badger-${newVersion}.AppImage`;
  const size = options.appImageSize ?? 256 * 1024;
  const releaseNotes = options.releaseNotes ?? `Release ${newVersion}`;
  const slowDownloadMs = options.slowDownloadMs ?? 0;
  const minClientVersion = options.minClientVersion ?? "0.0.0";

  // Generate the AppImage payload first so the feed YAML can declare its
  // SHA-512. electron-updater verifies the digest after download — a mismatch
  // raises and surfaces as an `error` event, not `update-downloaded`.
  const appImageBytes = randomBytes(size);
  const sha512 = sha512Base64(appImageBytes);
  const feedYaml = renderFeedYaml(newVersion, filename, sha512, size, releaseNotes);

  const hits = { latestYaml: 0, releaseStatus: 0, appImage: 0 };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // The desktop updater's setFeedURL builds `${apiBaseUrl}/desktop/${appSlug}`
    // and electron-updater appends `/latest-linux.yml` etc., so we match the
    // production path layout exactly.
    if (path === `/desktop/${appSlug}/latest-linux.yml`) {
      hits.latestYaml += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/yaml; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.end(feedYaml);
      return;
    }

    if (path === `/desktop/${appSlug}/release-status`) {
      hits.releaseStatus += 1;
      const currentVersion = (url.searchParams.get("currentVersion") ?? "").trim();
      const mandatory =
        currentVersion.length > 0 && compareVersions(currentVersion, minClientVersion) < 0;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      // The API answers macOS (download delivery, REL-MAC-02) with the newest
      // `<Name>-<version>-<arch>.dmg` as `download`; mirror that wire shape.
      const arch = url.searchParams.get("arch");
      const download =
        url.searchParams.get("platform") === "macos" && arch
          ? { download: { file: `Badger-${newVersion}-${arch}.dmg`, url: `/desktop/${appSlug}/Badger-${newVersion}-${arch}.dmg`, size } }
          : {};
      res.end(
        JSON.stringify({
          latestVersion: newVersion,
          minClientVersion,
          mandatory,
          releaseNotes,
          ...download,
        }),
      );
      return;
    }

    if (path === `/desktop/${appSlug}/${filename}`) {
      hits.appImage += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", String(appImageBytes.length));
      res.setHeader("cache-control", "public, max-age=3600");
      // Honor Range requests: electron-updater may resume a partial download
      // by sending `Range: bytes=N-`. Without 206 support the underlying
      // executor errors with "unexpected status code".
      const rangeHeader = req.headers["range"];
      if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
        const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
        if (match) {
          const start = Number.parseInt(match[1], 10);
          const end = match[2] ? Number.parseInt(match[2], 10) : appImageBytes.length - 1;
          if (start >= 0 && start < appImageBytes.length && end >= start) {
            res.statusCode = 206;
            res.setHeader("content-length", String(end - start + 1));
            res.setHeader(
              "content-range",
              `bytes ${start}-${end}/${appImageBytes.length}`,
            );
            await streamChunked(res, appImageBytes.subarray(start, end + 1), slowDownloadMs);
            return;
          }
        }
      }
      await streamChunked(res, appImageBytes, slowDownloadMs);
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not_found", path }));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // The connection may have already been written to; only catch & log.
      try {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "internal", message: String(err) }));
        }
      } catch {
        // best-effort
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    appImageSha512Base64: sha512,
    appImageSize: size,
    hits,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * Stream `buffer` to `res` in ~8 equal chunks separated by `delayMs`. With
 * `delayMs === 0` writes everything synchronously in one shot. The 8-chunk
 * cadence is enough to produce a multi-event download-progress curve without
 * making the test take forever.
 */
const streamChunked = async (
  res: ServerResponse,
  buffer: Buffer,
  delayMs: number,
): Promise<void> => {
  if (delayMs <= 0) {
    res.end(buffer);
    return;
  }
  const chunkCount = 8;
  const chunkSize = Math.max(1, Math.ceil(buffer.length / chunkCount));
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    if (res.writableEnded) return;
    const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
    res.write(slice);
    if (offset + chunkSize < buffer.length) {
      await sleep(delayMs);
    }
  }
  res.end();
};
