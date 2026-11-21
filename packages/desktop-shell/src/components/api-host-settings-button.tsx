import { useEffect, useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { Button } from "@space/ui";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import type { ApiHostState, DesktopPlatformBridge } from "../platform";

export type ApiHostSettingsButtonLabels = {
  button: string;
  title: string;
  subtitle: string;
  label: string;
  placeholder: string;
  hint: string;
  useDefault: string;
  save: string;
  saving: string;
  error: string;
  apiLabel: string;
  customBadge: string;
  defaultBadge: string;
};

type ApiHostSettingsButtonProps = {
  bridge: Pick<DesktopPlatformBridge, "apiHost">;
  labels: ApiHostSettingsButtonLabels;
  onApiHostApplied?: (apiBaseUrl: string) => void;
  className?: string;
};

type HostBadgeLabels = Pick<ApiHostSettingsButtonLabels, "customBadge" | "defaultBadge">;

export const formatHostBadgeLabel = (
  labels: HostBadgeLabels,
  input: {
    customValue: string | null;
    defaultValue: string;
  }
): string => {
  return input.customValue
    ? `${labels.customBadge}: ${input.customValue}`
    : `${labels.defaultBadge}: ${input.defaultValue}`;
};

export const formatActiveApiHostLabel = (
  labels: Pick<ApiHostSettingsButtonLabels, "apiLabel" | "customBadge" | "defaultBadge">,
  input: {
    customApiBaseUrl: string | null;
    defaultApiBaseUrl: string;
  }
): string => {
  return `${labels.apiLabel}: ${formatHostBadgeLabel(labels, {
    customValue: input.customApiBaseUrl,
    defaultValue: input.defaultApiBaseUrl,
  })}`;
};

const fallbackApiState: ApiHostState = {
  apiBaseUrl: PRODUCTION_API_BASE_URL,
  customApiBaseUrl: null,
  defaultApiBaseUrl: PRODUCTION_API_BASE_URL,
};

export const ApiHostSettingsButton = ({
  bridge,
  labels,
  onApiHostApplied,
  className,
}: ApiHostSettingsButtonProps) => {
  const [open, setOpen] = useState(false);
  const [apiState, setApiState] = useState<ApiHostState>(fallbackApiState);
  const [apiDraft, setApiDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void bridge.apiHost
      .get()
      .then((next) => {
        if (!mounted) return;
        setApiState(next);
        onApiHostApplied?.(next.apiBaseUrl);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, [bridge, onApiHostApplied]);

  useEffect(() => {
    if (!open) return;
    setApiDraft(apiState.customApiBaseUrl ?? "");
    setError(null);
  }, [open, apiState.customApiBaseUrl]);

  const activeHostLabel = useMemo(
    () =>
      formatActiveApiHostLabel(labels, {
        customApiBaseUrl: apiState.customApiBaseUrl,
        defaultApiBaseUrl: apiState.defaultApiBaseUrl,
      }),
    [labels, apiState]
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const currentApiDraft = apiState.customApiBaseUrl ?? "";
      const nextApiDraft = apiDraft.trim();
      const payload: {
        apiBaseUrl?: string | null;
      } = {};

      if (nextApiDraft !== currentApiDraft) {
        payload.apiBaseUrl = nextApiDraft || null;
      }

      const nextApiState = await bridge.apiHost.set(payload);
      setApiState(nextApiState);
      onApiHostApplied?.(nextApiState.apiBaseUrl);

      setOpen(false);
    } catch {
      setError(labels.error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        type="button"
        className={className ?? "border-[#30363d] text-[#8b949e] hover:text-white hover:bg-[#161b22]"}
        onClick={() => setOpen(true)}
        title={activeHostLabel}
        aria-label={labels.button}
      >
        <Settings className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{labels.subtitle}</p>
            <div className="grid gap-2">
              <Label htmlFor="api-host-input">{labels.label}</Label>
              <Input
                id="api-host-input"
                value={apiDraft}
                onChange={(event) => setApiDraft(event.target.value)}
                placeholder={labels.placeholder}
              />
              <p className="text-xs text-muted-foreground">{labels.hint}</p>
            </div>
            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={saving}
              onClick={() => setApiDraft("")}
            >
              {labels.useDefault}
            </Button>
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? labels.saving : labels.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
