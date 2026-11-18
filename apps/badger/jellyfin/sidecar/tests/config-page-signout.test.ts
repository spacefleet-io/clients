/**
 * The Jellyfin plugin's configuration page asks whether the library key was saved before Sign out.
 *
 * @req ACCT-DEV-03[badger-jellyfin]  with a key file (or an unknown status) Sign out shows the saved-key question with Cancel
 * focused, in the user's language; Cancel and Escape change nothing; "I saved it, sign out" calls SignOut; with no key file
 * Sign out goes ahead at once
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const PAGE = join(import.meta.dirname, "..", "..", "Jellyfin.Plugin.SpaceBadger", "Configuration", "configPage.html");
const log = (...args: unknown[]) => console.info("[jellyfin-signout-key]", ...args);
// The page only chains promises on the stubbed ApiClient, so draining the microtask queue settles it; no clock involved.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type Status = { keyFilePresent: boolean } | "fail";

async function openPage(lang: string, status: Status) {
  const html = readFileSync(PAGE, "utf8").replace('<html lang="en">', `<html lang="${lang}">`);
  const calls: string[] = [];
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown> & typeof dom.window;
  win.ApiClient = {
    getUrl: (path: string) => path,
    ajax: (options: { type: string; url: string }) => {
      calls.push(`${options.type} ${options.url}`);
      if (options.url === "SpaceBadger/Status") {
        return status === "fail"
          ? Promise.reject(new Error("down"))
          : Promise.resolve({ keyFilePath: "/x/library.key", serverPicker: false, ...status });
      }
      return Promise.resolve({});
    },
    getPluginConfiguration: () => Promise.resolve({}),
    getUsers: () => Promise.resolve([]),
  };
  win.Dashboard = { alert: () => {}, showLoadingMsg: () => {}, hideLoadingMsg: () => {} };
  const script = dom.window.document.querySelector("script")!.textContent!;
  win.eval(script);
  // pageshow loads the config, then the status; the 2 s timers are cleared by pagehide below.
  dom.window.document.querySelector("#SpaceBadgerConfigPage")!.dispatchEvent(new dom.window.Event("pageshow"));
  await flush();
  const $ = (id: string) => dom.window.document.getElementById(id) as HTMLElement;
  const state = () => ({
    shown: $("sbSignOutConfirm").style.display !== "none",
    title: $("sbSignOutConfirmTitle").textContent,
    cancel: $("sbSignOutCancel").textContent,
    confirm: $("sbSignOutConfirmYes").textContent,
    focused: (dom.window.document.activeElement as HTMLElement | null)?.id,
    signOutCalls: calls.filter((c) => c.endsWith("/SignOut")).length,
    calls: [...calls],
  });
  const close = () => {
    dom.window.document.querySelector("#SpaceBadgerConfigPage")!.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  };
  return { dom, $, state, close, flush };
}

describe("Jellyfin configuration page: saved-key question at Sign out (ACCT-DEV-03)", () => {
  it("asks with Cancel focused when the key file is present; Cancel changes nothing", async () => {
    const page = await openPage("en", { keyFilePresent: true });
    page.$("sbSignOut").click();
    await page.flush();
    let s = page.state();
    log("after Sign out click", s);
    expect(s.shown).toBe(true);
    expect(s.title).toBe("Have you saved your media library key?");
    expect(page.$("sbSignOutConfirmBody").textContent).toContain("type the key");
    expect(s.cancel).toBe("Cancel");
    expect(s.confirm).toBe("I saved it, sign out");
    expect(s.focused).toBe("sbSignOutCancel");
    expect(s.signOutCalls).toBe(0);
    page.$("sbSignOutCancel").click();
    await page.flush();
    s = page.state();
    log("after Cancel", s);
    expect(s.shown).toBe(false);
    expect(s.signOutCalls).toBe(0);
    page.close();
  });

  it("Escape closes the question without signing out", async () => {
    const page = await openPage("en", { keyFilePresent: true });
    page.$("sbSignOut").click();
    page.$("sbSignOutConfirm").dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await page.flush();
    const s = page.state();
    log("after Escape", s);
    expect(s.shown).toBe(false);
    expect(s.signOutCalls).toBe(0);
    page.close();
  });

  it("signs out once the user confirms", async () => {
    const page = await openPage("en", { keyFilePresent: true });
    page.$("sbSignOut").click();
    page.$("sbSignOutConfirmYes").click();
    await page.flush();
    const s = page.state();
    log("after confirm", s);
    expect(s.signOutCalls).toBe(1);
    expect(s.shown).toBe(false);
    page.close();
  });

  it("asks too when the status is unknown", async () => {
    const page = await openPage("en", "fail");
    page.$("sbSignOut").click();
    await page.flush();
    const s = page.state();
    log("status unavailable", s);
    expect(s.shown).toBe(true);
    expect(s.signOutCalls).toBe(0);
    page.close();
  });

  it("signs out at once when no key file is held", async () => {
    const page = await openPage("en", { keyFilePresent: false });
    page.$("sbSignOut").click();
    await page.flush();
    const s = page.state();
    log("no key", s);
    expect(s.shown).toBe(false);
    expect(s.signOutCalls).toBe(1);
    page.close();
  });

  it.each([
    ["fr-FR", "Avez-vous enregistré votre clé de médiathèque ?", "Annuler"],
    ["nl", "Heb je je mediatheeksleutel bewaard?", "Annuleren"],
    ["de", "Hast du deinen Mediathek-Schlüssel gespeichert?", "Abbrechen"],
    ["es-MX", "¿Guardaste la clave de tu mediateca?", "Cancelar"],
    ["ja", "Have you saved your media library key?", "Cancel"],
  ])("speaks the user's language (%s)", async (lang, title, cancel) => {
    const page = await openPage(lang, { keyFilePresent: true });
    page.$("sbSignOut").click();
    const s = page.state();
    log(lang, s.title, s.cancel, s.confirm);
    expect(s.title).toBe(title);
    expect(s.cancel).toBe(cancel);
    page.close();
  });
});
