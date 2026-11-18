import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SlidersHorizontal, User } from "lucide-react";
import { DesktopSettingsShell, type DesktopSettingsGroup } from "../src/components/desktop-settings-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[desktop-settings-shell]";
type Id = "general" | "account";
const groups: DesktopSettingsGroup<Id>[] = [
  { id: "app", label: "App", sections: [{ id: "general", label: "General", icon: SlidersHorizontal }] },
  { id: "account", label: "Account", sections: [{ id: "account", label: "Account", icon: User }] },
];

function Harness() {
  const [section, setSection] = useState<Id>("general");
  const [query, setQuery] = useState("");
  return (
    <DesktopSettingsShell
      title="Settings"
      subtitle="Sub"
      groups={groups}
      activeSection={section}
      onSelect={setSection}
      query={query}
      onQueryChange={setQuery}
      labels={{ navAria: "Settings categories", searchPlaceholder: "Search", noResults: "Nothing" }}
      sectionDescription={`desc-${section}`}
      railFooter={<button data-testid="rail-footer">Sign out</button>}
    >
      <p data-testid="body">{section}</p>
    </DesktopSettingsShell>
  );
}

describe("shared desktop settings shell", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
  });

  // @req UX-SET-01[badger-desktop,parrot]
  it("draws the category rail with every group, switches section on click, and keeps the rail footer", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    const rail = Array.from(container.querySelectorAll('[data-testid^="settings-nav-"]')).map((el) => el.getAttribute("data-testid"));
    console.info(SUITE, "rail", rail);
    expect(rail).toEqual(["settings-nav-general", "settings-nav-account"]);
    expect(container.querySelector('[data-testid="settings-heading"]')?.textContent).toContain("Settings");
    expect(container.querySelector('[data-testid="rail-footer"]')).not.toBeNull();
    await act(async () => (container!.querySelector('[data-testid="settings-nav-account"]') as HTMLElement).click());
    console.info(SUITE, "body after click", container.querySelector('[data-testid="body"]')?.textContent);
    expect(container.querySelector('[data-testid="settings-section-account"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe("account");
  });
});
