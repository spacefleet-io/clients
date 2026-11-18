import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageUnitBase } from "@space/shared/format";
import { render, fireEvent, act, waitFor, cleanup } from "./utils/render";
import {
  AccountStorageCard,
  type AccountStorageCardData,
  type RecomputeStrings,
} from "../src/components/account-storage-card";

const makeData = (overrides: Partial<AccountStorageCardData> = {}): AccountStorageCardData => ({
  plan: "tier1",
  storageAddonCount: 0,
  limitBytes: 100 * 1024 * 1024 * 1024,
  usedBytes: Math.round(5.7 * 1024 * 1024 * 1024),
  reservedBytes: 0,
  usageRatio: 0.057,
  warningLevel: "ok",
  apps: [],
  lastReconciledAt: null,
  ...overrides,
});

const makeStrings = (): RecomputeStrings => ({
  buttonLabel: "Recompute",
  buttonRunning: "Checking…",
  lastVerifiedLabel: (relative: string) => `Last verified: ${relative}`,
  reclaimableHint: (bytes: string) => `${bytes} reclaimable`,
  confirmTitle: (count: number, bytes: string) =>
    `Found ${count} orphaned chunks taking ~${bytes}. Reclaim them?`,
  confirmAccept: "Reclaim",
  confirmCancel: "Cancel",
  resultReclaimed: (bytes: string) => `Reclaimed ${bytes}`,
  resultAlreadyInSync: "Already in sync.",
  resultFailed: "Recompute failed. Try again later.",
});

