/** The development twin of `./jsx-runtime` (Vite's dev server compiles JSX to `jsxDEV`). */
import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { withBrandNamesInChildren } from "./index";

export { Fragment };
export type { JSX } from "react/jsx-dev-runtime";

export const jsxDEV: typeof reactJsxDEV = (type, props, key, isStatic, source, self) =>
  reactJsxDEV(type, withBrandNamesInChildren(type, props), key, isStatic, source, self);
