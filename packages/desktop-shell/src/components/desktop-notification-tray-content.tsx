import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import type { NotificationLevel, ShellNotification } from "../services/notifications";
import { AnimatedDismissRow, useStaggeredDismiss } from "./animated-dismiss-row";

export type NotificationTrayLabels = {
  filterAll: string;
  filterError: string;
  filterWarning: string;
  filterInfo: string;
  filterSuccess: string;
  clearAll: string;
  dismiss: string;
};

export type NotificationTrayContentProps = {
  notifications: ShellNotification[];
  labels: NotificationTrayLabels;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  renderActions?: (notification: ShellNotification) => ReactNode;
};

const FILTERS = ["all", "error", "warning", "info", "success"] as const;
type Filter = NotificationLevel | "all";

const filterLabel = (filter: (typeof FILTERS)[number], labels: NotificationTrayLabels) => {
  if (filter === "all") return labels.filterAll;
  if (filter === "error") return labels.filterError;
  if (filter === "warning") return labels.filterWarning;
  if (filter === "info") return labels.filterInfo;
  return labels.filterSuccess;
};

const borderColorClass = (level: NotificationLevel) => {
  if (level === "error") return "border-l-destructive";
  if (level === "warning") return "border-l-yellow-500";
  if (level === "success") return "border-l-green-500";
  return "border-l-primary";
};

export function NotificationTrayContent({
  notifications,
  labels,
  onRemove,
  onClearAll,
  renderActions,
}: NotificationTrayContentProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();

  const handleRemove = (id: string) => scheduleDismiss(id, () => onRemove(id));

  const filtered = filter === "all" ? notifications : notifications.filter((n) => n.level === filter);

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
              {filterLabel(level, labels)}
            </button>
          ))}
        </div>
        {notifications.length > 0 ? (
          <button
            type="button"
            onClick={onClearAll}
            className="shrink-0 text-[10px] font-semibold text-muted-foreground hover:text-destructive"
            title={labels.clearAll}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {filtered.map((n) => {
        const isExpanded = expandedId === n.id;
        const isRemoving = dismissing.has(n.id);
        const actions = renderActions?.(n);
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
              <div className="min-w-0 flex-1 truncate font-medium text-foreground">{n.title}</div>
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
                title={labels.dismiss}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {isExpanded ? (
              <div className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">
                {n.message}
                {actions ? <div className="mt-2">{actions}</div> : null}
              </div>
            ) : null}
          </AnimatedDismissRow>
        );
      })}
    </>
  );
}
