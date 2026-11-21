/**
 * @test-id MOBILE-RAIL-001
 * @level component
 * @why Chris 2026-11-21: on Parrot's phone Home the rows could not be swiped sideways, the tab pager took the swipe
 *   (UX-PHONE-09), while Badger's rows kept theirs. Badger's rail set `nestedScrollEnabled`, which makes Android's
 *   pager let the whole gesture go when it starts on the rail; Parrot's bare `horizontal` lists did not. Every phone
 *   rail is now the shared `MobileRail` / `MobileRailScroll`, which always sets it, and no phone screen may hold a bare
 *   sideways scroller.
 */
import React from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ FlatList: "FlatList", ScrollView: "ScrollView" }));

import { MobileRail, MobileRailScroll } from "../src/components/mobile-rail";

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const rendered = async (element: React.ReactElement) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(element);
  });
  return renderer!.root.findByType((element.type === MobileRail ? "FlatList" : "ScrollView") as never).props as Record<string, unknown>;
};

/** A screen trying to take the rail's own props back (the types forbid it; a cast or a spread could still try). */
const overrides = { horizontal: false, nestedScrollEnabled: false, showsHorizontalScrollIndicator: true } as Record<string, unknown>;

describe("MobileRail keeps a sideways swipe from the tab pager (UX-PHONE-09)", () => {
  it("@req UX-PHONE-09[badger-mobile,parrot] a list rail is horizontal with nested scrolling on, whatever the screen passes", async () => {
    const props = await rendered(<MobileRail data={[1, 2, 3]} renderItem={() => null} snapToInterval={152} {...overrides} />);
    console.info("[mobile-rail:list]", JSON.stringify({ horizontal: props.horizontal, nested: props.nestedScrollEnabled }));
    expect(props).toMatchObject({ horizontal: true, nestedScrollEnabled: true, showsHorizontalScrollIndicator: false, snapToInterval: 152, data: [1, 2, 3] });
  });

  it("@req UX-PHONE-09[badger-mobile,parrot] a scroll rail is horizontal with nested scrolling on, whatever the screen passes", async () => {
    const props = await rendered(<MobileRailScroll testID="chips" {...overrides} />);
    expect(props).toMatchObject({ horizontal: true, nestedScrollEnabled: true, showsHorizontalScrollIndicator: false, testID: "chips" });
  });
});

describe("no phone screen holds a bare sideways scroller", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // The phone sources of both apps and the shell. The TV screens move by remote focus and have no tab pager.
  const roots = ["apps/badger/mobile/src", "apps/parrot/mobile/src", "packages/mobile-shell/src"];
  // The pager itself is the one sideways scroller that is not a rail; the rail is where the flag lives.
  const exempt: Record<string, true> = {
    "packages/mobile-shell/src/components/mobile-tab-pager.tsx": true,
    "packages/mobile-shell/src/components/mobile-rail.tsx": true,
  };
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "tv" || name === "node_modules" ? [] : files(path);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
    });
  // A scroll view or list tag whose props (arrow functions allowed, nested JSX not) include `horizontal`.
  const bare = /<(?:Animated\.)?(?:ScrollView|FlatList|SectionList|VirtualizedList)\b(?:[^<>]|=>)*?\bhorizontal\b/;

  it("@req UX-PHONE-09[badger-mobile,parrot] every sideways row of a phone screen is a MobileRail or MobileRailScroll", () => {
    const scanned = roots.flatMap((dir) => files(join(root, dir))).map((path) => relative(root, path));
    const offenders = scanned.filter((path) => !exempt[path] && bare.test(readFileSync(join(root, path), "utf8")));
    console.info("[mobile-rail:scan]", JSON.stringify({ scanned: scanned.length, offenders }));
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned).toContain("apps/parrot/mobile/src/screens/HomeScreen.tsx");
    expect(offenders).toEqual([]);
  });

  it("the scan recognises a bare sideways list", () => {
    expect(bare.test(`<FlatList\n  data={rows}\n  keyExtractor={(row) => row.id}\n  horizontal`)).toBe(true);
    expect(bare.test(`<FlatList\n  horizontal\n  data={rows}`)).toBe(true);
    expect(bare.test(`<ScrollView horizontal showsHorizontalScrollIndicator={false}>`)).toBe(true);
    expect(bare.test(`<MobileRail data={rows} />`)).toBe(false);
  });
});