// On assertion failure, dump enough DOM + mock state to diagnose offline
// (tests must self-diagnose; never recommend manual repro). Wrapped in
// try/catch so a dump failure can never mask the real assertion failure.
const dumpStorageCardSnapshot = (
  label: string,
  ctx: {
    container?: HTMLElement;
    mocks?: Record<string, ReturnType<typeof vi.fn>>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [account-storage-card:${label}] snapshot ===`);
    if (ctx.container) {
      const testIds = Array.from(
        ctx.container.querySelectorAll<HTMLElement>("[data-testid]"),
      ).map((el) => ({
        testId: el.getAttribute("data-testid"),
        text: (el.textContent ?? "").trim().slice(0, 120),
      }));
      console.error(`rendered data-testid nodes:\n${JSON.stringify(testIds, null, 2)}`);
    }
    if (ctx.mocks) {
      const mockState = Object.fromEntries(
        Object.entries(ctx.mocks).map(([name, fn]) => [
          name,
          { calls: fn.mock.calls.length, args: fn.mock.calls },
        ]),
      );
      console.error(`mock call state:\n${JSON.stringify(mockState, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// The fixtures are GiB-sized, so the figures below read as Windows Explorer / Dolphin show them (STOR-UNIT-01).
beforeEach(() => {
  setStorageUnitBase(1024);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setStorageUnitBase(1000);
});

describe("AccountStorageCard byte-precision rendering", () => {
  it("renders usedBytes with byte-level precision (5.7 GB / 100.0 GB)", () => {
    console.info("[account-storage-card:byte-precision] render usedBytes=5.7GB limit=100GB");
    const { getByText, container } = render(<AccountStorageCard locale="en" data={makeData()} />);
    try {
      expect(getByText("5.7 GB / 100.0 GB")).toBeTruthy();
    } catch (err) {
      dumpStorageCardSnapshot("byte-precision-5.7GB", {
        container,
        extra: { expectedText: "5.7 GB / 100.0 GB" },
      });
      throw err;
    }
  });

  it("renders 0 B when usedBytes is 0", () => {
    console.info("[account-storage-card:byte-precision] render usedBytes=0 limit=100GB");
    const { getByText, container } = render(
      <AccountStorageCard locale="en" data={makeData({ usedBytes: 0, usageRatio: 0 })} />,
    );
    try {
      expect(getByText("0 B / 100.0 GB")).toBeTruthy();
    } catch (err) {
      dumpStorageCardSnapshot("byte-precision-zero", {
        container,
        extra: { expectedText: "0 B / 100.0 GB" },
      });
      throw err;
    }
  });

  it("renders per-app sizes in bytes", () => {
    const data = makeData({
      apps: [
        { appId: "badger", label: "Badger", usedBytes: Math.round(3.5 * 1024 * 1024 * 1024) },
        { appId: "parrot", label: "Parrot", usedBytes: Math.round(2.2 * 1024 * 1024 * 1024) },
      ],
    });
    console.info(
      `[account-storage-card:byte-precision] render per-app sizes apps=${JSON.stringify(data.apps)}`,
    );
    const { getByText, container } = render(<AccountStorageCard locale="en" data={data} />);
    try {
      expect(getByText("3.5 GB")).toBeTruthy();
      expect(getByText("2.2 GB")).toBeTruthy();
    } catch (err) {
      dumpStorageCardSnapshot("byte-precision-per-app", {
        container,
        extra: { expectedTexts: ["3.5 GB", "2.2 GB"] },
      });
      throw err;
    }
  });

  // @req STOR-UNIT-01[badger-desktop,parrot]
  it("reads the same bytes in 1000-based units on a 1000-based computer (6.1 GB / 107.4 GB)", () => {
    setStorageUnitBase(1000);
    const data = makeData();
    console.info("[STOR-UNIT-CARD-001] render 1000-based", { usedBytes: data.usedBytes, limitBytes: data.limitBytes });
    const { getByText, container } = render(<AccountStorageCard locale="en" data={data} />);
    try {
      expect(getByText("6.1 GB / 107.4 GB")).toBeTruthy();
    } catch (err) {
      dumpStorageCardSnapshot("stor-unit-1000", { container, extra: { expectedText: "6.1 GB / 107.4 GB" } });
      throw err;
    }
  });

  // @req STOR-UNIT-02[badger-desktop,parrot]
  it("writes every figure in the interface language (5,7 Go / 100,0 Go, 800 Mo, 0 o in French)", () => {
    const data = makeData({
      apps: [{ appId: "badger", label: "Badger", usedBytes: 800 * 1024 * 1024 }],
    });
    console.info("[STOR-UNIT-CARD-002] render fr", { usedBytes: data.usedBytes, limitBytes: data.limitBytes });
    const { getByText, container, rerender } = render(<AccountStorageCard locale="fr" data={data} />);
    try {
      expect(getByText("5,7 Go / 100,0 Go")).toBeTruthy();
      expect(getByText("800 Mo")).toBeTruthy();
      expect(container.textContent).not.toContain("GB");
      rerender(<AccountStorageCard locale="fr" data={makeData({ usedBytes: 0, usageRatio: 0 })} />);
      expect(getByText("0 o / 100,0 Go")).toBeTruthy();
      rerender(<AccountStorageCard locale="de" data={data} />);
      expect(getByText("5,7 GB / 100,0 GB")).toBeTruthy();
      expect(getByText("800 MB")).toBeTruthy();
    } catch (err) {
      dumpStorageCardSnapshot("stor-unit-02-fr", { container, extra: { expected: ["5,7 Go / 100,0 Go", "800 Mo", "0 o / 100,0 Go"] } });
      throw err;
    }
  });
});

describe("AccountStorageCard recompute flow", () => {
  it("shows Recompute button only when recompute prop is provided", () => {
    console.info("[account-storage-card:recompute] render without recompute prop");
    const { queryByTestId, rerender, container } = render(<AccountStorageCard locale="en" data={makeData()} />);
    try {
      expect(queryByTestId("account-storage-recompute")).toBeNull();
    } catch (err) {
      dumpStorageCardSnapshot("recompute-button-absent", {
        container,
        extra: { phase: "no-recompute-prop" },
      });
      throw err;
    }

    console.info("[account-storage-card:recompute] rerender with recompute prop");
    rerender(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{
          onDryRun: vi.fn().mockResolvedValue({ orphanedKeys: 0, reclaimedBytes: 0 }),
          onConfirm: vi.fn().mockResolvedValue({ deletedKeys: 0, reclaimedBytes: 0 }),
          strings: makeStrings(),
        }}
      />,
    );
    try {
      expect(queryByTestId("account-storage-recompute")).not.toBeNull();
    } catch (err) {
      dumpStorageCardSnapshot("recompute-button-present", {
        container,
        extra: { phase: "with-recompute-prop" },
      });
      throw err;
    }
  });

  it("renders 'Last verified' line when relativeLastVerified is provided", () => {
    console.info("[account-storage-card:recompute] render with relativeLastVerified=2m ago");
    const { getByTestId, container } = render(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{
          onDryRun: vi.fn(),
          onConfirm: vi.fn(),
          strings: makeStrings(),
          relativeLastVerified: "2m ago",
        }}
      />,
    );
    try {
      expect(getByTestId("account-storage-last-verified").textContent).toContain("2m ago");
    } catch (err) {
      dumpStorageCardSnapshot("last-verified-line", {
        container,
        extra: { expectedSubstring: "2m ago" },
      });
      throw err;
    }
  });

  it("dry-run with 0 orphans short-circuits to 'Already in sync.'", async () => {
    console.info("[account-storage-card:dry-run-zero] setup onDryRun resolving 0 orphans");
    const onDryRun = vi.fn().mockResolvedValue({ orphanedKeys: 0, reclaimedBytes: 0 });
    const onConfirm = vi.fn();
    const onComplete = vi.fn();
    const { getByTestId, queryByTestId, container } = render(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{ onDryRun, onConfirm, onComplete, strings: makeStrings() }}
      />,
    );

    console.info("[account-storage-card:dry-run-zero] clicking recompute button");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute"));
    });

    const startedAt = Date.now();
    await waitFor(() => {
      const text = getByTestId("account-storage-recompute-result").textContent ?? "";
      console.info(
        `[account-storage-card:dry-run-zero] waitFor result text elapsed=${Date.now() - startedAt}ms text=${JSON.stringify(text)}`,
      );
      expect(text).toContain("Already in sync.");
    }).catch((err) => {
      dumpStorageCardSnapshot("dry-run-zero-result-timeout", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
        extra: { elapsedMs: Date.now() - startedAt, expectedSubstring: "Already in sync." },
      });
      throw err;
    });
    try {
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(queryByTestId("account-storage-recompute-confirm")).toBeNull();
    } catch (err) {
      dumpStorageCardSnapshot("dry-run-zero-post-result", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
      });
      throw err;
    }
  });

  it("dry-run with orphans surfaces a confirm dialog and Reclaim runs the real GC", async () => {
    const dryResult = { orphanedKeys: 7, reclaimedBytes: 2 * 1024 * 1024 * 1024 };
    const runResult = { deletedKeys: 7, reclaimedBytes: 2 * 1024 * 1024 * 1024 };
    console.info(
      `[account-storage-card:dry-run-orphans] setup dryResult=${JSON.stringify(dryResult)} runResult=${JSON.stringify(runResult)}`,
    );
    const onDryRun = vi.fn().mockResolvedValue(dryResult);
    const onConfirm = vi.fn().mockResolvedValue(runResult);
    const onComplete = vi.fn();
    const { getByTestId, container } = render(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{ onDryRun, onConfirm, onComplete, strings: makeStrings() }}
      />,
    );

    console.info("[account-storage-card:dry-run-orphans] clicking recompute button");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute"));
    });

    const confirmStartedAt = Date.now();
    await waitFor(() => {
      const present = getByTestId("account-storage-recompute-confirm");
      console.info(
        `[account-storage-card:dry-run-orphans] waitFor confirm dialog elapsed=${Date.now() - confirmStartedAt}ms present=${!!present}`,
      );
      expect(present).toBeTruthy();
    }).catch((err) => {
      dumpStorageCardSnapshot("dry-run-orphans-confirm-timeout", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
        extra: { elapsedMs: Date.now() - confirmStartedAt },
      });
      throw err;
    });
    try {
      expect(getByTestId("account-storage-recompute-confirm").textContent).toContain("7");
      expect(getByTestId("account-storage-recompute-confirm").textContent).toContain("2.0 GB");
      expect(getByTestId("account-storage-reclaimable-hint").textContent).toContain("2.0 GB reclaimable");
    } catch (err) {
      dumpStorageCardSnapshot("dry-run-orphans-confirm-content", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
      });
      throw err;
    }

    console.info("[account-storage-card:dry-run-orphans] clicking accept (Reclaim)");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute-accept"));
    });

    const resultStartedAt = Date.now();
    await waitFor(() => {
      const text = getByTestId("account-storage-recompute-result").textContent ?? "";
      console.info(
        `[account-storage-card:dry-run-orphans] waitFor reclaimed result elapsed=${Date.now() - resultStartedAt}ms text=${JSON.stringify(text)}`,
      );
      expect(text).toContain("Reclaimed 2.0 GB");
    }).catch((err) => {
      dumpStorageCardSnapshot("dry-run-orphans-result-timeout", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
        extra: { elapsedMs: Date.now() - resultStartedAt, expectedSubstring: "Reclaimed 2.0 GB" },
      });
      throw err;
    });
    try {
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpStorageCardSnapshot("dry-run-orphans-post-result", {
        container,
        mocks: { onDryRun, onConfirm, onComplete },
      });
      throw err;
    }
  });

  it("Cancel from confirm dialog resets to idle and never invokes onConfirm", async () => {
    console.info("[account-storage-card:cancel] setup onDryRun resolving 3 orphans");
    const onDryRun = vi
      .fn()
      .mockResolvedValue({ orphanedKeys: 3, reclaimedBytes: 1024 * 1024 * 1024 });
    const onConfirm = vi.fn();
    const { getByTestId, queryByTestId, container } = render(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{ onDryRun, onConfirm, strings: makeStrings() }}
      />,
    );

    console.info("[account-storage-card:cancel] clicking recompute button");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute"));
    });
    const confirmStartedAt = Date.now();
    await waitFor(() => {
      const present = getByTestId("account-storage-recompute-confirm");
      console.info(
        `[account-storage-card:cancel] waitFor confirm dialog elapsed=${Date.now() - confirmStartedAt}ms present=${!!present}`,
      );
      expect(present).toBeTruthy();
    }).catch((err) => {
      dumpStorageCardSnapshot("cancel-confirm-timeout", {
        container,
        mocks: { onDryRun, onConfirm },
        extra: { elapsedMs: Date.now() - confirmStartedAt },
      });
      throw err;
    });

    console.info("[account-storage-card:cancel] clicking cancel");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute-cancel"));
    });

    try {
      expect(queryByTestId("account-storage-recompute-confirm")).toBeNull();
      expect(onConfirm).not.toHaveBeenCalled();
    } catch (err) {
      dumpStorageCardSnapshot("cancel-post-cancel", {
        container,
        mocks: { onDryRun, onConfirm },
      });
      throw err;
    }
  });

  it("dry-run failure surfaces an error message and does not run the real GC", async () => {
    console.info("[account-storage-card:dry-run-failure] setup onDryRun rejecting with network error");
    const onDryRun = vi.fn().mockRejectedValue(new Error("network error"));
    const onConfirm = vi.fn();
    const { getByTestId, container } = render(
      <AccountStorageCard
        locale="en"
        data={makeData()}
        recompute={{ onDryRun, onConfirm, strings: makeStrings() }}
      />,
    );

    console.info("[account-storage-card:dry-run-failure] clicking recompute button");
    await act(async () => {
      fireEvent.click(getByTestId("account-storage-recompute"));
    });

    const startedAt = Date.now();
    await waitFor(() => {
      const text = getByTestId("account-storage-recompute-result").textContent ?? "";
      console.info(
        `[account-storage-card:dry-run-failure] waitFor error result elapsed=${Date.now() - startedAt}ms text=${JSON.stringify(text)}`,
      );
      expect(text).toContain("Recompute failed");
    }).catch((err) => {
      dumpStorageCardSnapshot("dry-run-failure-result-timeout", {
        container,
        mocks: { onDryRun, onConfirm },
        extra: { elapsedMs: Date.now() - startedAt, expectedSubstring: "Recompute failed" },
      });
      throw err;
    });
    try {
      expect(onConfirm).not.toHaveBeenCalled();
    } catch (err) {
      dumpStorageCardSnapshot("dry-run-failure-post-result", {
        container,
        mocks: { onDryRun, onConfirm },
      });
      throw err;
    }
  });
});

