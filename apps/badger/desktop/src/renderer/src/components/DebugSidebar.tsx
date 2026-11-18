import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ReactJson from "react-json-view";
import { useLibraryActions, useLibraryDebug } from "@/lib/libraryContext";
import { Button } from "@space/ui";

const isDebugEnabled = () => import.meta.env.DEV && import.meta.env.VITE_DEBUG_SIDEBAR === "1";

export default function DebugSidebar() {
  const { t } = useTranslation();
  const { getDebugSnapshot } = useLibraryActions();
  const { debugRevision } = useLibraryDebug();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const enabled = isDebugEnabled();

  const refreshSnapshot = async () => {
    const data = await getDebugSnapshot();
    setSnapshot(data);
  };

  useEffect(() => {
    if (!enabled || !open) return;
    void refreshSnapshot();
  }, [enabled, open]);

  useEffect(() => {
    if (!enabled || !open) return;
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      void refreshSnapshot();
      refreshTimerRef.current = null;
    }, 3000);
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [enabled, open, debugRevision]);

  const content = useMemo(() => (snapshot ? snapshot : null), [snapshot]);

  if (!enabled) return null;

  return (
    <aside
      className={[
        "sticky top-0 z-40 h-screen border-r border-border bg-card",
        open ? "w-96" : "w-12",
      ].join(" ")}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          {open ? <div className="text-sm font-semibold">{t("debug.title")}</div> : null}
          <div className="flex items-center gap-2">
            {open ? (
              <Button type="button" size="sm" variant="ghost" onClick={refreshSnapshot}>
                {t("debug.refresh")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setOpen((prev) => !prev)}
              aria-label={open ? t("debug.collapse") : t("debug.expand")}
            >
              {open ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {open ? (
          <div className="flex-1 overflow-auto p-3">
            <div className="mb-2 text-xs text-muted-foreground">{t("debug.subtitle")}</div>
            {content ? (
              <div className="rounded-lg border border-border bg-muted/20 p-2 text-[11px]">
                <ReactJson
                  src={content}
                  name={false}
                  collapsed={1}
                  displayDataTypes={false}
                  displayObjectSize={false}
                  enableClipboard={false}
                  theme="monokai"
                  style={{ backgroundColor: "transparent" }}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
                {t("debug.empty")}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
