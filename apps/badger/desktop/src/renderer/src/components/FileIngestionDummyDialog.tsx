import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@space/ui";
import { Check, Loader2 } from "lucide-react";

import ImportCandidateImage from "@/components/ImportCandidateImage";
import type { TitleSearchResult } from "@/api";

type FileIngestionDummyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ingestType: "movie" | "tv";
  onIngestTypeChange: (type: "movie" | "tv") => void;
  query: string;
  onQueryChange: (query: string) => void;
  loading: boolean;
  error: string | null;
  results: TitleSearchResult[];
  running: boolean;
  onSearch: () => void;
  onSelect: (result: TitleSearchResult) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export default function FileIngestionDummyDialog({
  open,
  onOpenChange,
  ingestType,
  onIngestTypeChange,
  query,
  onQueryChange,
  loading,
  error,
  results,
  running,
  onSearch,
  onSelect,
  t,
}: FileIngestionDummyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl p-6">
        <DialogHeader>
          <DialogTitle>{t("ingestion.ui.dummyTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={ingestType === "movie" ? "default" : "secondary"}
              onClick={() => onIngestTypeChange("movie")}
            >
              {t("ingestion.ui.movie")}
            </Button>
            <Button
              type="button"
              variant={ingestType === "tv" ? "default" : "secondary"}
              onClick={() => onIngestTypeChange("tv")}
            >
              {t("ingestion.ui.tv")}
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("ingestion.ui.searchTitlesPlaceholder")}
              className="flex-1"
              onKeyDown={(event) => event.key === "Enter" && onSearch()}
            />
            <Button variant="secondary" onClick={onSearch} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ingestion.ui.search")}
            </Button>
          </div>
          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {results.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {results.slice(0, 9).map((result) => (
                <button
                  key={result.id}
                  className="text-left group"
                  onClick={() => onSelect(result)}
                  disabled={running}
                >
                  <div className="aspect-[2/3] rounded-md overflow-hidden bg-muted mb-2 relative">
                    <ImportCandidateImage
                      path={result.posterPath}
                      alt={result.title}
                      className="w-full h-full object-cover group-hover:opacity-80 transition-opacity"
                    />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                      <Check className="h-8 w-8 text-white" />
                    </div>
                  </div>
                  <div className="text-xs font-semibold truncate">{result.title}</div>
                  <div className="text-[10px] text-muted-foreground">{result.year}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">{t("ingestion.ui.searchDummyHint")}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
