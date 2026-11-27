/**
 * The user's own lyrics editor (PAR-LYR-10), shared by the desktop renderer and the web player: a words dialog (paste or
 * type the words, save them plain) that leads to a full-page timing screen (time each line as the song plays). Texts
 * come in already translated; saving and playback stay with each app.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Minus, Pause, Play, Plus, RotateCcw, Timer } from "lucide-react";
import {
  clearParrotEditorTimes,
  nudgeParrotEditorLine,
  parrotEditorLines,
  parrotEditorLinesText,
  parrotEditorText,
  saveParrotEditorLyrics,
  tapParrotEditorLine,
  type ParrotEditorLine,
  type ParrotLyrics,
  type ParrotLyricsProblem,
  type ParrotOwnLyrics,
} from "@space/parrot-core";
import { Button } from "../button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { cn } from "../utils";

/** The words for each problem a lyrics text or file can have; `{line}` is the line to fix. */
export type ParrotLyricsProblemLabels = Record<ParrotLyricsProblem["kind"], string>;

/** The problem as the user reads it, with its line number where it has one. */
export const parrotLyricsProblemText = (problem: ParrotLyricsProblem, labels: ParrotLyricsProblemLabels): string =>
  labels[problem.kind].replace("{line}", "line" in problem ? String(problem.line) : "");

export type ParrotLyricsEditorLabels = {
  title: string;
  body: string;
  placeholder: string;
  /** The words dialog's main button, to the timing screen. */
  timeLyrics: string;
  /** The words dialog's other button: saves the words without times. */
  saveWords: string;
  /** The timing screen's way back to the words, times kept. */
  back: string;
  timingHint: string;
  /** "{timed} of {total} lines timed". */
  timedCount: string;
  tap: string;
  earlier: string;
  later: string;
  replay: string;
  clearTimes: string;
  play: string;
  pause: string;
  save: string;
  cancel: string;
  saveFailed: string;
  problems: ParrotLyricsProblemLabels;
};

export type ParrotLyricsEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The song's lyrics now (its own, its file's or found ones), the editor's starting words. */
  lyrics: ParrotLyrics | null | undefined;
  /** The song's position now, read at each tap. */
  positionMs: () => number;
  playing: boolean;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onSave: (lyrics: ParrotOwnLyrics) => Promise<void>;
  labels: ParrotLyricsEditorLabels;
};

const NUDGE_MS = 100;

const lineTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
};

/** Words as the words dialog shows them: synced lyrics lose their time tags (the times wait in the timing lines). */
const wordsOf = (text: string, lines: readonly ParrotEditorLine[]) => (lines.some((line) => line.ms !== null) ? lines.map((line) => line.text).join("\n") : text);

/** The timing lines for `text`, each keeping the time it had when its words did not change (Back, then on again). */
const linesFor = (text: string, before: readonly ParrotEditorLine[]): ParrotEditorLine[] =>
  parrotEditorLines(text).map((line, index) => (line.ms === null && before[index]?.text === line.text ? { ...line, ms: before[index]!.ms } : line));

/**
 * The lyrics editor (PAR-LYR-10). The words dialog opens on the song's words: pasting or typing and "Save the words" is
 * all most people need. "Time the lyrics" opens a full-page timing screen where each line is tapped as it starts while
 * the song plays (Space or the Tap button times the current line and moves on), with a ±0.1 s nudge and a replay from
 * the line's time; Back returns to the words with every time kept. The timing save is synced when every line has a
 * time, otherwise plain; times that go back are refused with the line to fix, never sorted.
 */
