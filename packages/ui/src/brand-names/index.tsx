/**
 * UX-I18N-13 on the web: a product name is never translated, not even by the browser ("Translate this page" turned
 * "Badger" into "Blaireau"). Every occurrence is wrapped in `<span translate="no" class="notranslate">`, which Chrome,
 * Safari, Edge and Google Translate all leave as written; the rest of the page still translates.
 *
 * The sites do not call this by hand: they compile their JSX with `jsxImportSource: "@space/ui/brand-names"`
 * (`./jsx-runtime`), which runs {@link withBrandNamesInChildren} on every HTML element, so a name coming from a
 * translation file, a shared component or hard-coded text is marked the same way. `<Brand>` and
 * {@link withBrandNames} are for text that reaches the DOM some other way.
 *
 * Built with `createElement`, not JSX: this file is compiled with the runtime that calls it.
 */
import { cloneElement, createElement, Fragment, isValidElement, type ReactNode } from "react";
import { splitBrandNames } from "@space/shared/brandNames";

/** The attributes that keep a name out of browser and mail-client translation. */
export const NO_TRANSLATE_PROPS = { translate: "no", className: "notranslate" } as const;

/** One product name, never translated by the browser. */
export const Brand = ({ children }: { children: ReactNode }) => createElement("span", NO_TRANSLATE_PROPS, children);

const brandSpan = (name: string, key?: string | number) => createElement("span", { ...NO_TRANSLATE_PROPS, key }, name);

// `key` is set when the text sits in an array of children, where each element needs one.
const markText = (text: string, key?: string): ReactNode => {
  const parts = splitBrandNames(text);
  if (!parts.some((part) => part.brand)) return text;
  if (parts.length === 1) return brandSpan(text, key);
  return createElement("span", { key }, ...parts.map((part, index) => (part.brand ? brandSpan(part.text, index) : part.text)));
};

/**
 * `text` with each product name marked `translate="no"`; the same string when it holds none. A text with other words
 * stays one `<span>` around the pieces, so it is still one item in a flex or grid parent and lays out as before.
 */
export const withBrandNames = (text: string): ReactNode => markText(text);

// Elements whose children must stay plain text (a <span> there is invalid or ignored), and SVG text.
const TEXT_ONLY_ELEMENTS: Record<string, true> = {
  title: true,
  option: true,
  optgroup: true,
  textarea: true,
  style: true,
  script: true,
  noscript: true,
  template: true,
  iframe: true,
  text: true,
  tspan: true,
  textPath: true,
  desc: true,
};

// A component's children are its own business (a string can be data, a label, a default value), except a link's: a
// router `<Link to>` or `<NavLink to>` renders its text in an `<a>` built outside this runtime.
const isLinkComponent = (type: unknown, props: object): boolean =>
  typeof type !== "string" && ("to" in props || "href" in props);

/**
 * The props of an HTML element (`type` a tag name) or a link component with the product names in its text children
 * marked `translate="no"`; the same object when there is nothing to mark. Other components are left alone: the HTML
 * element they render passes through here in turn.
 */
export const withBrandNamesInChildren = <P,>(type: unknown, props: P): P => {
  if (typeof props !== "object" || props === null) return props;
  if (typeof type === "string" ? TEXT_ONLY_ELEMENTS[type] : !isLinkComponent(type, props)) return props;
  if (!("children" in props) || ("translate" in props && props.translate === "no")) return props;
  const { children } = props;
  if (typeof children === "string") {
    const marked = markText(children);
    return marked === children ? props : ({ ...props, children: marked } as P);
  }
  if (!Array.isArray(children)) return props;
  let changed = false;
  const next = children.map((child: unknown, index) => {
    if (typeof child !== "string") return child;
    const marked = markText(child, `brand-${index}`);
    if (marked !== child) changed = true;
    return marked;
  });
  return changed ? ({ ...props, children: next } as P) : props;
};

/**
 * `node` with the product names marked in every string it holds, at any depth of HTML elements. For trees built by
 * `React.createElement`/`cloneElement` rather than the JSX runtime, such as react-i18next's `<Trans>` output.
 */
export const markBrandNamesInTree = (node: ReactNode, key?: string): ReactNode => {
  if (typeof node === "string") return markText(node, key);
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((child: ReactNode, index) => {
      const marked = markBrandNamesInTree(child, `brand-${index}`);
      if (marked !== child) changed = true;
      return marked;
    });
    return changed ? next : node;
  }
  if (!isValidElement<{ children?: ReactNode; translate?: string }>(node)) return node;
  const { type, props } = node;
  if (typeof type === "string" ? TEXT_ONLY_ELEMENTS[type] : !isLinkComponent(type, props)) return node;
  if (props.translate === "no") return node;
  if (props.children === undefined) return node;
  const children = markBrandNamesInTree(props.children);
  return children === props.children ? node : cloneElement(node, undefined, children);
};

/**
 * The parent `<Trans>` renders its text into: marks the names and renders no element of its own. `<Trans>` builds its
 * text with `createElement`, out of the JSX runtime's reach.
 */
export const BrandNames = ({ children }: { children?: ReactNode }) =>
  createElement(Fragment, null, markBrandNamesInTree(children));

/**
 * react-i18next's `defaultTransParent` for the sites (`react: { defaultTransParent: BRAND_NAMES_TRANS_PARENT }`).
 * react-i18next types the option as a tag name, but passes it straight to `createElement`, so a component works.
 */
export const BRAND_NAMES_TRANS_PARENT = BrandNames as unknown as string;
