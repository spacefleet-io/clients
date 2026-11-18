import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopAuthPrimaryButton,
  DesktopAuthPrompt,
  desktopAuthInputClassName,
  desktopAuthPromptActionClassName,
  desktopAuthSignupButtonClassName,
  desktopAuthSignupAccentTextClassName,
} from "../src/components/desktop-auth-form";

// On assertion failure, dump the full rendered markup + which expected class
// strings are present, so a contract drift is diagnosable without re-rendering.
// Wrapped in try/catch so a dump failure can't mask the original assertion.
const dumpAuthFormSnapshot = (label: string, html: string, needles: string[]) => {
  try {
    console.error(`=== [auth-form:${label}] rendered markup snapshot ===`);
    console.error(`html length=${html.length} chars`);
    for (const needle of needles) {
      console.error(`  must-contain ${JSON.stringify(needle)} present=${html.includes(needle)}`);
    }
    console.error(`full html:\n${html}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop auth form", () => {
  it("keeps the shared auth input, button, and prompt contract", () => {
    console.info(`[auth-form:contract] rendering shared auth input + button + prompt primitives`);
    const html = renderToStaticMarkup(
      <div>
        <input className={desktopAuthInputClassName} />
        <DesktopAuthPrimaryButton className="bg-[#ffaa54] text-[#0d1117]">
          Sign in
        </DesktopAuthPrimaryButton>
        <DesktopAuthPrompt>Forgot password?</DesktopAuthPrompt>
        <button className={desktopAuthPromptActionClassName}>Forgot password?</button>
        <DesktopAuthPrimaryButton className={desktopAuthSignupButtonClassName}>
          Create account
        </DesktopAuthPrimaryButton>
        <span className={desktopAuthSignupAccentTextClassName}>Sign in</span>
      </div>
    );
    console.info(`[auth-form:contract] rendered, html length=${html.length} chars`);

    const needles = [
      "h-14 rounded-2xl border-border/70 bg-card pl-12 pr-4 text-sm font-bold",
      "placeholder:uppercase",
      "h-14 rounded-2xl font-black uppercase tracking-widest inline-flex items-center justify-center gap-2",
      "pt-1 text-center text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80",
      "text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 transition-colors hover:text-foreground/80",
      "bg-[#dbe7f5] text-[#111827] hover:bg-[#c9d9ed] shadow-2xl shadow-[#dbe7f5]/20",
      "text-[#dbe7f5]",
    ];
    if (!needles.every((n) => html.includes(n))) dumpAuthFormSnapshot("contract", html, needles);

    expect(html).toContain("h-14 rounded-2xl border-border/70 bg-card pl-12 pr-4 text-sm font-bold");
    expect(html).toContain("placeholder:uppercase");
    expect(html).toContain("h-14 rounded-2xl font-black uppercase tracking-widest inline-flex items-center justify-center gap-2");
    expect(html).toContain("pt-1 text-center text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80");
    expect(html).toContain("text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 transition-colors hover:text-foreground/80");
    expect(html).toContain("bg-[#dbe7f5] text-[#111827] hover:bg-[#c9d9ed] shadow-2xl shadow-[#dbe7f5]/20");
    expect(html).toContain("text-[#dbe7f5]");
  });
});
