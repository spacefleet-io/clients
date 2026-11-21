// Settings › "Manage offline content" (OFFL-MANAGE-01), drawn the same in every app that keeps titles or songs on a
// web-technology screen (Badger and Parrot desktop): the total at the top, one row per kept item with its picture,
// name and size and a remove button, rows with children (a show's seasons, a season's episodes) that open, and "Remove
// all" behind a confirm. Grouping and sizes come from `@space/shared/offlineManage`; the apps give translated text,
// pictures and the remove calls.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, HardDrive, Trash2 } from "lucide-react";
import type { OfflineManageRow } from "@space/shared/offlineManage";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { cn } from "./utils";

export type OfflineContentLabels = {
  /** "On this device" above the total. */
  total: string;
  empty: string;
  /** Screen-reader label of a row's remove button: gets the row's name. */
  remove: (name: string) => string;
  removeAll: string;
  /** Screen-reader label of the open/close toggle: gets the row's name. */
  expand: (name: string) => string;
  confirmTitle: string;
  confirmBody: string;
  confirmCancel: string;
  confirmRemove: string;
};

export type OfflineContentListProps = {
  rows: readonly OfflineManageRow[];
  totalText: string;
  sizeText: (bytes: number) => string;
  /** The row's shown name (fallbacks for "Season 2", a title the library lost). */
  nameOf: (row: OfflineManageRow) => string;
  /** Second line (artist, episode number); null = none. */
  detailOf?: (row: OfflineManageRow) => string | null;
  /** The row's picture; null = a plain drive mark. */
  imageOf?: (row: OfflineManageRow) => ReactNode | null;
  labels: OfflineContentLabels;
  onRemove: (row: OfflineManageRow) => Promise<void> | void;
  onRemoveAll: () => Promise<void> | void;
  /** True while the first read is in flight: no empty text yet. */
  loading?: boolean;
  /** The picture's frame: a film poster (Badger) or a square album cover (Parrot). */
  imageShape?: "poster" | "square";
  testIdPrefix?: string;
};

export function OfflineContentList({
  rows,
  totalText,
  sizeText,
  nameOf,
  detailOf,
  imageOf,
  labels,
  onRemove,
  onRemoveAll,
  loading = false,
  imageShape = "poster",
  testIdPrefix = "offline-content",
}: OfflineContentListProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async (key: string, action: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRow = (row: OfflineManageRow, depth: number): ReactNode => {
    const name = nameOf(row);
    const detail = detailOf?.(row) ?? null;
    const isOpen = open.has(row.key);
    const image = imageOf?.(row) ?? null;
    return (
      <li key={row.key} data-testid={`${testIdPrefix}-row`} data-row-key={row.key} data-kind={row.kind}>
        <div className={cn("flex flex-wrap items-center gap-3 py-3", depth > 0 && "border-t border-border/60")} style={{ paddingInlineStart: `${depth * 1.5}rem` }}>
          {row.children.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-expanded={isOpen}
              aria-label={labels.expand(name)}
              data-testid={`${testIdPrefix}-toggle`}
              onClick={() => toggle(row.key)}
            >
              {isOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
            </Button>
          ) : depth > 0 ? (
            <span className="size-8 shrink-0" aria-hidden />
          ) : null}
          {depth === 0 || row.kind === "season" ? (
            <div
              className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted", imageShape === "square" ? "size-12" : "h-[3.75rem] w-10")}
              aria-hidden
            >
              {image ?? <HardDrive className="size-5 text-muted-foreground" />}
            </div>
          ) : null}
          <div className="min-w-[8rem] flex-1">
            <p className="break-words font-medium leading-snug" data-testid={`${testIdPrefix}-name`}>
              {name}
            </p>
            {detail ? <p className="break-words text-sm text-muted-foreground">{detail}</p> : null}
          </div>
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground" data-testid={`${testIdPrefix}-size`}>
            {sizeText(row.bytes)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={labels.remove(name)}
            title={labels.remove(name)}
            disabled={busy !== null}
            data-testid={`${testIdPrefix}-remove`}
            onClick={() => void run(row.key, () => onRemove(row))}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
        {isOpen ? <ul>{row.children.map((child) => renderRow(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <div className="space-y-4" data-testid={testIdPrefix}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{labels.total}</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid={`${testIdPrefix}-total`}>
            {totalText}
          </p>
        </div>
        {rows.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            data-testid={`${testIdPrefix}-remove-all`}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="mr-2 size-4" aria-hidden />
            {labels.removeAll}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        loading ? null : (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
            {labels.empty}
          </p>
        )
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card/40 px-4">{rows.map((row) => renderRow(row, 0))}</ul>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent data-testid={`${testIdPrefix}-confirm`}>
          <DialogHeader>
            <DialogTitle>{labels.confirmTitle}</DialogTitle>
            <DialogDescription>{labels.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} data-testid={`${testIdPrefix}-confirm-cancel`}>
              {labels.confirmCancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== null}
              data-testid={`${testIdPrefix}-confirm-remove`}
              onClick={() =>
                void run("all", async () => {
                  await onRemoveAll();
                  setConfirming(false);
                })
              }
            >
              {labels.confirmRemove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
