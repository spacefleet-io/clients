import { useState } from "react";
import { Copy } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@space/ui";
import { LibraryKeyWordsGrid } from "@space/ui/library-key-words";
import { formatStorageBytes } from "@space/shared/format";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { keyChangeCountText, keyChangeEtaText, keyChangeText, type KeyChangeCountedKey } from "@space/shared/keyChangeText";

/** Where a key change stands (`createKeyChange` in `@space/media-reseal`). */
export type KeyChangeDialogPhase = "form" | "resealing" | "ready" | "waiting";

export type KeyChangeDialogProgress = {
  totalFiles: number;
  doneFiles: number;
  keptFiles: number;
  transferBytes: number;
  transferredBytes: number;
};

export type KeyChangeDialogFile = { key: string; sizeBytes: number };

/** The media half of the key change as the dialog shows it, and what its buttons do. */
export type KeyChangeDialogView = {
  phase: KeyChangeDialogPhase;
  progress: KeyChangeDialogProgress | null;
  etaSeconds: number | null;
  uploadsInFlight: number;
  /** The other device has been uploading for 24 hours, so "Switch now" is offered (ACCT-KEYCHG-06). */
  canSwitchNow: boolean;
  switchNow: () => void | Promise<void>;
  stopConfirmOpen: boolean;
  setStopConfirmOpen: (open: boolean) => void;
  stop: () => void | Promise<void>;
  unreadableOpen: boolean;
  setUnreadableOpen: (open: boolean) => void;
  unreadableFiles: KeyChangeDialogFile[] | null;
  unreadableBusy: boolean;
  showUnreadableFiles: () => void | Promise<void>;
  deleteUnreadableFiles: () => void | Promise<void>;
};

export type KeyChangeDialogProps = {
  /** The app's language; the text is shared by Badger and Parrot (`@space/shared/keyChangeText`). */
  language: ClientUiLanguage;
  /** The app's name ("Keep Badger open"). */
  app: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new key's words, shown to be written down before anything changes. */
  words: string[] | null;
  onCopyWords: () => void;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /** ACCT-AUTH-04: an account without a password confirms with a code alone. */
  hasPassword: boolean;
  password: string;
  onPasswordChange: (password: string) => void;
  needsCode: boolean;
  code: string;
  onCodeChange: (code: string) => void;
  method: "email" | "totp" | null;
  notice: string | null;
  error: string | null;
  busy: boolean;
  onSubmit: () => void | Promise<void>;
  view: KeyChangeDialogView;
};

/**
 * Replace the media library key (ACCT-KEYCHG-01): the new key's words, the confirm, the password and code, then the
 * media re-seal (STOR-RESEAL-01) with progress and a time estimate counting download and upload (ACCT-KEYCHG-09), the
 * files the old key could not open with "See the N files" and a delete (ACCT-KEYCHG-07), the wait on another device
 * with "Switch now" after 24 hours (ACCT-KEYCHG-06), and Stop under "More options", confirmed with Keep going / Stop
 * (ACCT-KEYCHG-08). One dialog for Badger desktop and Parrot desktop (REL-FAM-02).
 */
