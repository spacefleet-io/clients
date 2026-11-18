/**
 * Polling primitives that wait for mpv to reach a particular state by
 * repeatedly issuing `get_property` JSON-IPC requests until either the
 * expectation is satisfied or a deadline elapses.
 *
 * Relocated from @space/desktop-mpv-playback (externalMpvController.ts)
 * in Phase 1b. Pure & injectable for unit tests — the `send` and `sleep`
 * callbacks are the only side-effecting dependencies.
 */

import type { MpvCommand } from "./bridge";
import { buildGetPropertyCommand } from "./properties";

export type MpvSendRequest = (cmd: MpvCommand) => Promise<unknown>;
export type MpvPollSleep = (ms: number) => Promise<void>;

const defaultSleep: MpvPollSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll mpv until the expected subtitle/chapter metadata is reflected in
 * track-list / chapter-list, OR until budgetMs elapses. Returns true if the
 * expectations are met within the budget. Pure & injectable for unit tests.
 *
 * If neither expectation is positive, returns true immediately (nothing to
 * wait for).
 */
export const pollMetadataApplied = async (
  expected: { expectedExternalSubtitles?: number; expectedChapters?: number },
  budgetMs: number,
  send: MpvSendRequest,
  sleep: MpvPollSleep = defaultSleep,
  now: () => number = Date.now,
  pollMs = 100,
): Promise<boolean> => {
  const wantSubs = (expected.expectedExternalSubtitles ?? 0) > 0;
  const wantChapters = (expected.expectedChapters ?? 0) > 0;
  if (!wantSubs && !wantChapters) return true;
  const startedAt = now();
  while (now() - startedAt < budgetMs) {
    const [trackRes, chapterRes] = await Promise.all([
      wantSubs ? send(buildGetPropertyCommand("track-list")) : Promise.resolve(null),
      wantChapters ? send(buildGetPropertyCommand("chapter-list")) : Promise.resolve(null),
    ]);
    let subsOk = !wantSubs;
    let chaptersOk = !wantChapters;
    if (wantSubs) {
      const list = Array.isArray((trackRes as { data?: unknown } | null)?.data)
        ? ((trackRes as { data: unknown[] }).data as Array<{ type?: string; external?: boolean }>)
        : [];
      const externalSubs = list.filter(
        (track) => track?.type === "sub" && track?.external === true,
      ).length;
      subsOk = externalSubs >= (expected.expectedExternalSubtitles ?? 0);
    }
    if (wantChapters) {
      const list = Array.isArray((chapterRes as { data?: unknown } | null)?.data)
        ? ((chapterRes as { data: unknown[] }).data as unknown[])
        : [];
      chaptersOk = list.length >= (expected.expectedChapters ?? 0);
    }
    if (subsOk && chaptersOk) return true;
    await sleep(pollMs);
  }
  return false;
};

/**
 * Poll mpv until vo-configured is true (or time-pos has advanced past 0 as a
 * fallback for builds that don't expose vo-configured), or until budgetMs
 * elapses. Pure & injectable for unit tests.
 */
export const pollVoConfigured = async (
  budgetMs: number,
  send: MpvSendRequest,
  sleep: MpvPollSleep = defaultSleep,
  now: () => number = Date.now,
  pollMs = 100,
): Promise<boolean> => {
  const startedAt = now();
  while (now() - startedAt < budgetMs) {
    const [voRes, timeRes] = await Promise.all([
      send(buildGetPropertyCommand("vo-configured")),
      send(buildGetPropertyCommand("time-pos")),
    ]);
    if ((voRes as { data?: unknown } | null)?.data === true) return true;
    const timeData = (timeRes as { data?: unknown } | null)?.data;
    if (typeof timeData === "number" && timeData > 0) return true;
    await sleep(pollMs);
  }
  return false;
};
