// PLAY-SKIP-09: the show page's way to change an episode's intro or credits times without playing it. Each episode
// row gets a skip button whose menu opens the times panel (PLAY-SKIP-04's handles, pictures from the stored seek-bar
// previews), then "Use these times for" (PLAY-SKIP-05). The writes are the player's own (`applySkipEdit`).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { SkipForward } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, toast } from "@space/ui";
import type { MediaDetails } from "@space/shared/libraryTypes";
import type { SkipKind } from "@space/shared/skipMarkers";
import { queueSkipContribution } from "@space/metadata-client";
import { applySkipEdit, preselectSkipEdit, type SkipEditDeps } from "@/lib/mpvSkipEdit";
import { retrySkipCatchUp, retrySkipCatchUpVideos, useSkipCatchUpStatus } from "@/lib/skipCatchUp";
import {
  episodeDurationSeconds,
  episodeSourceFormatId,
  leftOutFormatIds,
  episodePreviewSheets,
  formatSkipClock,
  initialSkipHandles,
  moveSkipHandle,
  skipHandlesSavable,
  skipPanelPicture,
  skipPanelRange,
  type SkipPanelHandle,
  type SkipPanelHandles,
} from "@/lib/skipTimesPanel";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "skip-times-editor" });

export type SkipTimesLibrary = Pick<SkipEditDeps, "listSkipAnalysis" | "upsertSkipAnalysis" | "replaceSkipMarkers"> & {
  /** Reloads the show after a save, so the rows show the new times. */
  onChanged: () => void;
};

/** The intro and credits chips of an episode row ("Intro 1:10–1:30", "Credits 21:16"). */
export function SkipTimesChips({ media, episodeId }: { media: MediaDetails; episodeId: string }) {
  const { t } = useTranslation();
  const intro = media.skipMarkers.find((marker) => marker.episodeId === episodeId && marker.type === "intro");
  const credits = media.skipMarkers.find((marker) => marker.episodeId === episodeId && marker.type === "credits");
  const chip = "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground";
  return (
    <>
      {intro ? (
        <span className={chip} data-testid={`skip-chip-intro-${episodeId}`}>
          {t("library.skipTimes.introChip", { start: formatSkipClock(intro.startSeconds), end: formatSkipClock(intro.endSeconds) })}
        </span>
      ) : null}
      {credits ? (
        <span className={chip} data-testid={`skip-chip-credits-${episodeId}`}>
          {t("library.skipTimes.creditsChip", { start: formatSkipClock(credits.startSeconds) })}
        </span>
      ) : null}
    </>
  );
}

/**
 * An episode the skip-detection catch-up left out (failed or cancelled, MPV-PREV-07): "Left out" and "Try again" on
 * its row, so it can be asked again after its Jobs entry was removed (PLAY-SKIP-09).
 */
export function SkipLeftOutChip({ media, episodeId }: { media: MediaDetails; episodeId: string }) {
  const { t } = useTranslation();
  const status = useSkipCatchUpStatus();
  const formatId = episodeSourceFormatId(media, episodeId);
  if (!formatId || !leftOutFormatIds(status, media.id).has(formatId)) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" data-testid={`skip-left-out-${episodeId}`}>
      {t("library.skipTimes.leftOut")}
      <span aria-hidden>·</span>
      <button
        type="button"
        className="font-semibold text-foreground hover:underline"
        data-testid={`skip-left-out-retry-${episodeId}`}
        onClick={(event) => {
          event.stopPropagation();
          void retrySkipCatchUp(formatId);
        }}
      >
        {t("library.skipTimes.tryAgain")}
      </button>
    </span>
  );
}

/** "Try again for all left-out episodes" above a title's episodes, when it has two or more (PLAY-SKIP-09). */
export function SkipLeftOutRetryAll({ media }: { media: MediaDetails }) {
  const { t } = useTranslation();
  const status = useSkipCatchUpStatus();
  const leftOut = [...leftOutFormatIds(status, media.id)];
  if (leftOut.length < 2) return null;
  return (
    <div className="flex justify-end">
      <button
        type="button"
        className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted/70"
        data-testid="skip-left-out-retry-all"
        onClick={() => void retrySkipCatchUpVideos(leftOut)}
      >
        {t("library.skipTimes.tryAgainAll")}
      </button>
    </div>
  );
}

