import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

/** Amber alert row shared by the jobs-sidebar notices (unpaid uploads, high-traffic pause). */
export default function AmberNotice({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
