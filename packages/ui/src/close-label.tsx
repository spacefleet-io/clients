import * as React from "react";

/**
 * Screen-reader label of the corner close button on Dialog and Sheet. An app with i18n wraps its
 * tree once in `CloseLabelProvider` with its translation; a single dialog can still pass `closeLabel`.
 */
const CloseLabelContext = React.createContext("Close");

export const CloseLabelProvider = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <CloseLabelContext.Provider value={label}>{children}</CloseLabelContext.Provider>
);

export const useCloseLabel = (override?: string): string => {
  const fromContext = React.useContext(CloseLabelContext);
  return override ?? fromContext;
};
