/**
 * Badger's sign-in extras shared by the desktop app and the web player (ACCT-SIGNIN-03): the "or" line under the
 * password form and the highlighted "Sign in with your phone" card that leads to the QR-code sign-in.
 */
import { ChevronRight, QrCode } from "lucide-react";

/** A thin line with a word in the middle ("or"), between two ways to sign in. */
export function BadgerSignInDivider({ label, testId = "sign-in-divider" }: { label: string; testId?: string }) {
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground" data-testid={testId}>
      <span className="h-px flex-1 bg-border" aria-hidden />
      {label}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

type PhoneSignInCardProps = {
  title: string;
  body: string;
  /** Opens the QR-code sign-in. Without it the card is a heading (the web player shows the code right below). */
  onClick?: () => void;
  testId?: string;
};

/** The highlighted "Sign in with your phone" card: amber border and tint, a QR icon, a title and one line. */
export function BadgerPhoneSignInCard({ title, body, onClick, testId = "phone-sign-in-card" }: PhoneSignInCardProps) {
  const className =
    "flex w-full items-center gap-3.5 rounded-2xl border-[1.5px] border-primary/60 bg-primary/[0.09] px-4 py-3.5 text-left";
  const content = (
    <>
      <span className="grid h-12 w-12 flex-none place-items-center rounded-xl bg-primary/[0.18] text-primary" aria-hidden>
        <QrCode size={24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-foreground">{title}</span>
        <span className="block text-[13px] text-muted-foreground">{body}</span>
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className={className} data-testid={testId}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className} transition-colors hover:bg-primary/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
      data-testid={testId}
    >
      {content}
      <ChevronRight size={18} className="flex-none text-primary" aria-hidden />
    </button>
  );
}