/** The row's skip button and its menu; picking an entry opens the panel. Nothing shows when the length is unknown. */
export function SkipTimesMenu({
  media,
  episodeId,
  episodeLine,
  library,
  playbackToken,
}: {
  media: MediaDetails;
  episodeId: string;
  /** "Parks and Recreation · S2 E2 · The Stakeout", under the panel's title. */
  episodeLine: string;
  library: SkipTimesLibrary;
  playbackToken: string | null;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<SkipKind | null>(null);
  const durationSeconds = episodeDurationSeconds(media, episodeId);
  if (!durationSeconds) return null;
  const has = (kind: SkipKind) => media.skipMarkers.some((marker) => marker.episodeId === episodeId && marker.type === kind);
  const entries: Array<{ kind: SkipKind; label: string }> = [
    { kind: "intro", label: t(has("intro") ? "player.skipUi.changeIntroTimes" : "library.skipTimes.setIntro") },
    { kind: "credits", label: t(has("credits") ? "player.skipUi.changeCreditsTimes" : "library.skipTimes.setCredits") },
  ];
  const label = t("library.skipTimes.menu");
  return (
    <div
      className="relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.stopPropagation();
          setMenuOpen(false);
        }
      }}
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-9 w-9 p-0"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid={`skip-times-button-${episodeId}`}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        }}
      >
        <SkipForward className="h-4 w-4" />
      </Button>
      {menuOpen ? (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-[13rem] rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md">
          {entries.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="menuitem"
              className="block w-full rounded px-3 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-none"
              data-testid={`skip-times-${entry.kind}-${episodeId}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setEditing(entry.kind);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      {editing ? (
        <SkipTimesDialog
          media={media}
          episodeId={episodeId}
          episodeLine={episodeLine}
          kind={editing}
          durationSeconds={durationSeconds}
          library={library}
          playbackToken={playbackToken}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

type Step = { name: "times" } | { name: "scope"; scope: "season" | "episode" };

export function SkipTimesDialog({
  media,
  episodeId,
  episodeLine,
  kind,
  durationSeconds,
  library,
  playbackToken,
  onClose,
}: {
  media: MediaDetails;
  episodeId: string;
  episodeLine: string;
  kind: SkipKind;
  durationSeconds: number;
  library: SkipTimesLibrary;
  playbackToken: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const marker = media.skipMarkers.find((entry) => entry.episodeId === episodeId && entry.type === kind) ?? null;
  const [handles, setHandles] = useState<SkipPanelHandles>(() => initialSkipHandles(kind, marker, durationSeconds));
  const [selected, setSelected] = useState<SkipPanelHandle>(kind === "intro" && marker === null ? "end" : "start");
  const [step, setStep] = useState<Step>({ name: "times" });
  const [busy, setBusy] = useState(false);
  const range = skipPanelRange(kind, durationSeconds);
  const previews = useMemo(() => episodePreviewSheets(media, episodeId), [media, episodeId]);
  const base = usePlaybackBase(playbackToken);
  const barRef = useRef<HTMLDivElement | null>(null);
  const savable = skipHandlesSavable(handles, durationSeconds);

  const deps = (): SkipEditDeps => ({
    media,
    episodeId,
    listSkipAnalysis: library.listSkipAnalysis,
    upsertSkipAnalysis: library.upsertSkipAnalysis,
    replaceSkipMarkers: library.replaceSkipMarkers,
    queueSkipContribution,
    log: (text, data) => log.info({ mediaId: media.id, episodeId, ...data }, `[sf-skip] library ${text}`),
  });

  const move = (handle: SkipPanelHandle, seconds: number) => setHandles((current) => moveSkipHandle(kind, current, handle, seconds, durationSeconds));
  const nudge = (delta: number) => move(selected, (selected === "start" ? handles.startSeconds : handles.endSeconds) + delta);

  const secondsAt = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return range.from;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(range.from + fraction * (range.to - range.from));
  };

  const onBarPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const seconds = secondsAt(event.clientX);
    // The intro's nearest handle follows the pointer; the credits have one.
    const handle: SkipPanelHandle =
      kind === "credits" ? "start" : Math.abs(seconds - handles.startSeconds) <= Math.abs(seconds - handles.endSeconds) ? "start" : "end";
    setSelected(handle);
    move(handle, seconds);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onBarPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    move(selected, secondsAt(event.clientX));
  };

  const toScope = async () => {
    if (!savable || busy) return;
    setBusy(true);
    try {
      const answer = await preselectSkipEdit({ action: "preselect", kind, ...handles }, deps());
      setStep({ name: "scope", scope: answer.kind === "preselect" ? answer.scope : "season" });
    } catch (error) {
      log.error({ mediaId: media.id, episodeId, err: error }, "[sf-skip] library preselect failed");
      setStep({ name: "scope", scope: "season" });
    } finally {
      setBusy(false);
    }
  };

  const save = async (scope: "season" | "episode") => {
    if (busy) return;
    setBusy(true);
    try {
      await applySkipEdit({ action: "save", kind, ...handles, scope, durationSeconds }, deps());
      toast(t(scope === "season" ? "player.skipUi.savedSeason" : "player.skipUi.savedEpisode"));
      library.onChanged();
      onClose();
    } catch (error) {
      log.error({ mediaId: media.id, episodeId, err: error }, "[sf-skip] library save failed");
      toast(t("library.skipTimes.failed"));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (step.name === "times") {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nudge(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void toScope();
      }
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setStep({ name: "scope", scope: step.scope === "season" ? "episode" : "season" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      void save(step.scope);
    }
  };

  const pct = (seconds: number) => `${((seconds - range.from) / Math.max(1, range.to - range.from)) * 100}%`;
  const title = t(kind === "intro" ? "player.skipUi.changeIntroTimes" : "player.skipUi.changeCreditsTimes");
  const pictures: Array<{ handle: SkipPanelHandle; label: string; seconds: number }> =
    kind === "intro"
      ? [
          { handle: "start", label: t("player.skipUi.start"), seconds: handles.startSeconds },
          { handle: "end", label: t("player.skipUi.end"), seconds: handles.endSeconds },
        ]
      : [{ handle: "start", label: t("library.skipTimes.creditsStart"), seconds: handles.startSeconds }];
  const summary =
    kind === "intro"
      ? t("library.skipTimes.introChip", { start: formatSkipClock(handles.startSeconds), end: formatSkipClock(handles.endSeconds) })
      : t("library.skipTimes.creditsChip", { start: formatSkipClock(handles.startSeconds) });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="max-w-2xl"
        data-testid="skip-times-dialog"
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        onEscapeKeyDown={(event) => {
          // Esc on "Use these times for" goes back to the times, as in the player.
          if (step.name === "scope") {
            event.preventDefault();
            setStep({ name: "times" });
          }
        }}
      >
        {step.name === "times" ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{episodeLine}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center gap-4">
              {pictures.map((picture) => (
                <button
                  key={picture.handle}
                  type="button"
                  className={`flex flex-col items-center gap-1 rounded-md p-1 ${selected === picture.handle ? "ring-2 ring-amber-400" : ""}`}
                  onClick={() => setSelected(picture.handle)}
                >
                  <PreviewPicture base={base} picture={skipPanelPicture(previews, picture.seconds)} noPicture={t("library.skipTimes.noPicture")} />
                  <span className="text-xs text-muted-foreground">
                    {picture.label} {formatSkipClock(picture.seconds)}
                  </span>
                </button>
              ))}
            </div>
            <div className="space-y-1">
              <div
                ref={barRef}
                className="relative h-8 cursor-pointer touch-none select-none"
                data-testid="skip-times-bar"
                onPointerDown={onBarPointerDown}
                onPointerMove={onBarPointerMove}
              >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/60"
                  style={{ left: pct(handles.startSeconds), width: `calc(${pct(handles.endSeconds)} - ${pct(handles.startSeconds)})` }}
                />
                {(kind === "intro" ? (["start", "end"] as const) : (["start"] as const)).map((handle) => {
                  const seconds = handle === "start" ? handles.startSeconds : handles.endSeconds;
                  return (
                    <button
                      key={handle}
                      type="button"
                      aria-label={`${handle === "start" ? pictures[0]!.label : t("player.skipUi.end")} ${formatSkipClock(seconds)}`}
                      data-testid={`skip-times-handle-${handle}`}
                      className={`absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 ${
                        selected === handle ? "border-amber-300 bg-amber-400" : "border-border bg-background"
                      }`}
                      style={{ left: pct(seconds) }}
                      onFocus={() => setSelected(handle)}
                    />
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{formatSkipClock(range.from)}</span>
                <span>{formatSkipClock(range.to)}</span>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => nudge(-1)}>
                −1 s
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => nudge(1)}>
                +1 s
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {t(kind === "intro" ? "player.skipUi.hint" : "library.skipTimes.creditsHint")}
            </p>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("player.skipUi.cancel")}
              </Button>
              <Button type="button" disabled={!savable || busy} data-testid="skip-times-save" onClick={() => void toScope()}>
                {t("player.skipUi.save")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("player.skipUi.scopeQuestion")}</DialogTitle>
              <DialogDescription>{summary}</DialogDescription>
            </DialogHeader>
            <div role="radiogroup" className="space-y-2">
              {(["season", "episode"] as const).map((scope) => (
                <label key={scope} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="skip-times-scope"
                    checked={step.scope === scope}
                    data-testid={`skip-times-scope-${scope}`}
                    onChange={() => setStep({ name: "scope", scope })}
                  />
                  {t(scope === "season" ? "player.skipUi.thisSeason" : "player.skipUi.onlyThisEpisode")}
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setStep({ name: "times" })}>
                {t("library.skipTimes.back")}
              </Button>
              <Button type="button" disabled={busy} data-testid="skip-times-scope-save" onClick={() => void save(step.scope)}>
                {t("player.skipUi.save")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The local playback server's base URL (it decrypts the sheet objects), once it holds the session token. */
const usePlaybackBase = (token: string | null): string | null => {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (token) await window.sf?.setPlaybackToken?.(token);
        const url = (await window.sf?.getPlaybackBaseUrl?.()) ?? null;
        if (live) setBase(url);
      } catch (error) {
        log.warn({ err: error }, "[sf-skip] library playback base unavailable");
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);
  return base;
};

const PICTURE_WIDTH_PX = 240;

/** One preview picture: its sheet drawn as a background, cropped to the picture and scaled to the panel's width. */
function PreviewPicture({
  base,
  picture,
  noPicture,
}: {
  base: string | null;
  picture: ReturnType<typeof skipPanelPicture>;
  noPicture: string;
}) {
  const height = picture ? Math.round((PICTURE_WIDTH_PX * picture.height) / picture.width) : Math.round((PICTURE_WIDTH_PX * 9) / 16);
  if (!base || !picture) {
    return (
      <div className="flex items-center justify-center rounded bg-muted text-xs text-muted-foreground" style={{ width: PICTURE_WIDTH_PX, height }}>
        {noPicture}
      </div>
    );
  }
  const scale = PICTURE_WIDTH_PX / picture.width;
  return (
    <div className="overflow-hidden rounded bg-black" style={{ width: PICTURE_WIDTH_PX, height }} data-testid="skip-times-picture">
      <div
        style={{
          width: picture.width,
          height: picture.height,
          backgroundImage: `url("${base}/playback/object/${encodeURIComponent(picture.objectKey)}")`,
          backgroundPosition: `-${picture.x}px -${picture.y}px`,
          backgroundRepeat: "no-repeat",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}