export function ParrotLyricsEditorDialog({ open, onOpenChange, lyrics, positionMs, playing, onPlayPause, onSeek, onSave, labels }: ParrotLyricsEditorDialogProps) {
  const [text, setText] = useState("");
  const [timing, setTiming] = useState(false);
  const [lines, setLines] = useState<ParrotEditorLine[]>([]);
  const [current, setCurrent] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const start = parrotEditorText(lyrics ?? null);
    const startLines = parrotEditorLines(start);
    setText(wordsOf(start, startLines));
    setLines(startLines);
    setTiming(false);
    setProblem(null);
    setSaving(false);
    // The words are read when the editor opens, not again while the user edits them.
  }, [open]);

  const startTiming = () => {
    const next = linesFor(text, lines);
    setLines(next);
    const untimed = next.findIndex((line) => line.ms === null);
    setCurrent(untimed === -1 ? 0 : untimed);
    setProblem(null);
    setTiming(true);
  };
  const back = () => {
    setText(wordsOf(text, lines));
    setProblem(null);
    setTiming(false);
  };
  const tap = () => {
    if (lines.length === 0) return;
    setLines(tapParrotEditorLine(lines, current, positionMs()));
    setCurrent(Math.min(current + 1, lines.length - 1));
    setProblem(null);
  };

  useEffect(() => {
    if (!open || !timing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (e.type === "keydown") back();
        return;
      }
      if (e.key !== " " || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (e.type === "keydown" && !e.repeat) tap();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  });

  const save = async (words: string) => {
    const result = saveParrotEditorLyrics(words);
    if (!result.ok) {
      setProblem(parrotLyricsProblemText(result.problem, labels.problems));
      if (timing && "line" in result.problem) setCurrent(result.problem.line - 1);
      return;
    }
    setSaving(true);
    try {
      await onSave(result.lyrics);
      onOpenChange(false);
    } catch {
      setProblem(labels.saveFailed);
    } finally {
      setSaving(false);
    }
  };
  const timed = lines.filter((line) => line.ms !== null).length;
  const currentLine = lines[current];
  const problemLine = problem && (
    <p className="text-sm text-destructive" role="alert" data-testid="lyrics-editor-problem">
      {problem}
    </p>
  );

  if (open && timing)
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        data-testid="lyrics-editor-timing"
      >
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <Button variant="ghost" size="sm" onClick={back} data-testid="lyrics-editor-back">
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
            {labels.back}
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{labels.title}</h2>
            <p className="text-sm text-muted-foreground">{labels.timingHint}</p>
          </div>
          <Button onClick={() => void save(parrotEditorLinesText(lines))} disabled={saving} data-testid="lyrics-editor-save">
            {labels.save}
          </Button>
        </header>
        <div className="flex flex-wrap items-center gap-2 px-6 py-3">
          <Button size="sm" variant="outline" onClick={onPlayPause} data-testid="lyrics-editor-play">
            {playing ? <Pause className="mr-2 h-4 w-4" aria-hidden /> : <Play className="mr-2 h-4 w-4" aria-hidden />}
            {playing ? labels.pause : labels.play}
          </Button>
          <Button size="sm" onClick={tap} data-testid="lyrics-editor-tap">
            {labels.tap}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={labels.earlier}
            title={labels.earlier}
            disabled={currentLine?.ms == null}
            onClick={() => setLines(nudgeParrotEditorLine(lines, current, -NUDGE_MS))}
            data-testid="lyrics-editor-earlier"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={labels.later}
            title={labels.later}
            disabled={currentLine?.ms == null}
            onClick={() => setLines(nudgeParrotEditorLine(lines, current, NUDGE_MS))}
            data-testid="lyrics-editor-later"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={currentLine?.ms == null}
            onClick={() => {
              onSeek(currentLine!.ms!);
              if (!playing) onPlayPause();
            }}
            data-testid="lyrics-editor-replay"
          >
            <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
            {labels.replay}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLines(clearParrotEditorTimes(lines))} data-testid="lyrics-editor-clear">
            {labels.clearTimes}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground" data-testid="lyrics-editor-count">
            {labels.timedCount.replace("{timed}", String(timed)).replace("{total}", String(lines.length))}
          </span>
        </div>
        {problem && <div className="px-6 pb-2">{problemLine}</div>}
        <ol className="mx-6 mb-6 min-h-0 flex-1 overflow-y-auto rounded-md border border-input">
          {lines.map((line, index) => (
            <li key={index}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-baseline gap-3 px-4 py-2 text-left text-base",
                  index === current ? "bg-primary/15 font-semibold text-foreground" : "text-foreground/80 hover:bg-accent"
                )}
                onClick={() => setCurrent(index)}
                aria-current={index === current || undefined}
                data-testid="lyrics-editor-line"
                data-timed={line.ms !== null}
              >
                <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{line.ms === null ? "–" : lineTime(line.ms)}</span>
                <span className="min-w-0 flex-1">{line.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>,
      document.body
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="lyrics-editor">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.body}</DialogDescription>
        </DialogHeader>
        <textarea
          className="min-h-[50vh] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={text}
          placeholder={labels.placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          aria-label={labels.title}
          data-testid="lyrics-editor-text"
        />
        {problemLine}
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => void save(text)} disabled={saving} data-testid="lyrics-editor-save-words">
              {labels.saveWords}
            </Button>
            <Button onClick={startTiming} disabled={parrotEditorLines(text).length === 0} data-testid="lyrics-editor-time">
              <Timer className="mr-2 h-4 w-4" aria-hidden />
              {labels.timeLyrics}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
