/**
 * Badger's player controls drawn over the picture (MPV-OSC-04, PLAY-OVL-03, PLAY-LOOK-01), from the approved design
 * (`badger-design-web/screens/desktop-player-{centre,episode}.html`): back arrow, title and meta line top left; play /
 * pause in the middle with the previous / next episode buttons beside it, each only when the app passes its handler;
 * the seek bar with both times; volume bottom left; Chapters (only with chapters), subtitles, audio, quality and
 * fullscreen chips bottom right. The desktop draws the same layout inside mpv (`tog4in1.lua`); the web player uses
 * this component. Texts arrive translated; every action goes back to the app, which owns the video.
 */
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  List,
  Minimize,
  Pause,
  Play,
  Settings,
  Scan,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { formatClock } from "@space/shared/format";
import { cn } from "../utils";

/**
 * One row of a chip's menu. `action` makes it a command ("Get more subtitles…", "Try another version") rather than a
 * choice: no check mark, never selected. `detail` is a second, smaller line (why a row is unavailable: "Needs an
 * internet connection").
 */
export type PlayerChromeMenuItem = { id: string; label: string; selected: boolean; disabled?: boolean; title?: string; action?: boolean; detail?: string };

/**
 * One bottom-right chip's menu: its items, a footer line (e.g. what auto quality picked) and the pick handler.
 */
export type PlayerChromeMenu = { items: PlayerChromeMenuItem[]; footer?: ReactNode; onSelect: (id: string) => void };

export type PlayerChromeMenuId = "chapters" | "subtitles" | "audio" | "quality";

export type PlayerChromeLabels = {
  back: string;
  play: string;
  pause: string;
  previousEpisode: string;
  nextEpisode: string;
  seek: string;
  volume: string;
  mute: string;
  unmute: string;
  chapters: string;
  subtitles: string;
  audio: string;
  quality: string;
  fullscreen: string;
  exitFullscreen: string;
};

export type PlayerChromeProps = {
  title: string;
  /** The line under the title: year for a film, "S1 · E3 “The Signal” · 2024" for an episode, then the runtime. */
  meta: string;
  labels: PlayerChromeLabels;
  /** False hides the controls (idle while playing); the picture stays. */
  visible: boolean;
  playing: boolean;
  currentSeconds: number;
  durationSeconds: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  onBack: () => void;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  /** Set only when an earlier episode exists (PLAY-OVL-03); a film passes neither. */
  onPreviousEpisode?: () => void;
  /** Set only when a later episode exists (PLAY-OVL-03). */
  onNextEpisode?: () => void;
  /** Chapters only for a file with chapters; a menu left out hides its chip. */
  menus: Partial<Record<PlayerChromeMenuId, PlayerChromeMenu>>;
  testId?: string;
};

const chip = "grid shrink-0 place-items-center rounded-full bg-[rgba(21,21,23,0.9)] text-white transition hover:bg-[rgba(40,40,44,0.95)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
const centreChip = "grid shrink-0 place-items-center rounded-full bg-[rgba(21,21,23,0.75)] text-white transition hover:bg-[rgba(21,21,23,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/**
 * The design's bar: played part and thumb in Badger yellow, unplayed part white at 0.25. A transparent range input on
 * top gives dragging, clicking and the keyboard.
 */
