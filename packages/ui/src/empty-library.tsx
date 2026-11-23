import { FolderPlus, Headphones, MonitorSmartphone, MousePointerClick, Plus, Sparkles } from "lucide-react";

const pillBase = "inline-flex h-10 items-center gap-2 rounded-full px-[18px] text-sm font-bold transition";
/** The family's round buttons: the accent one, and the quiet one beside it. */
export const pillPrimary = `${pillBase} bg-primary text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.25)] hover:brightness-105`;
export const pillGhost = `${pillBase} border border-border bg-[hsl(var(--secondary)/0.5)] text-foreground hover:bg-[hsl(var(--secondary)/0.8)]`;

export type EmptyLibraryProps = {
  mascotSrc: string;
  mascotAlt: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  primary: { label: string; onClick: () => void; testId?: string };
  /** "Add a folder"; a web player, which cannot add files, leaves it out and keeps one button. */
  secondary?: { label: string; onClick: () => void; testId?: string };
  /** The three steps under the card, in order: pick files, the app finds the details, watch or listen anywhere. */
  steps: [{ title: string; body: string }, { title: string; body: string }, { title: string; body: string }];
  /** What the library holds: the last step's icon is a screen for films and series, headphones for music. */
  kind?: "video" | "music";
  testId?: string;
};

/**
 * An empty library, the same in Badger (UX-EMPTY-01) and Parrot (PAR-EMPTY-01): the freestanding mascot in a small
 * box, the eyebrow, "Add your first …", the add buttons and three steps. Only the accent (`--primary`) and the copy
 * differ between the apps.
 */
export function EmptyLibrary({ mascotSrc, mascotAlt, eyebrow, title, subtitle, primary, secondary, steps, kind = "video", testId = "empty-library" }: EmptyLibraryProps) {
  const stepIcons = [MousePointerClick, Sparkles, kind === "music" ? Headphones : MonitorSmartphone];
  return (
    <div className="flex flex-col gap-[22px]" data-testid={testId}>
      <section className="relative overflow-hidden rounded-[var(--radius)] border border-[hsl(var(--border)/0.55)] bg-[linear-gradient(100deg,hsl(var(--card)/0.96)_0%,hsl(var(--card)/0.82)_45%,hsl(var(--card)/0.55)_100%)] p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="relative flex items-center gap-7">
          <div className="grid h-[222px] w-[148px] flex-none place-items-center">
            <img src={mascotSrc} alt={mascotAlt} className="h-[152px] w-[152px] object-contain drop-shadow-[0_0_22px_hsl(var(--primary)/0.35)]" data-testid={`${testId}-mascot`} />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">{eyebrow}</div>
            <h1 className="mt-1.5 text-[40px] font-semibold leading-[1.1] text-foreground">{title}</h1>
            <div className="mt-2 text-[15px] text-muted-foreground">{subtitle}</div>
            <div className="mt-5 flex gap-2.5">
              <button type="button" className={pillPrimary} onClick={primary.onClick} data-testid={primary.testId ?? `${testId}-add`}>
                <Plus className="h-4 w-4" aria-hidden />
                {primary.label}
              </button>
              {secondary ? (
                <button type="button" className={pillGhost} onClick={secondary.onClick} data-testid={secondary.testId ?? `${testId}-folder`}>
                  <FolderPlus className="h-4 w-4" aria-hidden />
                  {secondary.label}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      <ol className="grid grid-cols-3 gap-[18px]">
        {steps.map((step, index) => {
          const Icon = stepIcons[index]!;
          return (
            <li key={step.title} className="flex items-start gap-3.5 rounded-[var(--radius)] border border-[hsl(var(--border)/0.4)] bg-[hsl(var(--card)/0.92)] px-[22px] py-5 shadow-[0_20px_50px_rgba(0,0,0,0.3)]">
              <span className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[10px] bg-[hsl(var(--primary)/0.14)] text-primary">
                <Icon className="h-[19px] w-[19px]" aria-hidden />
              </span>
              <div>
                <div className="text-[15px] font-bold text-foreground">{`${index + 1}. ${step.title}`}</div>
                <div className="mt-1 text-[13.5px] leading-normal text-muted-foreground">{step.body}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
