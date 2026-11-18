import { useState, type ReactNode } from "react";
import { formatLocalizedStorage, formatLocalizedStorageUsage, storageUsedPercent } from "@space/shared/format";

export type AccountStorageCardData = {
  plan: string;
  storageAddonCount: number;
  /** `null` = unlimited (admin, ACCT-PLAN-14): no "of limit", no bar, no upgrade. */
  limitBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
  usageRatio: number;
  warningLevel: "ok" | "warning" | "blocked";
  apps: Array<{ appId: string; label: string; usedBytes: number }>;
  lastReconciledAt?: string | null;
};

export type RecomputeDryRunResult = {
  orphanedKeys: number;
  reclaimedBytes: number;
};

export type RecomputeRunResult = {
  reclaimedBytes: number;
  deletedKeys: number;
};

export type RecomputeStrings = {
  buttonLabel: string;
  buttonRunning: string;
  lastVerifiedLabel: (relative: string) => string;
  reclaimableHint: (bytes: string) => string;
  confirmTitle: (count: number, bytes: string) => string;
  confirmAccept: string;
  confirmCancel: string;
  resultReclaimed: (bytes: string) => string;
  resultAlreadyInSync: string;
  resultFailed: string;
};

type AccountStorageCardProps = {
  data: AccountStorageCardData;
  /** The interface language ("fr", "en"…): every size is written in it (STOR-UNIT-02). */
  locale: string;
  onUpgrade?: () => void;
  upgradeLabel?: string;
  /** Shown instead of "used / limit" when `limitBytes` is null (ACCT-PLAN-14). */
  unlimitedLabel?: string;
  children?: ReactNode;
  recompute?: {
    onDryRun: () => Promise<RecomputeDryRunResult>;
    onConfirm: () => Promise<RecomputeRunResult>;
    onComplete?: () => void;
    relativeLastVerified?: string | null;
    strings: RecomputeStrings;
  };
};

const barColorClass = (warningLevel: "ok" | "warning" | "blocked"): string => {
  if (warningLevel === "blocked") return "bg-destructive";
  if (warningLevel === "warning") return "bg-amber-500";
  return "bg-primary";
};

const textColorClass = (warningLevel: "ok" | "warning" | "blocked"): string => {
  if (warningLevel === "blocked") return "text-destructive";
  if (warningLevel === "warning") return "text-amber-500";
  return "text-muted-foreground";
};

type RecomputePhase = "idle" | "dry_running" | "awaiting_confirm" | "running" | "done" | "error";

