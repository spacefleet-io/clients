/**
 * @test-id PARROT-TV-START-001
 * @level unit
 * @req PAR-TV-01[parrot-tv]
 * @req PAR-TV-02[parrot-tv]
 * @req PAR-TV-10[parrot-tv]
 * @req PAR-TV-12[parrot-tv]
 * @why The Parrot TV app is the phone app showing its TV screens (PAR-TV-01): on a TV the start goes language, the
 *   sign-in by pairing (the family's TV sign-in with Parrot's pairing, the phone's password form behind "Use email and
 *   password instead"), the key only after a password sign-in, then "Who's listening?" at every start, then the TV shell
 *   with the top bar, where Back on a tab other than Home returns Home (PAR-TV-10). The TV screens are the shared
 *   mobile-shell ones and are tried on a TV; this pins Parrot's order and wiring, and the packaging (launcher entry,
 *   banner, phone-only portrait lock, the separate ParrotTV target and scheme) that makes the same app a TV app.
 * @covers apps/parrot/mobile/src/tv/TvGates.tsx
 * @covers apps/parrot/mobile/src/tv/TvMainShell.tsx
 * @covers apps/parrot/mobile/src/tv/tvPages.tsx
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { TvFocusGuide } from "@space/mobile-shell/tv/TvFocusGuide";
import type { TvPages } from "../src/tv/tvPages";

const h = vi.hoisted(() => ({
  session: null as { token: string; user: { id: string } } | null,
  libraryKey: null as string | null,
  profiles: { status: "ready", needsChoice: false, profiles: [] as { id: string }[], activeId: null as string | null },
  backHandlers: [] as Array<() => boolean>,
  menuHolds: [] as Array<[string, boolean]>,
  languages: [] as string[],
  stops: 0,
  remoteKeys: 0,
  /** The shell's keep-awake asks, one entry per change (`useTvKeepAwake`). */
  awake: [] as boolean[],
  owner: null as unknown,
  pages: null as TvPages | null,
  seeAll: null as ((albumSort?: "recent") => void) | null,
  focusRequests: [] as string[],
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android", isTV: true },
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  View: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      h.backHandlers.push(handler);
      return { remove: () => void h.backHandlers.splice(h.backHandlers.indexOf(handler), 1) };
    },
  },
}));
vi.mock("lucide-react-native", () => ({ ListMusic: () => null }));
vi.mock("../src/brand", () => ({ PARROT_TV_ICON: 7 }));
vi.mock("@space/mobile-shell/tv/TvLanguage", () => ({ TvLanguageView: (_: unknown) => null }));
vi.mock("@space/mobile-shell/tv/TvProfiles", () => ({ TvProfilesView: (_: unknown) => null }));
vi.mock("@space/mobile-shell/tv/TvSignIn", () => ({ TvSignInScreen: (_: unknown) => null }));
vi.mock("@space/mobile-shell/tv/TvSky", () => ({ TvSky: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("@space/mobile-shell/tv/TvTopBar", () => ({ TvTopBar: (_: unknown) => null }));
vi.mock("@space/mobile-shell/tv/useTvMenuKey", () => ({
  useTvMenuKeyHold: (reason: string, active: boolean) => void h.menuHolds.push([reason, active]),
}));
vi.mock("../src/lib/i18n", () => ({ setParrotLanguage: async (code: string) => void h.languages.push(code) }));
vi.mock("../src/lib/playback", () => ({ stopPlayback: async () => void (h.stops += 1) }));
vi.mock("../src/lib/profiles", () => ({ parrotProfileMoves: { name: "moves" }, profileStore: { name: "store" }, useProfiles: () => h.profiles }));
vi.mock("../src/screens/LibraryKeyScreen", () => ({ LibraryKeyScreen: () => null }));
vi.mock("../src/screens/LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ session: h.session, libraryKey: h.libraryKey }) }));
vi.mock("../src/tv/useTvPairing", () => ({ useTvPairing: () => ({ state: { status: "idle" }, restart: () => undefined }) }));
vi.mock("@space/mobile-shell/render-boundary", () => ({ MobileRenderBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("../src/tv/useTvRemoteKeys", () => ({ useTvRemoteKeys: () => void (h.remoteKeys += 1) }));
vi.mock("../src/tv/useTvKeepAwake", () => ({ useTvKeepAwake: (on: boolean) => void (h.awake.at(-1) === on || h.awake.push(on)) }));
vi.mock("../src/state/usePlay", () => ({ usePlayWith: () => ({}) }));
vi.mock("../src/state/history", () => ({
  HistoryProvider: ({ owner, children }: { owner: unknown; children?: React.ReactNode }) => {
    h.owner = owner;
    return <>{children}</>;
  },
}));
vi.mock("../src/state/manage", () => ({ ManageProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("../src/state/playlistEditor", () => ({ PlaylistEditorProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
// The sections and pages are tried on a TV; here each is a stand-in, Home handing the test the shell's page stack.
vi.mock("../src/tv/TvHomeSection", async () => {
  // A hoisted mock factory runs before the file's imports: it reaches the page context through import().
  const { useTvPages } = await import("../src/tv/tvPages");
  return {
    TvHomeSection: function TvHomeSection({ onSeeAll }: { onSeeAll: () => void }) {
      h.pages = useTvPages();
      h.seeAll = onSeeAll;
      return null;
    },
  };
});
vi.mock("../src/tv/TvLibrarySection", () => ({ TvLibrarySection: function TvLibrarySection() { return null; } }));
vi.mock("../src/tv/TvPlaylistsSection", () => ({ TvPlaylistsSection: function TvPlaylistsSection() { return null; } }));
vi.mock("../src/tv/TvSearchSection", () => ({ TvSearchSection: function TvSearchSection() { return null; } }));
vi.mock("../src/tv/TvSettingsSection", () => ({ TvSettingsSection: function TvSettingsSection() { return null; } }));
vi.mock("../src/tv/TvAlbumPage", () => ({ TvAlbumPage: function TvAlbumPage(_: unknown) { return null; } }));
vi.mock("../src/tv/TvArtistPage", () => ({ TvArtistPage: function TvArtistPage(_: unknown) { return null; } }));
vi.mock("../src/tv/TvNowPlayingPage", () => ({ TvNowPlayingPage: function TvNowPlayingPage() { return null; } }));
vi.mock("../src/tv/TvLyricsPage", () => ({ TvLyricsPage: function TvLyricsPage() { return null; } }));
vi.mock("../src/tv/TvQueuePage", () => ({ TvQueuePage: function TvQueuePage() { return null; } }));
// The shell's focus guides: each hands the test its native view, whose focus requests it records by the guide's testID.
vi.mock("@space/mobile-shell/tv/TvFocusGuide", () => ({
  TvFocusGuide: function TvFocusGuide({ children, ref, testID }: { children?: React.ReactNode; enabled?: boolean; ref?: (view: unknown) => void; testID?: string }) {
    ref?.({ requestTVFocus: () => void h.focusRequests.push(testID ?? "") });
    return <>{children}</>;
  },
}));

import { TvLanguageView } from "@space/mobile-shell/tv/TvLanguage";
import { TvProfilesView } from "@space/mobile-shell/tv/TvProfiles";
import { TvSignInScreen } from "@space/mobile-shell/tv/TvSignIn";
import { TvTopBar } from "@space/mobile-shell/tv/TvTopBar";
import { LibraryKeyScreen } from "../src/screens/LibraryKeyScreen";
import { LoginScreen } from "../src/screens/LoginScreen";
import { TvGates, tvStartScreen } from "../src/tv/TvGates";
import { TvMainShell } from "../src/tv/TvMainShell";
import { useTvPairing } from "../src/tv/useTvPairing";
import { TvAlbumPage } from "../src/tv/TvAlbumPage";
import { TvArtistPage } from "../src/tv/TvArtistPage";
import { TvHomeSection } from "../src/tv/TvHomeSection";
import { TvLibrarySection } from "../src/tv/TvLibrarySection";
import { TvNowPlayingPage } from "../src/tv/TvNowPlayingPage";
import { TvPlaylistsSection } from "../src/tv/TvPlaylistsSection";
import { TvQueuePage } from "../src/tv/TvQueuePage";

const SUITE = "[PARROT-TV-START-001]";
const mobile = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => readFileSync(path.resolve(mobile, rel), "utf8");

const FRESH: PhoneSetupProgress = { step: "language", done: false, pairedKey: false, language: null, notifications: null, languageReconciled: false };
const DONE: PhoneSetupProgress = { ...FRESH, step: "signIn", language: "en", done: true };

let renderer: ReactTestRenderer | null = null;
const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
};
/** The props a mounted component got, typed by the component. */
const props = <P,>(type: React.ComponentType<P> | React.ExoticComponent<P>): P => {
  // react-test-renderer types every instance's props as an index of `any`; findByType(type) found that component.
  const found = renderer!.root.findByType(type).props as P;
  return found;
};
const has = (type: React.ElementType) => renderer!.root.findAllByType(type).length > 0;
/** Mounted and in a layer the shell shows: a layer kept under the topmost one has its focus guide disabled (hidden). */
const shown = (type: React.ElementType) =>
  renderer!.root.findAllByType(type).some((node) => {
    for (let at = node.parent; at; at = at.parent) if (at.type === TvFocusGuide && at.props.enabled === false) return false;
    return true;
  });

beforeEach(() => {
  h.session = null;
  h.libraryKey = null;
  h.profiles = { status: "ready", needsChoice: false, profiles: [], activeId: null };
  h.backHandlers = [];
  h.menuHolds = [];
  h.languages = [];
  h.stops = 0;
  h.remoteKeys = 0;
  h.awake = [];
  h.owner = null;
  h.pages = null;
  h.seeAll = null;
  h.focusRequests = [];
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    run();
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("@req PAR-TV-02[parrot-tv] Parrot TV start: language, pairing, key, Who's listening?", () => {
  it("picks the screen from the setup and the session", () => {
    const cases = [
      [{ setupDone: false, choosingLanguage: false, signedIn: false, hasKey: false }, "language"],
      [{ setupDone: true, choosingLanguage: true, signedIn: false, hasKey: false }, "language"],
      [{ setupDone: true, choosingLanguage: false, signedIn: false, hasKey: false }, "signIn"],
      [{ setupDone: true, choosingLanguage: false, signedIn: true, hasKey: false }, "libraryKey"],
      [{ setupDone: true, choosingLanguage: false, signedIn: true, hasKey: true }, "profiles"],
    ] as const;
    for (const [input, expected] of cases) {
      console.info(`${SUITE} start screen`, JSON.stringify({ input, expected, got: tvStartScreen(input) }));
      expect(tvStartScreen(input)).toBe(expected);
    }
  });

  it("a fresh TV asks the language first; Next ends the TV's setup and opens the sign-in", async () => {
    const saved: PhoneSetupProgress[] = [];
    await mount(<TvGates setup={FRESH} save={async (next) => void saved.push(next)} spinner={null} />);
    const language = props(TvLanguageView);
    await act(async () => language.onPick("fr"));
    await act(async () => language.onNext("fr"));
    console.info(`${SUITE} language step`, JSON.stringify({ languages: h.languages, saved }));
    expect(h.languages).toEqual(["fr"]);
    expect(saved).toEqual([{ ...FRESH, language: "fr", step: "signIn", done: true }]);
  });

  it("signed out shows the TV sign-in with Parrot's pairing and the phone's password form; its language button opens the language step", async () => {
    const saved: PhoneSetupProgress[] = [];
    await mount(<TvGates setup={DONE} save={async (next) => void saved.push(next)} spinner={null} />);
    const signIn = props(TvSignInScreen);
    expect(signIn.usePairing).toBe(useTvPairing);
    expect(React.isValidElement(signIn.passwordForm) && signIn.passwordForm.type).toBe(LoginScreen);
    await act(async () => signIn.onLanguage());
    expect(has(TvLanguageView)).toBe(true);
    // A setup already done is not touched by the language step: it only returns to the sign-in.
    await act(async () => props(TvLanguageView).onNext("de"));
    console.info(`${SUITE} language from sign-in`, JSON.stringify({ saved, backToSignIn: has(TvSignInScreen) }));
    expect(saved).toEqual([]);
    expect(has(TvSignInScreen)).toBe(true);
  });

  it("a password sign-in without the key asks for it", async () => {
    h.session = { token: "tok", user: { id: "u1" } };
    await mount(<TvGates setup={DONE} save={async () => undefined} spinner={null} />);
    expect(has(LibraryKeyScreen)).toBe(true);
  });

  it("an account with several profiles is asked Who's listening? (pick, not from Settings), then gets the shell", async () => {
    h.session = { token: "tok", user: { id: "u1" } };
    h.libraryKey = "key";
    h.profiles = { status: "ready", needsChoice: true, profiles: [{ id: "a" }, { id: "b" }], activeId: null };
    await mount(<TvGates setup={DONE} save={async () => undefined} spinner={null} />);
    const pick = props(TvProfilesView);
    console.info(`${SUITE} profiles`, JSON.stringify({ audience: pick.audience, startMode: pick.startMode, inApp: pick.inApp }));
    expect(pick).toMatchObject({ audience: "listening", startMode: "pick", inApp: false, store: { name: "store" }, moves: { name: "moves" } });
    h.profiles = { status: "ready", needsChoice: false, profiles: [{ id: "a" }, { id: "b" }], activeId: "b" };
    await act(async () => renderer!.update(<TvGates setup={DONE} save={async () => undefined} spinner={null} />));
    expect(has(TvMainShell)).toBe(true);
    // The shell gets the phone's library providers, with the picked profile's listening history.
    expect(h.owner).toEqual({ userId: "u1", profileId: "b", isMain: true });
  });

  it("the TV asks at every start; the phone keeps its pick (session.tsx)", () => {
    expect(source("src/state/session.tsx")).toContain("askEveryStart: Platform.isTV");
    expect(source("App.tsx")).toMatch(/if \(Platform\.isTV\) return <TvGates /);
  });
});

describe("@req PAR-TV-10[parrot-tv] Parrot TV shell: the top bar, the page stack, Back", () => {
  const back = async () => {
    let handled = false;
    await act(async () => void (handled = h.backHandlers.at(-1)!()));
    return handled;
  };

  it("shows the family's top bar with Parrot's mark; Back on another tab returns Home and holds Menu only there", async () => {
    await mount(<TvMainShell />);
    const bar = props(TvTopBar);
    expect(bar.active).toBe("home");
    expect(bar.brandIcon).toBeTruthy();
    expect(h.remoteKeys).toBeGreaterThan(0);
    expect(h.menuHolds.at(-1)).toEqual(["tv-tab", false]);
    // On Home with no page open, Back is the system's: the app leaves.
    expect(await back()).toBe(false);
    await act(async () => bar.onSelect("library"));
    expect(props(TvTopBar).active).toBe("library");
    expect(has(TvLibrarySection)).toBe(true);
    expect(h.menuHolds.at(-1)).toEqual(["tv-tab", true]);
    const handled = await back();
    console.info(`${SUITE} back`, JSON.stringify({ handled, active: props(TvTopBar).active, holds: h.menuHolds.slice(-2) }));
    expect(handled).toBe(true);
    expect(props(TvTopBar).active).toBe("home");
    expect(h.menuHolds.at(-1)).toEqual(["tv-tab", false]);
    // Home's "See all" opens the Library: the albums by artist, or newest added first from "Recently added" (PAR-HOME-01).
    await act(async () => h.seeAll!());
    expect(props(TvTopBar).active).toBe("library");
    expect(props(TvLibrarySection).albumSort).toBeNull();
    await act(async () => void props(TvTopBar).onSelect("home"));
    await act(async () => h.seeAll!("recent"));
    expect(props(TvTopBar).active).toBe("library");
    expect(props(TvLibrarySection).albumSort).toBe("recent");
    // The Library tab picked on the bar lists the albums by artist again.
    await act(async () => void props(TvTopBar).onSelect("home"));
    await act(async () => void props(TvTopBar).onSelect("library"));
    console.info(`${SUITE} see_all`, JSON.stringify({ albumSort: props(TvLibrarySection).albumSort }));
    expect(props(TvLibrarySection).albumSort).toBeNull();
  });

  it("album and artist pages open under the bar, Now playing over it; Back closes the topmost page first and refocuses what opened it", async () => {
    await mount(<TvMainShell />);
    await act(async () => h.pages!.push({ kind: "artist", artistId: "r1", name: "Linkin Park" }));
    expect(props(TvArtistPage)).toMatchObject({ artistId: "r1", name: "Linkin Park" });
    // Home stays mounted under the artist page, hidden, so Back finds its card and scroll where they were.
    expect(has(TvHomeSection)).toBe(true);
    expect(shown(TvHomeSection)).toBe(false);
    expect(h.menuHolds.at(-1)).toEqual(["tv-tab", true]);
    await act(async () => h.pages!.push({ kind: "album", albumId: "a1" }));
    expect(props(TvAlbumPage).source).toEqual({ kind: "album", albumId: "a1" });
    expect(shown(TvArtistPage)).toBe(false);
    await act(async () => h.pages!.push({ kind: "nowPlaying" }));
    // Now playing fills the screen; the album page stays mounted under it (hidden), so Back returns to the same row.
    expect(has(TvNowPlayingPage)).toBe(true);
    expect(has(TvAlbumPage)).toBe(true);
    await act(async () => h.pages!.push({ kind: "queue" }));
    // PAR-TV-12: the TV stays awake under Now playing only; Up next over it lets the screensaver start.
    expect(h.awake).toEqual([false, true, false]);
    // Up next fills the screen over Now playing, which stays mounted under it, hidden: as it shows again it hands the
    // focus back to its Up next button (TvNowPlayingPage `shown`).
    expect(has(TvQueuePage)).toBe(true);
    expect(props(TvNowPlayingPage).shown).toBe(false);
    // Each page opened under the bar is handed the focus (its own first focus); a full-screen page takes its own.
    expect(h.focusRequests).toEqual(["parrot-tv-page-artist", "parrot-tv-page-album"]);
    h.focusRequests = [];
    const trail: string[] = [];
    for (const expected of ["nowPlaying", "album", "artist", "home"]) {
      expect(await back()).toBe(true);
      const now = has(TvNowPlayingPage) && props(TvNowPlayingPage).shown ? "nowPlaying" : shown(TvAlbumPage) ? "album" : shown(TvArtistPage) ? "artist" : shown(TvHomeSection) ? "home" : "?";
      trail.push(now);
      expect(now).toBe(expected);
    }
    console.info(`${SUITE} back through pages`, JSON.stringify({ trail, focusRequests: h.focusRequests }));
    // Now playing takes its own focus back; each layer under the bar gets the focus back from its guide as it shows again.
    expect(h.focusRequests).toEqual(["parrot-tv-page-album", "parrot-tv-page-artist", "parrot-tv-section-home"]);
    // Back to Now playing keeps the TV awake again, and leaving it lets the screensaver start.
    expect(h.awake).toEqual([false, true, false, true, false]);
    expect(await back()).toBe(false);
  });

  it("a tab picked on the bar closes the pages over the section before", async () => {
    await mount(<TvMainShell />);
    await act(async () => h.pages!.push({ kind: "album", albumId: "a1" }));
    await act(async () => props(TvTopBar).onSelect("playlists"));
    expect(has(TvAlbumPage)).toBe(false);
    expect(has(TvPlaylistsSection)).toBe(true);
  });

  it("Settings opens Who's listening? in the app, closed by a pick or Done", async () => {
    await mount(<TvMainShell />);
    await act(async () => h.pages!.push({ kind: "profiles", mode: "manage" }));
    const view = props(TvProfilesView);
    expect(view).toMatchObject({ startMode: "manage", inApp: true, audience: "listening", store: { name: "store" }, moves: { name: "moves" } });
    await act(async () => view.onClose!());
    expect(has(TvProfilesView)).toBe(false);
    expect(has(TvHomeSection)).toBe(true);
  });
});

describe("@req PAR-TV-01[parrot-tv] Parrot is a TV app on Android TV and Apple TV", () => {
  it("the Android app has the TV launcher entry and banner, needs no touchscreen, and locks portrait on phones only", () => {
    const manifest = source("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(manifest).toContain('android:banner="@drawable/tv_banner"');
    expect(manifest).toMatch(/android\.hardware\.touchscreen" android:required="false"/);
    expect(manifest).toMatch(/android\.software\.leanback" android:required="false"/);
    expect(manifest).not.toContain('android:screenOrientation="portrait"');
    const activity = source("android/app/src/main/java/io/spacefleet/parrot/MainActivity.kt");
    expect(activity).toContain("if (!television) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT");
  });

  it("the Apple TV app is its own target and scheme; the iPhone scheme (TestFlight) never builds it", () => {
    const project = source("ios/project.yml");
    const schemes = project.slice(project.indexOf("\nschemes:"));
    const parrotScheme = schemes.slice(schemes.indexOf("\n  Parrot:"), schemes.indexOf("\n  ParrotTV:"));
    console.info(`${SUITE} Parrot scheme`, parrotScheme);
    expect(project).toMatch(/\n {2}ParrotTV:\n {4}type: application\n {4}platform: tvOS/);
    expect(schemes).toContain("\n  ParrotTV:");
    expect(parrotScheme).not.toContain("ParrotTV");
    const podfile = source("ios/Podfile");
    expect(podfile).toContain("target 'ParrotTV' do");
    expect(podfile).toContain("'PARROT_APPLE_TV=1'");
  });

  it("the TV shows the family's fonts (Inter, Space Grotesk) and the phone keeps its system font", () => {
    const application = source("android/app/src/main/java/io/spacefleet/parrot/MainApplication.kt");
    const tvOnly = application.slice(application.indexOf("if (isTelevision()) {"), application.lastIndexOf("loadReactNative(this)"));
    console.info(`${SUITE} Android font registration`, tvOnly);
    expect(tvOnly).toContain('addCustomFont(this, "Inter", R.font.inter)');
    expect(tvOnly).toContain('addCustomFont(this, "Space Grotesk", R.font.space_grotesk)');
    expect(application.match(/addCustomFont/g)).toHaveLength(2);
    const tvPlist = source("ios/ParrotTV/Info.plist");
    const fonts = [...tvPlist.matchAll(/<string>((?:Inter|SpaceGrotesk)-\w+\.ttf)<\/string>/g)].map((m) => m[1]);
    console.info(`${SUITE} ParrotTV UIAppFonts`, fonts.join(", "));
    expect(fonts).toHaveLength(12);
    for (const font of fonts) expect(existsSync(path.resolve(mobile, "ios/ParrotTV/Fonts", font!))).toBe(true);
    expect(source("ios/Parrot/Info.plist")).not.toContain("UIAppFonts");
  });
});
