/**
 * A lasting account state in the top bar's status slot (UX-NOTICE-08): a compact amber chip, one or two words on
 * screen, whose accessible label and tooltip carry the whole notice. Unpaid (ACCT-UNPAID-05) and over storage
 * (ACCT-OVER-01/04) use it in every desktop app and web player, so the state never becomes a strip that pushes the
 * page down. With `onClick` it is a button that opens the place explaining the state; without one it only informs.
 */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

const CHIP_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-200";
const CHIP_BUTTON_CLASS =
  "hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400";

type DesktopStatusChipProps = {
  /** The one or two words shown. */
  sign: string;
  /** The whole notice: the accessible label and the tooltip. */
  message: string;
  onClick?: () => void;
  testId: string;
  /** Extra `data-*` attributes the app's tests read (wipe date, over-quota phase). */
  data?: Record<`data-${string}`, string>;
  /** A trailing control inside the chip (the over-storage dismiss). */
  trailing?: ReactNode;
};

export function DesktopStatusChip({ sign, message, onClick, testId, data, trailing }: DesktopStatusChipProps) {
  const content = (
    <>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{sign}</span>
    </>
  );
  const chip = onClick ? (
    <button
      type="button"
      data-testid={testId}
      {...data}
      aria-label={message}
      title={message}
      onClick={onClick}
      className={`${CHIP_CLASS} ${CHIP_BUTTON_CLASS}`}
    >
      {content}
    </button>
  ) : (
    <span role="status" data-testid={testId} {...data} aria-label={message} title={message} className={CHIP_CLASS}>
      {content}
    </span>
  );
  if (!trailing) return chip;
  return <span className="inline-flex shrink-0 items-center gap-1">{chip}{trailing}</span>;
}
