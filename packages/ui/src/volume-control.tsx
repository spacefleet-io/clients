import { useEffect, useRef, type KeyboardEvent } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { cn } from "./utils";
import { stepVolume, volumeLevel, wheelSteps } from "./volume";

export type VolumeControlLabels = { volume: string; mute: string; unmute: string };

export type VolumeControlProps = {
  /** The player's own level, 0..1. */
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  labels: VolumeControlLabels;
  className?: string;
  buttonClassName?: string;
  iconClassName?: string;
  sliderClassName?: string;
  /** `data-testid` prefix: `<prefix>-mute`, `<prefix>-slider`. */
  testId?: string;
};

const SLIDER_STEP_KEYS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 };

const thumb =
  "[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm " +
  "[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary";

/**
 * The player volume control every SpaceFleet player bar uses: a speaker button (click mutes or
 * unmutes; the icon shows the level) and a horizontal slider. The wheel over either part and the
 * arrow keys on the slider move it 5 % at a time. Controlled: the player owns the state.
 */
export function VolumeControl(props: VolumeControlProps) {
  const { volume, muted, onVolumeChange, onToggleMute, labels, testId = "volume" } = props;
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ volume, onVolumeChange });
  latest.current = { volume, onVolumeChange };

  // A native, non-passive listener: React's wheel handler is passive, so it could not stop the page scrolling.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const steps = wheelSteps(event.deltaY);
      if (steps === 0) return;
      event.preventDefault();
      latest.current.onVolumeChange(stepVolume(latest.current.volume, steps));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const shown = muted ? 0 : volume;
  const percent = Math.round(shown * 100);
  const level = volumeLevel({ volume, muted });
  const Icon = level === "muted" ? VolumeX : level === "low" ? Volume1 : Volume2;

  const onSliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const steps = SLIDER_STEP_KEYS[event.key];
    if (steps === undefined) return;
    event.preventDefault();
    onVolumeChange(stepVolume(shown, steps));
  };

  return (
    <div ref={root} className={cn("flex shrink-0 items-center gap-1", props.className)} data-testid={testId}>
      <button
        type="button"
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          props.buttonClassName,
        )}
        aria-label={level === "muted" ? labels.unmute : labels.mute}
        aria-pressed={level === "muted"}
        data-testid={`${testId}-mute`}
        data-level={level}
        onClick={onToggleMute}
      >
        <Icon className={cn("h-4 w-4", props.iconClassName)} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        aria-label={labels.volume}
        aria-valuetext={`${percent}%`}
        data-testid={`${testId}-slider`}
        className={cn(
          "h-1 w-24 cursor-pointer appearance-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          thumb,
          props.sliderClassName,
        )}
        style={{ background: `linear-gradient(to right, hsl(var(--primary)) ${percent}%, hsl(var(--secondary)) ${percent}%)` }}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        onKeyDown={onSliderKey}
      />
    </div>
  );
}