export const AccountStorageCard = ({ data, locale, onUpgrade, upgradeLabel, unlimitedLabel, children, recompute }: AccountStorageCardProps) => {
  const limitBytes = data.limitBytes;
  const unlimited = limitBytes === null;
  // Rounded down: 100% only once the stored bytes reach the limit (STOR-UNIT-01).
  const percentage = limitBytes !== null ? storageUsedPercent(data.usedBytes, limitBytes) : 0;
  const usage = limitBytes === null ? null : formatLocalizedStorageUsage(data.usedBytes, limitBytes, locale);
  const size = (bytes: number) => formatLocalizedStorage(bytes, locale);

  const [phase, setPhase] = useState<RecomputePhase>("idle");
  const [dryRunResult, setDryRunResult] = useState<RecomputeDryRunResult | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const startRecompute = async () => {
    if (!recompute) return;
    setResultMessage(null);
    setPhase("dry_running");
    try {
      const dry = await recompute.onDryRun();
      setDryRunResult(dry);
      if (dry.orphanedKeys === 0) {
        setPhase("done");
        setResultMessage(recompute.strings.resultAlreadyInSync);
        recompute.onComplete?.();
        return;
      }
      setPhase("awaiting_confirm");
    } catch {
      setPhase("error");
      setResultMessage(recompute.strings.resultFailed);
    }
  };

  const cancelConfirm = () => {
    setPhase("idle");
    setDryRunResult(null);
  };

  const confirmRecompute = async () => {
    if (!recompute) return;
    setPhase("running");
    try {
      const run = await recompute.onConfirm();
      setPhase("done");
      setResultMessage(recompute.strings.resultReclaimed(size(run.reclaimedBytes)));
      setDryRunResult(null);
      recompute.onComplete?.();
    } catch {
      setPhase("error");
      setResultMessage(recompute.strings.resultFailed);
    }
  };

  const reclaimableHint =
    recompute && dryRunResult && dryRunResult.orphanedKeys > 0 && phase !== "running"
      ? recompute.strings.reclaimableHint(size(dryRunResult.reclaimedBytes))
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          {limitBytes === null ? (
            <>
              <div className="text-sm font-semibold" data-testid="account-storage-used">
                {size(data.usedBytes)} used
              </div>
              <div className="text-xs text-muted-foreground" data-testid="account-storage-unlimited">
                {unlimitedLabel ?? "Admin: unlimited storage"}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold">
                {usage?.used} / {usage?.limit}
              </div>
              <div className={["text-xs", textColorClass(data.warningLevel)].join(" ")}>
                {percentage}% used
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {recompute ? (
            <button
              type="button"
              onClick={() => void startRecompute()}
              disabled={phase === "dry_running" || phase === "running" || phase === "awaiting_confirm"}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
              data-testid="account-storage-recompute"
            >
              {phase === "dry_running" || phase === "running"
                ? recompute.strings.buttonRunning
                : recompute.strings.buttonLabel}
            </button>
          ) : null}
          {!unlimited && data.warningLevel !== "ok" && onUpgrade && (
            <button
              type="button"
              onClick={onUpgrade}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              {upgradeLabel ?? "Upgrade Plan"}
            </button>
          )}
        </div>
      </div>

      {unlimited ? null : (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={["h-full transition-all", barColorClass(data.warningLevel)].join(" ")}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}

      {data.reservedBytes > 0 && (
        <div className="text-xs text-muted-foreground">
          {size(data.reservedBytes)} reserved by active uploads
        </div>
      )}

      {recompute && recompute.relativeLastVerified ? (
        <div className="text-xs text-muted-foreground" data-testid="account-storage-last-verified">
          {recompute.strings.lastVerifiedLabel(recompute.relativeLastVerified)}
        </div>
      ) : null}

      {reclaimableHint ? (
        <div
          className="inline-flex rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-500"
          data-testid="account-storage-reclaimable-hint"
        >
          {reclaimableHint}
        </div>
      ) : null}

      {recompute && phase === "awaiting_confirm" && dryRunResult ? (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="account-storage-recompute-confirm">
          <div className="mb-2 text-foreground">
            {recompute.strings.confirmTitle(dryRunResult.orphanedKeys, size(dryRunResult.reclaimedBytes))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void confirmRecompute()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
              data-testid="account-storage-recompute-accept"
            >
              {recompute.strings.confirmAccept}
            </button>
            <button
              type="button"
              onClick={cancelConfirm}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
              data-testid="account-storage-recompute-cancel"
            >
              {recompute.strings.confirmCancel}
            </button>
          </div>
        </div>
      ) : null}

      {resultMessage && (phase === "done" || phase === "error") ? (
        <div
          className={["text-xs", phase === "error" ? "text-destructive" : "text-muted-foreground"].join(" ")}
          data-testid="account-storage-recompute-result"
        >
          {resultMessage}
        </div>
      ) : null}

      {data.apps.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
            Storage by app
          </div>
          {data.apps.map((app) => {
            const appPercentage =
              data.usedBytes > 0 ? Math.round((app.usedBytes / data.usedBytes) * 100) : 0;
            return (
              <div key={app.appId} className="flex items-center gap-3">
                <span className="w-16 text-xs text-muted-foreground">{app.label}</span>
                <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary/60 transition-all"
                    style={{ width: `${appPercentage}%` }}
                  />
                </div>
                <span className="w-20 text-right text-xs text-foreground">
                  {size(app.usedBytes)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {children}
    </div>
  );
};
