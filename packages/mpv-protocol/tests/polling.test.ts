import { describe, expect, it } from "vitest";

import { pollMetadataApplied, pollVoConfigured } from "../src/polling";

const makeClock = () => {
  let t = 0;
  return {
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
};

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real assertion failure that triggered it.
const dumpPollSnapshot = (
  label: string,
  ctx: {
    expectations?: unknown;
    budgetMs?: number;
    sends?: number;
    elapsedMs?: number;
    actual?: unknown;
    expected?: unknown;
  },
) => {
  try {
    console.error(`=== [mpv-protocol-polling:${label}] snapshot ===`);
    console.error(`expectations=${JSON.stringify(ctx.expectations)}`);
    console.error(`budgetMs=${JSON.stringify(ctx.budgetMs)}`);
    console.error(`send-calls=${JSON.stringify(ctx.sends)} elapsedMs=${JSON.stringify(ctx.elapsedMs)}`);
    console.error(`actual=${JSON.stringify(ctx.actual)} expected=${JSON.stringify(ctx.expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("pollMetadataApplied", () => {
  it("returns true immediately when no expectations", async () => {
    console.info(`[mpv-protocol-polling:no-expectations] polling with empty expectation set`);
    const send = async () => null;
    const { sleep, now } = makeClock();
    const ok = await pollMetadataApplied({}, 5000, send, sleep, now);
    console.info(`[mpv-protocol-polling:no-expectations] result=${ok} elapsedMs=${now()}`);
    if (ok !== true) {
      dumpPollSnapshot("no-expectations", {
        expectations: {},
        budgetMs: 5000,
        elapsedMs: now(),
        actual: ok,
        expected: true,
      });
    }
    expect(ok).toBe(true);
  });

  it("resolves true once subtitles match expected external count", async () => {
    console.info(`[mpv-protocol-polling:subs-match] expecting 2 external subtitles, matching on 3rd track-list poll`);
    let call = 0;
    const send = async (cmd: unknown) => {
      const [_, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "track-list") {
        call += 1;
        console.info(`[mpv-protocol-polling:subs-match] track-list poll #${call}`);
        if (call < 3) {
          return { data: [{ type: "sub", external: false }] };
        }
        return {
          data: [
            { type: "sub", external: true },
            { type: "sub", external: true },
          ],
        };
      }
      return null;
    };
    const { sleep, now } = makeClock();
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 2 },
      5000,
      send,
      sleep,
      now,
    );
    console.info(`[mpv-protocol-polling:subs-match] result=${ok} track-list-polls=${call} elapsedMs=${now()}`);
    if (ok !== true) {
      dumpPollSnapshot("subs-match", {
        expectations: { expectedExternalSubtitles: 2 },
        budgetMs: 5000,
        sends: call,
        elapsedMs: now(),
        actual: ok,
        expected: true,
      });
    }
    expect(ok).toBe(true);
  });

  it("resolves false when expectation never met", async () => {
    console.info(`[mpv-protocol-polling:subs-never] expecting 1 external subtitle, send always returns empty track-list`);
    const send = async () => ({ data: [] });
    const { sleep, now } = makeClock();
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 1 },
      500,
      send,
      sleep,
      now,
    );
    console.info(`[mpv-protocol-polling:subs-never] result=${ok} (expected false) elapsedMs=${now()} budgetMs=500`);
    if (ok !== false) {
      dumpPollSnapshot("subs-never", {
        expectations: { expectedExternalSubtitles: 1 },
        budgetMs: 500,
        elapsedMs: now(),
        actual: ok,
        expected: false,
      });
    }
    expect(ok).toBe(false);
  });

  it("requires BOTH subs and chapters when both expected", async () => {
    console.info(`[mpv-protocol-polling:subs-and-chapters] subs satisfied but chapters always empty → must resolve false`);
    const send = async (cmd: unknown) => {
      const [_, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "track-list") {
        return { data: [{ type: "sub", external: true }] };
      }
      if (prop === "chapter-list") {
        return { data: [] };
      }
      return null;
    };
    const { sleep, now } = makeClock();
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 1, expectedChapters: 1 },
      500,
      send,
      sleep,
      now,
    );
    console.info(`[mpv-protocol-polling:subs-and-chapters] result=${ok} (expected false) elapsedMs=${now()} budgetMs=500`);
    if (ok !== false) {
      dumpPollSnapshot("subs-and-chapters", {
        expectations: { expectedExternalSubtitles: 1, expectedChapters: 1 },
        budgetMs: 500,
        elapsedMs: now(),
        actual: ok,
        expected: false,
      });
    }
    expect(ok).toBe(false);
  });
});

describe("pollVoConfigured", () => {
  it("resolves true when vo-configured is true", async () => {
    console.info(`[mpv-protocol-polling:vo-true] vo-configured returns true on first poll`);
    const send = async (cmd: unknown) => {
      const [_, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "vo-configured") return { data: true };
      return { data: 0 };
    };
    const { sleep, now } = makeClock();
    const ok = await pollVoConfigured(5000, send, sleep, now);
    console.info(`[mpv-protocol-polling:vo-true] result=${ok} elapsedMs=${now()}`);
    if (ok !== true) {
      dumpPollSnapshot("vo-true", { budgetMs: 5000, elapsedMs: now(), actual: ok, expected: true });
    }
    expect(ok).toBe(true);
  });

  it("falls back to time-pos > 0", async () => {
    console.info(`[mpv-protocol-polling:vo-fallback] vo-configured false → fall back to time-pos=1.25`);
    const send = async (cmd: unknown) => {
      const [_, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "vo-configured") return { data: false };
      if (prop === "time-pos") return { data: 1.25 };
      return null;
    };
    const { sleep, now } = makeClock();
    const ok = await pollVoConfigured(5000, send, sleep, now);
    console.info(`[mpv-protocol-polling:vo-fallback] result=${ok} elapsedMs=${now()}`);
    if (ok !== true) {
      dumpPollSnapshot("vo-fallback", { budgetMs: 5000, elapsedMs: now(), actual: ok, expected: true });
    }
    expect(ok).toBe(true);
  });

  it("returns false when neither signal progresses within budget", async () => {
    console.info(`[mpv-protocol-polling:vo-never] neither vo-configured nor time-pos progresses, budgetMs=300`);
    const send = async () => ({ data: 0 });
    const { sleep, now } = makeClock();
    const ok = await pollVoConfigured(300, send, sleep, now);
    console.info(`[mpv-protocol-polling:vo-never] result=${ok} (expected false) elapsedMs=${now()} budgetMs=300`);
    if (ok !== false) {
      dumpPollSnapshot("vo-never", { budgetMs: 300, elapsedMs: now(), actual: ok, expected: false });
    }
    expect(ok).toBe(false);
  });
});
