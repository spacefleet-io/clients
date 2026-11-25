/**
 * MPV-PREV-08: the one-time "Badger now finds intros and credits" notice. Shown once per computer and user, the first
 * time this version opens while the skip-detection catch-up (MPV-PREV-03) still has videos to process here; never when
 * it has none. "Seen" is stored when the user closes it (either button), so a crash before that shows it again.
 *
 * Decided once per app run and user, on the first catch-up answer after sign-in. `TopNav` (which mounts it) is part of
 * each page, so a decision per mount was made again at every page change, and a video imported during the run counted
 * as catch-up work until its import-time previews were recorded (badger 0.1.67 release smoke, run 50348: the notice
 * opened over a fresh account's media page right after its first import).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SkipForward } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { useAuth } from "@/auth";
import { OPEN_JOBS_EVENT, useSkipCatchUpStatus, type SkipCatchUpStatus } from "@/lib/skipCatchUp";

/** The release that brought skip detection to the existing library (PR #4014 first shipped in badger-desktop 0.1.66). */
export const SKIP_CATCH_UP_NOTICE_VERSION = "0.1.66";
const SEEN_KEY = "sf_skip_catch_up_notice_seen";

export const skipCatchUpNoticeSeenKey = (userId: string) => `${SEEN_KEY}:${userId}`;

/** This app run's decision per user: true = show until closed, false = not this run. Lives as long as the renderer. */
const decisions = new Map<string, boolean>();

/** Forgets this run's decisions, as a restart of the app does (tests). */
export const forgetSkipCatchUpNoticeDecisions = () => decisions.clear();

const isSeen = (userId: string): boolean => {
  try {
    return window.localStorage.getItem(skipCatchUpNoticeSeenKey(userId)) !== null;
  } catch {
    return false;
  }
};

/** The catch-up has videos left to process on this computer. */
export const skipCatchUpHasWork = (status: SkipCatchUpStatus | null): boolean =>
  status !== null && status.state !== "done" && status.handled < status.total;

export function SkipCatchUpNotice() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [seen, setSeen] = useState<string | null>(null);
  if (!userId || seen === userId || decisions.get(userId) === false || isSeen(userId) || !window.sf?.skipCatchUp) return null;
  return (
    <SkipCatchUpNoticeDialog
      userId={userId}
      onSeen={() => {
        decisions.set(userId, false);
        setSeen(userId);
      }}
    />
  );
}

function SkipCatchUpNoticeDialog({ userId, onSeen }: { userId: string; onSeen: () => void }) {
  const { t } = useTranslation();
  const status = useSkipCatchUpStatus();
  // Decided on the first answer of the run only: a catch-up that finishes while the notice is open does not pull it
  // away, and work that appears later in the run (an import's own previews) does not bring it.
  const [shown, setShown] = useState<boolean | null>(() => decisions.get(userId) ?? null);
  if (shown === null && status !== null) {
    const decided = skipCatchUpHasWork(status);
    decisions.set(userId, decided);
    setShown(decided);
  }
  if (!shown) return null;

  const close = (openJobs: boolean) => {
    try {
      window.localStorage.setItem(skipCatchUpNoticeSeenKey(userId), SKIP_CATCH_UP_NOTICE_VERSION);
    } catch {
      // Without storage it shows again at the next start, which is the safe side.
    }
    onSeen();
    if (openJobs) window.dispatchEvent(new CustomEvent(OPEN_JOBS_EVENT));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close(false))}>
      <DialogContent className="max-w-md" data-testid="skip-catch-up-notice">
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
            <SkipForward className="h-5 w-5" aria-hidden />
          </div>
          <DialogTitle>{t("skipCatchUpNotice.title")}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {t("skipCatchUpNotice.what", {
                  version: SKIP_CATCH_UP_NOTICE_VERSION,
                })}
              </p>
              <p>{t("skipCatchUpNotice.background")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => close(false)}
            data-testid="skip-catch-up-notice-close"
          >
            {t("skipCatchUpNotice.close")}
          </Button>
          <Button type="button" onClick={() => close(true)} data-testid="skip-catch-up-notice-open-jobs">
            {t("skipCatchUpNotice.openJobs")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