export function KeyChangeDialog({
  language,
  app,
  open,
  onOpenChange,
  words,
  onCopyWords,
  confirmed,
  onConfirmedChange,
  hasPassword,
  password,
  onPasswordChange,
  needsCode,
  code,
  onCodeChange,
  method,
  notice,
  error,
  busy,
  onSubmit,
  view,
}: KeyChangeDialogProps) {
  const t = keyChangeText(language);
  const onForm = view.phase === "form";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2 text-sm">
          {onForm ? null : <KeyChangeResealPanel language={language} app={app} view={view} />}
          <div className={onForm ? "space-y-2" : "hidden"}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">{t("keyLabel")}</div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={onCopyWords}
                disabled={!words}
                aria-label={t("copyButton")}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            {words ? <LibraryKeyWordsGrid words={words} className="rounded-md border border-border p-3" /> : null}
            <div className="text-xs text-muted-foreground">{t("keyHint")}</div>
            <div className="text-xs text-muted-foreground">{t("resealHint", { app })}</div>
          </div>
          {onForm ? (
            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3">
              <Checkbox checked={confirmed} onCheckedChange={(checked) => onConfirmedChange(Boolean(checked))} />
              <span>{t("confirmLabel")}</span>
            </label>
          ) : null}

          <div className="grid gap-3">
            {onForm ? (
              hasPassword ? (
                <div className="grid gap-2">
                  <Label htmlFor="keyChangePassword">{t("passwordLabel")}</Label>
                  <Input
                    id="keyChangePassword"
                    type="password"
                    value={password}
                    onChange={(event) => onPasswordChange(event.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="keyChangePassword-no-password">
                  {t("noPasswordHint")}
                </p>
              )
            ) : null}
            {needsCode ? (
              <div className="grid gap-2">
                <Label htmlFor="keyChangeCode">{t("codeLabel")}</Label>
                <Input
                  id="keyChangeCode"
                  value={code}
                  onChange={(event) => onCodeChange(event.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
                <div className="text-xs text-muted-foreground">
                  {method === "totp" ? t("codeHintTotp") : t("codeHintEmail")}
                </div>
              </div>
            ) : null}
          </div>

          {notice ? (
            <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">{notice}</div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          {onForm ? (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
          ) : null}
          {onForm || view.phase === "ready" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void onSubmit()}
              disabled={!confirmed || (hasPassword && !password.trim()) || busy}
            >
              {busy ? t("working") : view.phase === "ready" ? t("reseal.finish") : t("submit")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The key change while media is re-sealed and switched; see `KeyChangeDialog`. */
export function KeyChangeResealPanel({
  language,
  app,
  view,
}: {
  language: ClientUiLanguage;
  app: string;
  view: KeyChangeDialogView;
}) {
  const t = keyChangeText(language);
  const counted = (key: KeyChangeCountedKey, count: number) => keyChangeCountText(language, key, count);
  const [moreOpen, setMoreOpen] = useState(false);
  const progress = view.progress;
  const percent =
    progress && progress.transferBytes > 0
      ? Math.min(100, Math.floor((progress.transferredBytes / progress.transferBytes) * 100))
      : progress && progress.totalFiles > 0
        ? Math.floor((progress.doneFiles / progress.totalFiles) * 100)
        : 0;
  const kept = progress?.keptFiles ?? 0;

  return (
    <div className="space-y-3" data-testid="key-change-reseal">
      {view.phase === "waiting" ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="font-semibold">{t("reseal.waitingTitle")}</div>
          <div className="text-muted-foreground">{counted("reseal.waitingBody", view.uploadsInFlight)}</div>
          {view.canSwitchNow ? (
            <div className="space-y-2">
              <div className="text-muted-foreground">{t("reseal.switchNowBody")}</div>
              <Button type="button" variant="secondary" onClick={() => void view.switchNow()}>
                {t("reseal.switchNow")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="font-semibold">
            {view.phase === "resealing" ? t("reseal.title") : t("reseal.readyTitle")}
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("reseal.title")}
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          {progress ? (
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {t("reseal.files", { done: progress.doneFiles, total: progress.totalFiles })}
                {" · "}
                {formatStorageBytes(progress.transferredBytes)} / {formatStorageBytes(progress.transferBytes)}
              </span>
              {view.phase === "resealing" ? <span>{keyChangeEtaText(language, view.etaSeconds)}</span> : null}
            </div>
          ) : null}
          {view.phase === "resealing" ? (
            <div className="text-xs text-muted-foreground">{t("reseal.keepOpen", { app })}</div>
          ) : null}
        </div>
      )}

      {kept > 0 ? (
        <div className="rounded-md border border-border p-3">
          <span>{counted("reseal.unreadable", kept)} </span>
          <button type="button" className="text-primary underline" onClick={() => void view.showUnreadableFiles()}>
            {counted("reseal.seeFiles", kept)}
          </button>
        </div>
      ) : null}

      <div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((wasOpen) => !wasOpen)}
        >
          {t("reseal.moreOptions")}
        </button>
        {moreOpen ? (
          <div className="mt-2">
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => view.setStopConfirmOpen(true)}>
              {t("reseal.stop")}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog open={view.stopConfirmOpen} onOpenChange={view.setStopConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("reseal.stopTitle")}</DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-muted-foreground">{t("reseal.stopBody")}</div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => view.setStopConfirmOpen(false)}>
              {t("reseal.keepGoing")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void view.stop()}>
              {t("reseal.stopConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={view.unreadableOpen} onOpenChange={view.setUnreadableOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("reseal.unreadableTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 text-sm">
            <div className="text-muted-foreground">{t("reseal.unreadableBody")}</div>
            {view.unreadableFiles === null ? (
              <div className="text-muted-foreground">{t("reseal.unreadableLoading")}</div>
            ) : view.unreadableFiles.length === 0 ? (
              <div className="text-muted-foreground">{t("reseal.unreadableNone")}</div>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2 font-mono text-xs">
                {view.unreadableFiles.map((file) => (
                  <li key={file.key} className="flex justify-between gap-3">
                    <span className="truncate">{file.key}</span>
                    <span className="shrink-0 text-muted-foreground">{formatStorageBytes(file.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => view.setUnreadableOpen(false)}>
              {t("reseal.close")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!view.unreadableFiles?.length || view.unreadableBusy}
              onClick={() => void view.deleteUnreadableFiles()}
            >
              {counted("reseal.unreadableDelete", view.unreadableFiles?.length ?? 0)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
