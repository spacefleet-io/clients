import React from "react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/button";
import { Notifications } from "../src/notifications";
import { cn } from "../src/utils";

// Per-suite dump helper: console.error's the relevant props of a rendered element
// so a failed structural/config assertion shows exactly what was produced. Body
// wrapped in try/catch so a dump failure can't mask the original assertion failure.
const dumpElementSnapshot = (label: string, element: React.ReactElement | null) => {
  try {
    console.error(`=== [ui-primitives:${label}] element snapshot ===`);
    if (!element) {
      console.error("element=null");
      return;
    }
    const t = element.type;
    console.error(
      `type=${typeof t === "string" ? t : ((t as { displayName?: string; name?: string })?.displayName ?? (t as { name?: string })?.name ?? String(t))}`,
    );
    console.error(`props=${JSON.stringify(element.props, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

type RenderedButtonProps = { children?: React.ReactNode; className?: string };
type ForwardRefButton = {
  render: (props: Record<string, unknown>, ref: unknown) => React.ReactElement<RenderedButtonProps>;
};

/** `Button` is a forwardRef exotic object; this narrows it by the one runtime property the test calls. */
const isForwardRefButton = (component: unknown): component is ForwardRefButton =>
  typeof component === "object" && component !== null && "render" in component && typeof component.render === "function";

describe("@space/ui shared primitives", () => {
  it("renders button variants with the expected semantic button element and classes", () => {
    console.info("[ui-primitives:button-variants] rendering Button variant=secondary size=lg children='Save'");
    // `Button` is a forwardRef exotic component; its `render` function is what we call directly.
    // React 19's `ReactElement` defaults `props` to `unknown`, so name the props asserted on below.
    if (!isForwardRefButton(Button)) throw new Error("Button is not a forwardRef component with a render function");
    const buttonRender = Button.render;
    const element = buttonRender(
      {
        variant: "secondary",
        size: "lg",
        children: "Save",
      },
      null
    );

    try {
      console.info(`[ui-primitives:button-variants] resolved type=${String(element.type)} className=${JSON.stringify(element.props.className)}`);
      expect(element.type).toBe("button");
      expect(element.props.children).toBe("Save");
      expect(String(element.props.className)).toContain("bg-secondary");
      expect(String(element.props.className)).toContain("h-11");
      console.info("[ui-primitives:button-variants] variant/class assertions passed");
    } catch (err) {
      dumpElementSnapshot("button-variants", element);
      throw err;
    }
  });

  it("merges tailwind utility classes deterministically for shared primitives", () => {
    console.info("[ui-primitives:cn-merge] merging classes: px-2 py-2 | (false) | px-4 | undefined | text-sm");
    const merged = cn("px-2 py-2", false && "hidden", "px-4", undefined, "text-sm");
    if (merged !== "py-2 px-4 text-sm") {
      console.error(`=== [ui-primitives:cn-merge] unexpected merge result ===`);
      console.error(`expected="py-2 px-4 text-sm" actual=${JSON.stringify(merged)}`);
    }
    expect(merged).toBe("py-2 px-4 text-sm");
    console.info(`[ui-primitives:cn-merge] merge result=${JSON.stringify(merged)} (matched expected)`);
  });

  it("configures the shared notifications toaster with the repo defaults", () => {
    console.info("[ui-primitives:notifications] invoking Notifications() to read toaster config");
    const element = Notifications();

    try {
      console.info(
        `[ui-primitives:notifications] config closeButton=${JSON.stringify(element.props.closeButton)} duration=${JSON.stringify(element.props.duration)} position=${JSON.stringify(element.props.position)} offset=${JSON.stringify(element.props.offset)} richColors=${JSON.stringify(element.props.richColors)} expand=${JSON.stringify(element.props.expand)}`,
      );
      expect(element.props.closeButton).toBe(true);
      expect(element.props.duration).toBe(4000);
      expect(element.props.position).toBe("top-right");
      expect(element.props.offset).toBe(96);
      expect(element.props.richColors).toBe(true);
      expect(element.props.expand).toBe(false);
      console.info("[ui-primitives:notifications] toaster default config assertions passed");
    } catch (err) {
      dumpElementSnapshot("notifications", element);
      throw err;
    }
  });
});
