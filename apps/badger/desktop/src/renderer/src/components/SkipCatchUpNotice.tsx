/**
 * MPV-PREV-08: the one-time "Badger now finds intros and credits" notice. Shown once per computer and user, the first
 * time this version opens while the skip-detection catch-up (MPV-PREV-03) still has videos to process here; never when
 * it has none. "Seen" is stored when the user closes it (either button), so a crash before that shows it again.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SkipForward } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { useAuth } from "@/auth";
import { OPEN_JOBS_EVENT, useSkipCatchUpStatus, type SkipCatchUpStatus } from "@/lib/skipCatchUp";

/** The release that brought skip detection to the existing library. */
export const SKIP_CATCH_UP_NOTICE_VERSION = "0.1.58";
const SEEN_KEY = "sf_skip_catch_up_notice_seen";

export const skipCatchUpNoticeSeenKey = (userId: string) => `${SEEN_KEY}:${userId}`;

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
  if (!userId || seen === userId || isSeen(userId) || !window.sf?.skipCatchUp) return null;
  return <SkipCatchUpNoticeDialog userId={userId} onSeen={() => setSeen(userId)} />;
}

function SkipCatchUpNoticeDialog({ userId, onSeen }: { userId: string; onSeen: () => void }) {
  const { t } = useTranslation();
  const status = useSkipCatchUpStatus();
  // Decided on the first answer only: a catch-up that finishes while the notice is open does not pull it away.
  const [shown, setShown] = useState<boolean | null>(null);
  if (shown === null && status !== null) setShown(skipCatchUpHasWork(status));
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
