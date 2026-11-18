import React, { createContext, lazy, Suspense, useContext, useState, ReactNode } from "react";
import { rendererLogger } from "@/logger";

const ingestionContextLog = rendererLogger.child({ scope: "ingestion-context" });

const FileIngestionDialog = lazy(() => import("@/components/FileIngestionDialog"));

type IngestionContextValue = {
  openIngestion: (paths?: string[]) => void;
};

const IngestionContext = createContext<IngestionContextValue | null>(null);

export const IngestionProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [pathsNonce, setPathsNonce] = useState(0);

  const openIngestion = (initialPaths: string[] = []) => {
    setPaths(initialPaths);
    setPathsNonce((value) => value + 1);
    setOpen(true);
  };

  return (
    <IngestionContext.Provider value={{ openIngestion }}>
      {children}
      {open ? (
        <Suspense fallback={null}>
          <FileIngestionDialog
            open={open}
            onOpenChange={setOpen}
            paths={paths}
            pathsNonce={pathsNonce}
          />
        </Suspense>
      ) : null}
    </IngestionContext.Provider>
  );
};

export const useIngestion = () => {
  const ctx = useContext(IngestionContext);
  if (!ctx) {
    if (import.meta.env.DEV) {
      ingestionContextLog.warn({ stack: new Error().stack }, "useIngestion used without provider; falling back to no-op");
    }
    return { openIngestion: () => undefined };
  }
  return ctx;
};
