/**
 * Square album covers (PAR-META-22): a cover as the album gets it, and "Frame the cover", the editor the import dialog
 * (PAR-UP-08) and Edit details (PAR-META-16) open to pick which square of a picture of another shape is kept.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Disc3 } from "lucide-react";
import { parrotCoverCropOf, parrotCoverSquare, type ParrotCoverCrop } from "@space/parrot-core";
import { Button } from "../button";
import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Spinner } from "../spinner";

/**
 * A cover as the album gets it: the framed square of `src`, else its centre square; a disc when there is no picture.
 * The framing is drawn from the picture's own size, so it is the same on a small preview as on the stored cover.
 */
export function ParrotFramedCover({ src, crop, className }: { src: string | null; crop: ParrotCoverCrop | null; className: string }) {
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null);
  if (!src) {
    return (
      <div className={`${className} flex items-center justify-center bg-muted`}>
        <Disc3 className="h-1/2 w-1/2 text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (!crop) return <img src={src} alt="" className={`${className} object-cover`} />;
  const known = size?.src === src ? size : null;
  const square = known ? parrotCoverSquare(known.width, known.height, crop) : null;
  return (
    <div className={`${className} relative overflow-hidden`}>
      <img
        src={src}
        alt=""
        onLoad={(event) => setSize({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="absolute max-w-none"
        style={
          known && square
            ? { width: `${(known.width / square.side) * 100}%`, left: `${(-square.x / square.side) * 100}%`, top: `${(-square.y / square.side) * 100}%` }
            : { visibility: "hidden" }
        }
      />
    </div>
  );
}

export type ParrotCoverFrameLabels = {
  title: string;
  hint: string;
  preview: string;
  /** "Picture 1280 × 720, kept 720 × 720". */
  size: (picture: { width: number; height: number; side: number }) => string;
  centre: string;
  cancel: string;
  use: string;
};

/**
 * "Frame the cover" (PAR-META-22, Chris 2026-11-21): the whole picture with the kept square on it, 1:1 and locked,
 * the rest dimmed. Dragging inside the square moves it, dragging a corner resizes it (the opposite corner stays); the
 * arrow keys move it too. The preview shows what the album gets. The framing is kept in shares of the picture; a
 * square left at the centre is answered as no crop. Test ids start with `testId` (`-square`, `-corner-nw`, `-size`,
 * `-centre`, `-cancel`, `-use`).
 *
 * A dialog of its own, nested in the one that opens it: Radix keeps the pointer, focus and Escape on the top one (a
 * plain overlay outside an open dialog gets no pointer events).
 */
export function ParrotCoverFrameDialog({
  labels,
  src,
  size: ownSize,
  crop,
  testId,
  onCancel,
  onUse,
}: {
  labels: ParrotCoverFrameLabels;
  src: string;
  /** The picture's own size when the dialog shows a smaller copy; measured from `src` when unknown. */
  size?: { width: number; height: number } | null;
  crop: ParrotCoverCrop | null;
  testId: string;
  onCancel: () => void;
  onUse: (crop: ParrotCoverCrop | null) => void;
}) {
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const size = ownSize ?? measured;
  const [square, setSquare] = useState<{ x: number; y: number; side: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "nw" | "ne" | "sw" | "se"; from: { x: number; y: number }; start: { x: number; y: number; side: number } } | null>(null);

  useEffect(() => {
    if (size && !square) setSquare(parrotCoverSquare(size.width, size.height, crop));
  }, [size, square, crop]);

  const centre = size ? parrotCoverSquare(size.width, size.height) : null;
  const centred = Boolean(square && centre && square.x === centre.x && square.y === centre.y && square.side === centre.side);
  const toPicture = (clientX: number, clientY: number) => {
    const rect = box.current!.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * size!.width, y: ((clientY - rect.top) / rect.height) * size!.height };
  };
  const grab = (mode: "move" | "nw" | "ne" | "sw" | "se") => (event: ReactPointerEvent<HTMLElement>) => {
    if (!size || !square) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, from: toPicture(event.clientX, event.clientY), start: square };
  };
  const follow = (event: ReactPointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (!held || !size) return;
    const at = toPicture(event.clientX, event.clientY);
    const { start } = held;
    if (held.mode === "move") {
      const x = Math.round(Math.max(0, Math.min(size.width - start.side, start.x + at.x - held.from.x)));
      const y = Math.round(Math.max(0, Math.min(size.height - start.side, start.y + at.y - held.from.y)));
      setSquare({ x, y, side: start.side });
      return;
    }
    const west = held.mode.endsWith("w");
    const north = held.mode.startsWith("n");
    const anchorX = west ? start.x + start.side : start.x;
    const anchorY = north ? start.y + start.side : start.y;
    const most = Math.min(west ? anchorX : size.width - anchorX, north ? anchorY : size.height - anchorY);
    const least = Math.min(most, Math.max(32, Math.min(size.width, size.height) * 0.05));
    const side = Math.round(Math.max(least, Math.min(most, Math.max(Math.abs(at.x - anchorX), Math.abs(at.y - anchorY)))));
    setSquare({ x: west ? anchorX - side : anchorX, y: north ? anchorY - side : anchorY, side });
  };
  const nudge = (event: KeyboardEvent<HTMLElement>) => {
    if (!size || !square) return;
    const step = Math.max(1, Math.round(Math.min(size.width, size.height) * 0.02));
    const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!by) return;
    event.preventDefault();
    setSquare({
      x: Math.max(0, Math.min(size.width - square.side, square.x + by[0])),
      y: Math.max(0, Math.min(size.height - square.side, square.y + by[1])),
      side: square.side,
    });
  };
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  const framed = size && square ? parrotCoverCropOf(size.width, size.height, square) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent hideCloseButton aria-describedby={undefined} className="w-[760px] max-w-[calc(100vw-2rem)] gap-4 bg-popover p-5 text-sm" data-testid={testId}>
        <div>
          <DialogTitle className="text-base">{labels.title}</DialogTitle>
          <div className="text-muted-foreground">{labels.hint}</div>
        </div>
        <div className="flex flex-wrap items-start gap-5">
          {size && square ? (
            <div ref={box} className="relative min-w-0 flex-[1_1_420px] touch-none select-none overflow-hidden rounded-lg" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
              <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full" />
              <div
                role="slider"
                tabIndex={0}
                aria-label={labels.title}
                aria-valuetext={labels.size({ width: size.width, height: size.height, side: square.side })}
                className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ left: pct(square.x, size.width), top: pct(square.y, size.height), width: pct(square.side, size.width), height: pct(square.side, size.height) }}
                onPointerDown={grab("move")}
                onPointerMove={follow}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onKeyDown={nudge}
                data-testid={`${testId}-square`}
              >
                <div className="absolute inset-x-0 top-1/3 h-px bg-white/35" />
                <div className="absolute inset-x-0 top-2/3 h-px bg-white/35" />
                <div className="absolute inset-y-0 left-1/3 w-px bg-white/35" />
                <div className="absolute inset-y-0 left-2/3 w-px bg-white/35" />
                {(
                  [
                    ["nw", "-left-1.5 -top-1.5 cursor-nwse-resize"],
                    ["ne", "-right-1.5 -top-1.5 cursor-nesw-resize"],
                    ["sw", "-bottom-1.5 -left-1.5 cursor-nesw-resize"],
                    ["se", "-bottom-1.5 -right-1.5 cursor-nwse-resize"],
                  ] as const
                ).map(([mode, at]) => (
                  <span key={mode} className={`absolute h-3 w-3 rounded-sm border border-black/40 bg-white ${at}`} onPointerDown={grab(mode)} data-testid={`${testId}-corner-${mode}`} />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-48 flex-[1_1_420px] items-center justify-center">
              <Spinner size="sm" />
              {/* Measures the picture when its own size is not known. */}
              <img src={src} alt="" className="hidden" onLoad={(event) => setMeasured({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
            </div>
          )}
          <div className="w-36 shrink-0 space-y-2">
            <div className="text-xs text-muted-foreground">{labels.preview}</div>
            <ParrotFramedCover src={src} crop={framed} className="aspect-square w-full rounded-lg shadow-lg" />
            {size && square ? (
              <div className="text-[11px] text-muted-foreground" data-testid={`${testId}-size`}>
                {labels.size({ width: size.width, height: size.height, side: square.side })}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={centred || !centre} onClick={() => centre && setSquare(centre)} data-testid={`${testId}-centre`}>
            {labels.centre}
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onCancel} data-testid={`${testId}-cancel`}>
              {labels.cancel}
            </Button>
            <Button disabled={!framed} onClick={() => onUse(centred ? null : framed)} data-testid={`${testId}-use`}>
              {labels.use}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
