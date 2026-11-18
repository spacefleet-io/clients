import type { ReactNode } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { cn } from "@space/ui";

export type DesktopSettingsSection<Id extends string> = { id: Id; label: string; icon: LucideIcon };
export type DesktopSettingsGroup<Id extends string> = { id: string; label: string; sections: DesktopSettingsSection<Id>[] };

type DesktopSettingsShellProps<Id extends string> = {
  title: string;
  subtitle?: string;
  groups: DesktopSettingsGroup<Id>[];
  activeSection: Id;
  onSelect: (section: Id) => void;
  query: string;
  onQueryChange: (value: string) => void;
  labels: { navAria: string; searchPlaceholder: string; noResults: string };
  sectionDescription?: string;
  /** Under the rail (Badger's Sign out). */
  railFooter?: ReactNode;
  /** The active section's body. */
  children: ReactNode;
};

/**
 * The fleet's one Settings page (UX-SET-01): a title, a filterable rail of categories grouped on the left (Account
 * among them), and the open category on the right under its icon, name and description. Badger and Parrot build
 * their Settings on it and supply only their own categories and their bodies.
 */
export function DesktopSettingsShell<Id extends string>({
  title,
  subtitle,
  groups,
  activeSection,
  onSelect,
  query,
  onQueryChange,
  labels,
  sectionDescription,
  railFooter,
  children,
}: DesktopSettingsShellProps<Id>) {
  const normalized = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({ ...group, sections: group.sections.filter((section) => !normalized || section.label.toLowerCase().includes(normalized)) }))
    .filter((group) => group.sections.length > 0);
  const active = groups.flatMap((group) => group.sections).find((section) => section.id === activeSection);
  const SectionIcon = active?.icon;

  return (
    <div data-testid="settings-shell">
      <header className="mb-8 max-w-2xl space-y-1">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="settings-heading">
          {title}
        </h1>
        {subtitle ? <p className="text-muted-foreground">{subtitle}</p> : null}
      </header>

      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <aside className="lg:sticky lg:top-24 lg:w-64 lg:shrink-0">
          <nav className="flex w-full flex-col gap-4" aria-label={labels.navAria} data-testid="settings-nav">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={labels.searchPlaceholder}
                aria-label={labels.searchPlaceholder}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
            </div>

            {visibleGroups.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">{labels.noResults}</p>
            ) : (
              visibleGroups.map((group) => (
                <div key={group.id} className="space-y-1">
                  <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{group.label}</div>
                  <ul className="space-y-0.5">
                    {group.sections.map((section) => {
                      const Icon = section.icon;
                      const isActive = section.id === activeSection;
                      return (
                        <li key={section.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(section.id)}
                            aria-current={isActive ? "page" : undefined}
                            data-testid={`settings-nav-${section.id}`}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                              isActive ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            )}
                          >
                            <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "")} />
                            <span className="truncate">{section.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </nav>
          {railFooter}
        </aside>

        <section className="min-w-0 flex-1" aria-live="polite" data-testid={`settings-section-${activeSection}`}>
          <header className="mb-6 flex items-center gap-3 border-b border-border pb-4">
            {SectionIcon ? (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <SectionIcon className="h-5 w-5" />
              </span>
            ) : null}
            <div className="min-w-0 space-y-0.5">
              <h2 className="text-xl font-semibold tracking-tight">{active?.label}</h2>
              {sectionDescription ? <p className="text-sm text-muted-foreground">{sectionDescription}</p> : null}
            </div>
          </header>
          {children}
        </section>
      </div>
    </div>
  );
}
