/**
 * React's JSX runtime with UX-I18N-13 applied: the product names in an HTML element's text are marked
 * `translate="no"` (`withBrandNamesInChildren`). A site opts in with `jsxImportSource: "@space/ui/brand-names"` in
 * its Vite React plugin; everything else is React's own runtime.
 */
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { withBrandNamesInChildren } from "./index";

export { Fragment };
export type { JSX } from "react/jsx-runtime";

export const jsx: typeof reactJsx = (type, props, key) => reactJsx(type, withBrandNamesInChildren(type, props), key);
export const jsxs: typeof reactJsxs = (type, props, key) => reactJsxs(type, withBrandNamesInChildren(type, props), key);