function BarSlider({ value, max, step, label, valueText, onChange, size, testId }: { value: number; max: number; step: number; label: string; valueText?: string; onChange: (value: number) => void; size: "seek" | "volume"; testId: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const seek = size === "seek";
  return (
    <div className={cn("relative flex flex-1 items-center", seek ? "h-9 gap-2.5" : "h-6 gap-1.5")}>
      <i className={cn("block rounded-full bg-primary", seek ? "h-2.5" : "h-[7px]")} style={{ flex: `0 0 calc(${pct}% - ${seek ? 13 : 8.5}px)` }} />
      <b className={cn("block flex-none rounded-full bg-primary", seek ? "h-9 w-1.5" : "h-6 w-[5px]")} />
      <i className={cn("block flex-1 rounded-full bg-white/25", seek ? "h-2.5" : "h-[7px]")} />
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={Math.min(value, max)}
        aria-label={label}
        aria-valuetext={valueText}
        data-testid={testId}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

const menuIcons: Record<PlayerChromeMenuId, ReactNode> = {
  chapters: <List className="size-[21px]" />,
  subtitles: <Captions className="size-[21px]" />,
  audio: <AudioLines className="size-[21px]" />,
  quality: <Settings className="size-[21px]" />,
};

export function PlayerChrome({
  title,
  meta,
  labels,
  visible,
  playing,
  currentSeconds,
  durationSeconds,
  volume,
  muted,
  fullscreen,
  onBack,
  onTogglePlay,
  onSeek,
  onVolume,
  onToggleMute,
  onToggleFullscreen,
  onPreviousEpisode,
  onNextEpisode,
  menus,
  testId = "player-chrome",
}: PlayerChromeProps) {
  const [openMenu, setOpenMenu] = useState<PlayerChromeMenuId | null>(null);
  const shown = visible || openMenu !== null;
  const open = openMenu ? menus[openMenu] : undefined;
  const menuOrder: PlayerChromeMenuId[] = ["chapters", "subtitles", "audio", "quality"];
  return (
    <div
      data-testid={testId}
      data-visible={shown ? "true" : "false"}
      className={cn("absolute inset-0 select-none text-white transition-opacity duration-300", shown ? "opacity-100" : "pointer-events-none cursor-none opacity-0")}
    >
      {/* Clicking the picture plays / pauses (and closes an open menu). */}
      <div className="absolute inset-0" onClick={() => (openMenu ? setOpenMenu(null) : onTogglePlay())} data-testid={`${testId}-surface`} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/75 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-60 bg-gradient-to-t from-black/85 to-transparent" />

      <div className="absolute left-8 top-6 flex items-center gap-4">
        <button type="button" className={cn(chip, "size-12")} aria-label={labels.back} title={labels.back} onClick={onBack} data-testid={`${testId}-back`}>
          <ArrowLeft className="size-[21px]" />
        </button>
        <div>
          <div className="font-display text-[22px] font-semibold" data-testid={`${testId}-title`}>
            {title}
          </div>
          {meta && (
            <div className="mt-0.5 text-[13.5px] opacity-75" data-testid={`${testId}-meta`}>
              {meta}
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-10">
        {/* On the first / last episode an empty slot keeps play / pause in the middle of the picture, as on a film. */}
        {onPreviousEpisode ? (
          <button type="button" className={cn(centreChip, "pointer-events-auto size-[62px]")} aria-label={labels.previousEpisode} title={labels.previousEpisode} onClick={onPreviousEpisode} data-testid={`${testId}-previous-episode`}>
            <SkipBack className="size-[25px]" fill="currentColor" />
          </button>
        ) : (
          onNextEpisode && <span aria-hidden className="size-[62px]" />
        )}
        <button type="button" className={cn(centreChip, "pointer-events-auto size-[86px]")} aria-label={playing ? labels.pause : labels.play} title={playing ? labels.pause : labels.play} onClick={onTogglePlay} data-testid={`${testId}-play`}>
          {playing ? <Pause className="size-[34px]" fill="currentColor" /> : <Play className="size-[34px]" fill="currentColor" />}
        </button>
        {onNextEpisode ? (
          <button type="button" className={cn(centreChip, "pointer-events-auto size-[62px]")} aria-label={labels.nextEpisode} title={labels.nextEpisode} onClick={onNextEpisode} data-testid={`${testId}-next-episode`}>
            <SkipForward className="size-[25px]" fill="currentColor" />
          </button>
        ) : (
          onPreviousEpisode && <span aria-hidden className="size-[62px]" />
        )}
      </div>

      <div className="absolute inset-x-11 bottom-[30px]">
        <div className="flex items-center gap-[26px] text-base tabular-nums">
          <span data-testid={`${testId}-time`}>{formatClock(currentSeconds)}</span>
          <BarSlider value={currentSeconds} max={durationSeconds} step={1} label={labels.seek} valueText={formatClock(currentSeconds)} onChange={onSeek} size="seek" testId={`${testId}-seek`} />
          <span data-testid={`${testId}-duration`}>{formatClock(durationSeconds)}</span>
        </div>
        <div className="mt-[22px] flex items-center gap-4">
          <button type="button" className={cn(chip, "size-[54px]")} aria-label={muted ? labels.unmute : labels.mute} title={muted ? labels.unmute : labels.mute} onClick={onToggleMute} data-testid={`${testId}-mute`}>
            {muted || volume === 0 ? <VolumeX className="size-[22px]" /> : <Volume2 className="size-[22px]" />}
          </button>
          <div className="flex w-[180px]">
            <BarSlider value={muted ? 0 : volume} max={1} step={0.01} label={labels.volume} valueText={`${Math.round((muted ? 0 : volume) * 100)}%`} onChange={onVolume} size="volume" testId={`${testId}-volume`} />
          </div>
          <span className="relative ml-auto flex gap-3">
            {menuOrder.map((id) =>
              menus[id] ? (
                <button
                  key={id}
                  type="button"
                  className={cn(chip, "size-[54px]", openMenu === id && "ring-2 ring-primary")}
                  aria-label={labels[id]}
                  title={labels[id]}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === id}
                  onClick={() => setOpenMenu(openMenu === id ? null : id)}
                  data-testid={`${testId}-${id}`}
                >
                  {menuIcons[id]}
                </button>
              ) : null
            )}
            <button type="button" className={cn(chip, "size-[54px]")} aria-label={fullscreen ? labels.exitFullscreen : labels.fullscreen} title={fullscreen ? labels.exitFullscreen : labels.fullscreen} onClick={onToggleFullscreen} data-testid={`${testId}-fullscreen`}>
              {fullscreen ? <Minimize className="size-[21px]" /> : <Scan className="size-[21px]" />}
            </button>
            {openMenu && open && (
              <div
                role="menu"
                aria-label={labels[openMenu]}
                data-testid={`${testId}-menu-${openMenu}`}
                className="absolute bottom-[70px] right-0 max-h-[60vh] min-w-64 max-w-sm overflow-y-auto rounded-2xl bg-[rgba(21,21,23,0.95)] p-2 text-sm shadow-2xl"
              >
                <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-white/60">{labels[openMenu]}</div>
                {open.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role={item.action ? "menuitem" : "menuitemradio"}
                    aria-checked={item.action ? undefined : item.selected}
                    disabled={item.disabled}
                    title={item.title}
                    data-testid={item.action ? `${testId}-menu-action-${item.id}` : undefined}
                    className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40", item.selected && !item.action && "text-primary")}
                    onClick={() => {
                      open.onSelect(item.id);
                      setOpenMenu(null);
                    }}
                  >
                    <Check className={cn("size-4 shrink-0", (item.action || !item.selected) && "invisible")} />
                    <span className="min-w-0">
                      <span className="block truncate">{item.label}</span>
                      {item.detail && <span className="block truncate text-xs text-white/60">{item.detail}</span>}
                    </span>
                  </button>
                ))}
                {open.footer && <div className="border-t border-white/10 px-3 pb-1 pt-2 text-xs text-white/60">{open.footer}</div>}
              </div>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
