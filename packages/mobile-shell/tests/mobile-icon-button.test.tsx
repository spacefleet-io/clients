/**
 * @test-id MOBILE-ICON-BUTTON-001
 * @level component
 * @why Quality audit #3350 (S24): Badger and Parrot each drew their own icon-only button, Badger's at 48 dp and
 *   Parrot's at 44 dp, and Parrot kept its own Button and Screen too. Both phones now draw every icon-only button with
 *   the shared `MobileIconButton` (UX-PHONE-13, a 48 dp touch floor) and every text button with `MobileButton`; no app
 *   source may grow its own copy again (REL-FAM-03).
 */
import React from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
}));

import { MOBILE_ICON_BUTTON_SIZE, MobileIconButton } from "../src/components/mobile-icon-button";

const log = (step: string, detail: unknown) => console.info(`[MOBILE-ICON-BUTTON-001] ${step}`, JSON.stringify(detail));
/** A lucide icon stand-in, drawn as a host tag. */
const Icon = "Icon" as unknown as React.ComponentType;

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const pressable = async (element: React.ReactElement) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(element);
  });
  return renderer!.root.findByType("Pressable" as never).props as Record<string, unknown> & {
    style: (state: { pressed: boolean }) => unknown[];
  };
};

/** The flattened style the button draws in a press state (falsy entries dropped, later wins). */
const drawn = (props: { style: (state: { pressed: boolean }) => unknown[] }, pressed: boolean) =>
  Object.assign({}, ...props.style({ pressed }).filter(Boolean)) as Record<string, unknown>;

describe("MobileIconButton (UX-PHONE-13)", () => {
  it("@req UX-PHONE-13[badger-mobile,parrot] is a 48 dp round target named for the screen reader, whatever the icon's size", async () => {
    const props = await pressable(
      <MobileIconButton testID="album-more" label="More" onPress={() => undefined}>
        <Icon />
      </MobileIconButton>
    );
    const rest = drawn(props, false);
    log("rest", { rest, label: props.accessibilityLabel, ripple: props.android_ripple });
    expect(MOBILE_ICON_BUTTON_SIZE).toBe(48);
    expect(rest).toMatchObject({ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" });
    expect(rest.opacity).toBeUndefined();
    expect(props).toMatchObject({ testID: "album-more", accessibilityRole: "button", accessibilityLabel: "More", accessibilityState: { disabled: false } });
    expect(props.android_ripple).toMatchObject({ borderless: true, radius: 24 });
  });

  it("@req UX-PHONE-13[badger-mobile,parrot] dims while pressed or disabled and does not fire when disabled", async () => {
    const onPress = vi.fn();
    const props = await pressable(
      <MobileIconButton label="Retry" onPress={onPress} disabled>
        <Icon />
      </MobileIconButton>
    );
    log("disabled", { disabled: props.disabled, state: props.accessibilityState, pressed: drawn(props, true).opacity });
    expect(props.disabled).toBe(true);
    expect(props.accessibilityState).toEqual({ disabled: true });
    expect(drawn(props, false).opacity).toBe(0.6);
    expect(drawn(props, true).opacity).toBe(0.6);
  });

  it("lays the screen's own style last, so a row can place it", async () => {
    const props = await pressable(
      <MobileIconButton label="Back" onPress={() => undefined} style={{ marginLeft: -12 }}>
        <Icon />
      </MobileIconButton>
    );
    expect(drawn(props, false)).toMatchObject({ width: 48, marginLeft: -12 });
  });
});

describe("no phone app draws its own button, icon button or skeleton pulse (REL-FAM-03)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const roots = ["apps/badger/mobile/src", "apps/parrot/mobile/src"];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  // A component of that name declared in app source (const, function or class), the shapes the old copies had.
  const own = /\b(?:const|function|class)\s+(?:IconButton|Button|Screen|Shimmer|SkeletonPulse|SkeletonBlock)\b/;

  it("@req REL-FAM-03[badger-mobile,parrot] app sources take Button, IconButton, Screen and the skeleton pulse from the shell", () => {
    const scanned = roots.flatMap((dir) => files(join(root, dir))).map((path) => relative(root, path));
    const offenders = scanned.filter((path) => own.test(readFileSync(join(root, path), "utf8")));
    log("scan", { scanned: scanned.length, offenders });
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned).toContain("apps/parrot/mobile/src/screens/ui.tsx");
    expect(offenders).toEqual([]);
  });

  it("the scan recognises the old copies", () => {
    expect(own.test("export const IconButton = ({")).toBe(true);
    expect(own.test("export const Button = ({ label")).toBe(true);
    expect(own.test("export function Shimmer({ style })")).toBe(true);
    expect(own.test("export const SkeletonPulse = memo(")).toBe(true);
    expect(own.test("import { MobileIconButton } from")).toBe(false);
    expect(own.test("const KeepButton = (")).toBe(false);
  });
});
