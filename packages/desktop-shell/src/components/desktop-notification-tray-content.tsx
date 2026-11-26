import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import type { HistoryEntry } from "@space/notify-core/history";
import type { NoticeLevel } from "@space/notify-core/kinds";
import { partText, titleText, type Translate } from "@space/notify-core/texts";
import { AnimatedDismissRow, useStaggeredDismiss } from "./animated-dismiss-row";

export type NotificationTrayContentProps = {
  entries: readonly HistoryEntry[];
  /**
   * Translates the shared `notify.*` texts (UX-NOTICE-13) and the app's own keys an entry was saved with, in the
   * language of the moment, so the history follows a language change.
   */
  t: Translate;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  /** Follows an entry's button or target (UX-NOTICE-11: a warning's button still works from its history entry). */
  onOpenTarget?: (target: string) => void;
  renderActions?: (entry: HistoryEntry) => ReactNode;
};

const FILTERS = ["all", "error", "warning", "info", "success"] as const;
type Filter = NoticeLevel | "all";

const filterLabel = (filter: Filter, t: Translate) => (filter === "all" ? t("notify.filterAll") : t(`notify.filter.${filter}`));

const borderColorClass = (level: NoticeLevel) => {
  if (level === "error") return "border-l-destructive";
  if (level === "warning") return "border-l-yellow-500";
  if (level === "success") return "border-l-green-500";
  return "border-l-primary";
};

export function NotificationTrayContent({ entries, t, onRemove, onClearAll, onOpenTarget, renderActions }: NotificationTrayContentProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();

  const handleRemove = (id: string) => scheduleDismiss(id, () => onRemove(id));

  const filtered = filter === "all" ? entries : entries.filter((n) => n.level === filter);

  return (
    <>
      <div className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-2 bg-[#0d1117] px-1 pb-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setFilter(level)}
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition ${
                filter === level
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/50 text-muted-foreground hover:bg-secondary"
              }`}
            >
              {filterLabel(level, t)}
            </button>
          ))}
        </div>
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={onClearAll}
            className="shrink-0 text-[10px] font-semibold text-muted-foreground hover:text-destructive"
            title={t("notify.clearAll")}
            aria-label={t("notify.clearAll")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {filtered.map((n) => {
        const isExpanded = expandedId === n.id;
        const isRemoving = dismissing.has(n.id);
        const actions = renderActions?.(n);
        const openTo = n.action?.target ?? n.target;
        const message = partText(t, n.message);
        return (
          <AnimatedDismissRow
            key={n.id}
            removing={isRemoving}
            innerClassName={`rounded-lg border border-l-4 ${borderColorClass(n.level)} bg-background/30 text-sm`}
          >
            <div
              role="button"
              tabIndex={isRemoving ? -1 : 0}
              className="flex cursor-pointer items-center gap-2 px-3 py-2"
              data-testid={`notice-entry-${n.key}`}
              onClick={() => {
                if (isRemoving) return;
                setExpandedId(isExpanded ? null : n.id);
              }}
              onKeyDown={(e) => {
                if (isRemoving) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpandedId(isExpanded ? null : n.id);
                }
              }}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              {n.read ? null : <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
              <div className="min-w-0 flex-1 truncate font-medium text-foreground">{titleText(t, n)}</div>
              <div className="shrink-0 text-[10px] text-muted-foreground">
                {new Date(n.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                disabled={isRemoving}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(n.id);
                }}
                title={t("notify.remove")}
                aria-label={t("notify.remove")}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {isExpanded ? (
              <div className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">
                {message}
                {onOpenTarget && openTo ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      className="rounded-md bg-secondary/60 px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-secondary"
                      data-testid={`notice-entry-open-${n.key}`}
                      onClick={() => onOpenTarget(openTo)}
                    >
                      {n.action ? partText(t, n.action.label) : t("notify.open")}
                    </button>
                  </div>
                ) : null}
                {actions ? <div className="mt-2">{actions}</div> : null}
              </div>
            ) : null}
          </AnimatedDismissRow>
        );
      })}
    </>
  );
}
