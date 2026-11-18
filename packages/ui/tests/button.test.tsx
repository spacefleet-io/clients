import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/button";
import { Spinner } from "../src/spinner";

// React 19's `ReactElement` defaults `props` to `unknown`; the Button element tree
// asserted on here only ever carries these props.
type TestProps = {
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  "aria-busy"?: string;
  "aria-label"?: string;
};
type TestElement = React.ReactElement<TestProps>;

const asElement = (node: React.ReactNode): TestElement => {
  if (!React.isValidElement<TestProps>(node)) {
    throw new Error(`expected a React element, got ${JSON.stringify(node)}`);
  }
  return node;
};

const childElements = (el: TestElement): TestElement[] =>
  (Array.isArray(el.props.children) ? el.props.children : [el.props.children]).map(asElement);

// Helper to call .render() on a React.forwardRef component (same pattern as index.test.tsx)
type ForwardRefRenderer<P> = {
  render: (props: P, ref: unknown) => TestElement | null;
};

const renderButton = (props: Record<string, unknown>) =>
  (Button as unknown as ForwardRefRenderer<Record<string, unknown>>).render(props, null);

// Per-suite dump helper: console.error's the shape of a rendered Button element
// so a failed structural assertion shows exactly what was produced. Body wrapped
// in try/catch so a dump failure can never mask the original assertion failure.
const dumpButtonSnapshot = (label: string, element: TestElement | null) => {
  try {
    console.error(`=== [button:${label}] element snapshot ===`);
    if (!element) {
      console.error("element=null");
      return;
    }
    const props = element.props ?? {};
    const kids = Array.isArray(props.children) ? props.children : [props.children];
    console.error(`type=${typeof element.type === "string" ? element.type : (element.type as { displayName?: string; name?: string })?.displayName ?? (element.type as { name?: string })?.name ?? String(element.type)}`);
    console.error(`aria-busy=${JSON.stringify(props["aria-busy"])} disabled=${JSON.stringify(props.disabled)}`);
    console.error(`className=${JSON.stringify(props.className)}`);
    console.error(`child count=${kids.length}`);
    kids.forEach((kid: unknown, i: number) => {
      const k = kid as TestElement | string | null;
      if (k && typeof k === "object" && "type" in k) {
        const kProps = k.props ?? {};
        const kType = k.type;
        console.error(
          `  child[${i}] type=${typeof kType === "string" ? kType : ((kType as { displayName?: string; name?: string })?.displayName ?? (kType as { name?: string })?.name ?? String(kType))} className=${JSON.stringify(kProps.className)} aria-label=${JSON.stringify(kProps["aria-label"])}`,
        );
      } else {
        console.error(`  child[${i}]=${JSON.stringify(k)}`);
      }
    });
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("Button", () => {
  // ── Case a: default render ─────────────────────────────────────────────────
  it("(a) default Button renders children, no aria-busy, not disabled", () => {
    console.info("[button:case-a] rendering default Button with children='Click me'");
    const element = renderButton({ children: "Click me" });
    // default (no pending) renders a <button> element
    if (
      element === null ||
      element!.props.children !== "Click me" ||
      element!.props["aria-busy"] !== undefined ||
      element!.props.disabled !== undefined
    ) {
      dumpButtonSnapshot("case-a-default-render", element);
    }
    expect(element).not.toBeNull();
    expect(element!.props.children).toBe("Click me");
    expect(element!.props["aria-busy"]).toBeUndefined();
    expect(element!.props.disabled).toBeUndefined();
    console.info("[button:case-a] default render assertions passed");
  });

  // ── Case b: pending=true ───────────────────────────────────────────────────
  it("(b) Button with pending=true: aria-busy=true, disabled, spinner rendered, children span has 'invisible'", () => {
    console.info("[button:case-b] rendering pending Button with children='Save'");
    const element = renderButton({ children: "Save", pending: true });

    try {
      expect(element).not.toBeNull();
      const el = element!;
      // Must be a plain button element (not Slot)
      expect(el.type).toBe("button");
      expect(el.props["aria-busy"]).toBe("true");
      expect(el.props.disabled).toBe(true);

      // children: [<span className="invisible">...</span>, <span absolute>...</span>]
      const kids = childElements(el);
      console.info(`[button:case-b] rendered ${kids.length} children (expected invisible-span + overlay-span)`);

      // First child: invisible span preserving width
      const invisibleSpan = kids[0];
      expect(String(invisibleSpan.props.className)).toContain("invisible");
      expect(invisibleSpan.props.children).toBe("Save");

      // Second child: absolute overlay containing the spinner
      const overlaySpan = kids[1];
      // The overlay's child is a <Spinner> element (forwardRef — not yet rendered).
      // Button passes aria-label to Spinner; role="status" is set inside Spinner's own render.
      const spinnerEl = childElements(overlaySpan)[0];
      // Verify it's the Spinner component and carries the default aria-label
      expect(spinnerEl.type).toBe(Spinner);
      expect(spinnerEl.props["aria-label"]).toBe("Loading");
      // Confirm Spinner renders with role="status" in the DOM
      const spinnerHtml = renderToStaticMarkup(spinnerEl);
      console.info(`[button:case-b] spinner static markup=${JSON.stringify(spinnerHtml)}`);
      expect(spinnerHtml).toContain('role="status"');
      expect(spinnerHtml).toContain('aria-label="Loading"');
      console.info("[button:case-b] pending render assertions passed");
    } catch (err) {
      dumpButtonSnapshot("case-b-pending-render", element);
      throw err;
    }
  });

  // ── Case c: custom spinnerLabel ────────────────────────────────────────────
  it("(c) Button with pending + custom spinnerLabel → spinner aria-label matches", () => {
    console.info("[button:case-c] rendering pending Button with custom spinnerLabel='Uploading file'");
    const element = renderButton({ children: "Upload", pending: true, spinnerLabel: "Uploading file" });
    const el = element!;

    try {
      const kids = childElements(el);
      const overlaySpan = kids[1];
      const spinnerEl = childElements(overlaySpan)[0];

      console.info(`[button:case-c] resolved spinner aria-label=${JSON.stringify(spinnerEl.props["aria-label"])}`);
      expect(spinnerEl.type).toBe(Spinner);
      expect(spinnerEl.props["aria-label"]).toBe("Uploading file");
      console.info("[button:case-c] custom spinnerLabel assertions passed");
    } catch (err) {
      dumpButtonSnapshot("case-c-custom-spinner-label", element);
      throw err;
    }
  });

  // ── Case d: asChild + pending → throws in dev ──────────────────────────────
  it("(d) Button with asChild=true + pending=true → throws in dev (NODE_ENV !== 'production')", () => {
    // process.env.NODE_ENV is 'test' in vitest — not 'production' — so the guard fires.
    console.info(`[button:case-d] expecting render to throw; NODE_ENV=${JSON.stringify(process.env.NODE_ENV)}`);
    try {
      expect(() =>
        renderButton({ children: "Go", asChild: true, pending: true })
      ).toThrow("Button: `asChild` combined with `pending` is not supported");
      console.info("[button:case-d] guard threw as expected");
    } catch (err) {
      // Assertion failed → the guard did NOT throw. Capture what it produced instead.
      console.error("=== [button:case-d-asChild-pending-no-throw] guard did not throw — capturing produced element ===");
      let produced: TestElement | null = null;
      try {
        produced = renderButton({ children: "Go", asChild: true, pending: true });
      } catch (renderErr) {
        console.error(`(re-render to capture also threw: ${renderErr instanceof Error ? renderErr.message : String(renderErr)})`);
      }
      dumpButtonSnapshot("case-d-asChild-pending-no-throw", produced);
      throw err;
    }
  });
});