// @req ACCT-PLAN-14[badger-desktop]
describe("AccountStorageCard for an unlimited (admin) account (ACCT-PLAN-14)", () => {
  it("[ACCT-PLAN-14-CARD-01] shows the used bytes and the unlimited label, no 'of limit', no bar, no upgrade", () => {
    const onUpgrade = vi.fn();
    // The API answers "ok" for an admin; "blocked" here proves the card ignores the level once the limit is null.
    const data = makeData({ limitBytes: null, usageRatio: 0, warningLevel: "blocked" });
    console.info("[account-storage-card:unlimited] render", JSON.stringify(data));
    const { container, queryByTestId, queryByText } = render(
      <AccountStorageCard locale="en" data={data} onUpgrade={onUpgrade} upgradeLabel="Upgrade" unlimitedLabel="Admin : stockage illimité" />,
    );
    const snapshot = {
      used: queryByTestId("account-storage-used")?.textContent,
      label: queryByTestId("account-storage-unlimited")?.textContent,
      upgrade: queryByText("Upgrade") !== null,
      bars: container.querySelectorAll(".rounded-full.bg-muted").length,
      text: container.textContent,
    };
    console.info("[account-storage-card:unlimited] verdict", JSON.stringify(snapshot));
    try {
      expect(snapshot.used).toBe("5.7 GB used");
      expect(snapshot.label).toBe("Admin : stockage illimité");
      expect(snapshot.upgrade).toBe(false);
      expect(snapshot.bars).toBe(0);
      expect(snapshot.text).not.toContain("% used");
      expect(snapshot.text).not.toContain(" / ");
    } catch (err) {
      dumpStorageCardSnapshot("unlimited", { container, extra: snapshot });
      throw err;
    }
  });

  it("[ACCT-PLAN-14-CARD-02] a limited account over its limit keeps 'used / limit', its bar and the upgrade button", () => {
    const data = makeData({ usedBytes: 100 * 1024 * 1024 * 1024, usageRatio: 1, warningLevel: "blocked" });
    console.info("[account-storage-card:limited-blocked] render", JSON.stringify(data));
    const { container, queryByText, queryByTestId } = render(
      <AccountStorageCard locale="en" data={data} onUpgrade={() => {}} upgradeLabel="Upgrade" />,
    );
    const snapshot = {
      upgrade: queryByText("Upgrade") !== null,
      unlimited: queryByTestId("account-storage-unlimited") !== null,
      bars: container.querySelectorAll(".rounded-full.bg-muted").length,
      text: container.textContent,
    };
    console.info("[account-storage-card:limited-blocked] verdict", JSON.stringify(snapshot));
    try {
      expect(snapshot.text).toContain("100.0 GB / 100.0 GB");
      expect(snapshot.text).toContain("100% used");
      expect(snapshot.upgrade).toBe(true);
      expect(snapshot.unlimited).toBe(false);
      expect(snapshot.bars).toBe(1);
    } catch (err) {
      dumpStorageCardSnapshot("limited-blocked", { container, extra: snapshot });
      throw err;
    }
  });
});
