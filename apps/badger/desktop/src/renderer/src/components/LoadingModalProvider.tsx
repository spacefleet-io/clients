import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@space/ui";
import { Loader2 } from "lucide-react";

type LoadingModalOptions = {
  title: string;
  subtitle?: string;
};

type LoadingModalContextValue = {
  showLoading: (options: LoadingModalOptions) => string;
  updateLoading: (token: string, options: Partial<LoadingModalOptions>) => void;
  hideLoading: (token?: string) => void;
};

type LoadingModalState = {
  open: boolean;
  title: string;
  subtitle?: string;
  token: string | null;
};

const LoadingModalContext = createContext<LoadingModalContextValue | undefined>(undefined);

export const LoadingModalProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadingModalState>({
    open: false,
    title: "",
    subtitle: undefined,
    token: null,
  });

  const showLoading = useCallback((options: LoadingModalOptions) => {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setState({ open: true, title: options.title, subtitle: options.subtitle, token });
    return token;
  }, []);

  const updateLoading = useCallback((token: string, options: Partial<LoadingModalOptions>) => {
    setState((prev) => {
      if (!prev.open) return prev;
      if (!prev.token || prev.token !== token) return prev;
      return {
        ...prev,
        title: options.title ?? prev.title,
        subtitle: options.subtitle ?? prev.subtitle,
      };
    });
  }, []);

  const hideLoading = useCallback((token?: string) => {
    setState((prev) => {
      if (!prev.open) return prev;
      if (token && prev.token !== token) return prev;
      return { ...prev, open: false };
    });
  }, []);

  const value = useMemo(() => ({ showLoading, updateLoading, hideLoading }), [showLoading, updateLoading, hideLoading]);
  const progressValue = useMemo(() => {
    if (!state.subtitle) return null;
    const match = state.subtitle.match(/^(\d{1,3})%$/);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(100, parsed));
  }, [state.subtitle]);

  return (
    <LoadingModalContext.Provider value={value}>
      {children}
      <Dialog open={state.open} onOpenChange={(open) => !open && hideLoading(state.token ?? undefined)}>
        <DialogContent className="max-w-sm border-none bg-transparent p-0 shadow-none" data-testid="loading-modal">
          <DialogHeader className="sr-only">
            <DialogTitle>{state.title}</DialogTitle>
            <DialogDescription>{state.subtitle ?? state.title}</DialogDescription>
          </DialogHeader>
          <div className="w-full rounded-2xl bg-black/70 p-5 text-sm text-white shadow-xl">
            <div className="text-base font-semibold">{state.title}</div>
            <div className="mt-4 flex items-center gap-3 text-white/80">
              <Loader2 className="h-5 w-5 animate-spin" />
              {progressValue === null ? <span>{state.subtitle ?? t("app.loading")}</span> : null}
            </div>
            {progressValue !== null ? (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs text-white/60">
                  <span>{t("player.preparingPlayback")}</span>
                  <span>{progressValue}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-[#ffaa54] transition-[width] duration-300 ease-out"
                    style={{ width: `${progressValue}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </LoadingModalContext.Provider>
  );
};

export const useLoadingModal = () => {
  const ctx = useContext(LoadingModalContext);
  if (!ctx) {
    throw new Error("LoadingModalProvider missing");
  }
  return ctx;
};
