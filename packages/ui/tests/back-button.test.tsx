import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BackButton } from "../src/button";
import { MediaDetailPage } from "../src/badger/media-detail";
import { ParrotBackButton } from "../src/parrot/library";
import { BadgerRowHead } from "../src/badger/components";
import { ParrotShelf } from "../src/parrot/screens";

const LOG = "[back-button:test]";
const accentHover = ["hover:bg-accent", "hover:text-accent-foreground"];

describe("shared back and text buttons", () => {
  // @req UX-BTN-01[badger-desktop,badger-web-player,parrot]
  it("BackButton is the ghost button: hover fills the accent pill with dark text", () => {
    const html = renderToStaticMarkup(<BackButton label="Library" onClick={() => {}} testId="x-back" />);
    console.info(LOG, "BackButton", html);
    for (const cls of accentHover) expect(html).toContain(cls);
    expect(html).toContain('data-testid="x-back"');
    expect(html).toContain("rounded-md");
  });

  // @req UX-BTN-01[badger-desktop,badger-web-player,parrot]
  it("Badger's title-page back and Parrot's back render the same button", () => {
    const badger = renderToStaticMarkup(
      <MediaDetailPage backLabel="Library" onBack={() => {}} poster={null} kindLabel="Film" versions={[]} title="Metropolis" meta="1927" actions={null} />,
    );
    const parrot = renderToStaticMarkup(<ParrotBackButton label="Back" onClick={() => {}} />);
    const badgerBack = badger.match(/<button[^>]*data-testid="media-detail-back"[^>]*>/)?.[0] ?? "";
    const parrotBack = parrot.match(/<button[^>]*>/)?.[0] ?? "";
    console.info(LOG, "badger back", badgerBack, "parrot back", parrotBack);
    for (const cls of accentHover) {
      expect(badgerBack).toContain(cls);
      expect(parrotBack).toContain(cls);
    }
  });

  // @req UX-BTN-01[badger-desktop,badger-web-player,parrot]
  it("Badger's title-page back has no horizontal offset, so its left edge meets the poster's like Parrot's meets the cover", () => {
    const badger = renderToStaticMarkup(
      <MediaDetailPage backLabel="Library" onBack={() => {}} poster={null} kindLabel="Film" versions={[]} title="Metropolis" meta="1927" actions={null} />,
    );
    const parrot = renderToStaticMarkup(<ParrotBackButton label="Back" onClick={() => {}} />);
    const classes = (html: string, pattern: RegExp) => new Set((html.match(pattern)?.[1] ?? "").split(/\s+/).filter(Boolean));
    const badgerBack = classes(badger, /<button[^>]*class="([^"]*)"[^>]*data-testid="media-detail-back"/);
    const parrotBack = classes(parrot, /<button[^>]*class="([^"]*)"/);
    // The page's content column holds both the back button and the poster: same left padding, no offset on either.
    const column = badger.match(/<div class="([^"]*)"><button[^>]*data-testid="media-detail-back"/)?.[1] ?? "";
    console.info(LOG, "badger back classes", [...badgerBack], "parrot back classes", [...parrotBack], "column", column);
    expect([...badgerBack].filter((cls) => /^-?m[lrx]-|^-m[lrx]?-/.test(cls))).toEqual([]);
    expect([...parrotBack].filter((cls) => /^-?m[lrx]-|^-m[lrx]?-/.test(cls))).toEqual([]);
    parrotBack.delete("mb-4");
    expect([...badgerBack].sort()).toEqual([...parrotBack].sort());
    expect(column).toContain("px-10");
  });

  // @req UX-BTN-01[badger-desktop,badger-web-player]
  it("Badger's text buttons (See all, resend code) use the ghost button too", () => {
    const html = renderToStaticMarkup(<BadgerRowHead title="Recently added" seeAll={{ label: "See all", onClick: () => {} }} />);
    const seeAll = html.match(/<button[^>]*>See all/)?.[0] ?? "";
    console.info(LOG, "see all", seeAll);
    for (const cls of accentHover) expect(seeAll).toContain(cls);

    // Where Badger desktop's "Resend code" buttons live now: the sign-in's two-step code on Login itself, Login's
    // forgot-password dialog (the shared DesktopPasswordReset, #2575), the key step's erase dialog (the shared
    // LibraryKeyStep, #1998), and Settings' own recovery dialogs.
    const repo = join(import.meta.dirname, "../../..");
    const resendButtons = [
      { file: "apps/badger/desktop/src/renderer/src/pages/Login.tsx", call: "() => void resendCode()" },
      { file: "packages/desktop-shell/src/components/desktop-password-reset.tsx", call: "() => void resend()" },
      { file: "packages/desktop-shell/src/components/library-key-step.tsx", call: "() => void run(true)" },
      { file: "apps/badger/desktop/src/renderer/src/pages/SettingsRecoveryDialogs.tsx", call: "() => void resendResetCode()" },
    ];
    for (const { file, call } of resendButtons) {
      const src = readFileSync(join(repo, file), "utf8");
      const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const resend = src.match(new RegExp(`<(\\w+)\\s[^>]*?onClick=\\{${escaped}\\}`, "s"))?.[0] ?? "";
      console.info(LOG, file, resend.replace(/\s+/g, " ") || "(no resend button found)");
      expect(resend.startsWith("<Button")).toBe(true);
      expect(resend).toContain('variant="ghost"');
    }
  });

  // @req UX-BTN-01[parrot,parrot-web-player]
  it("Parrot's Home \"See all\" (desktop and web player) is the ghost button too", () => {
    const html = renderToStaticMarkup(
      <ParrotShelf title="Your artists" seeAll="See all" onSeeAll={() => {}} testId="home-artists">
        <div />
      </ParrotShelf>,
    );
    const seeAll = html.match(/<button[^>]*data-testid="home-artists-see-all"[^>]*>/)?.[0] ?? "";
    console.info(LOG, "parrot see all", seeAll);
    for (const cls of accentHover) expect(seeAll).toContain(cls);
  });
});
