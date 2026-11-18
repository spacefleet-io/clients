import { StrictMode, type ComponentType, type ReactElement, type ReactNode } from "react";
import { act } from "react";
import {
  render as rtlRender,
  renderHook as rtlRenderHook,
  type RenderHookOptions,
  type RenderHookResult,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";

type StrictOption = { strict?: boolean };

/**
 * Drop-in replacement for @testing-library/react's `render` that wraps the
 * tree in React `<StrictMode>` by default. Production (`apps/badger/desktop/
 * src/renderer/src/main.tsx:20`) already wraps in StrictMode — tests should
 * match so dev-mode double-effect surprises are caught before shipping.
 *
 * Opt out per test with `{ strict: false }` when the component legitimately
 * cannot tolerate double-invoke (rare — prefer fixing the component first).
 */
export function render(
  ui: ReactElement,
  options: (RenderOptions & StrictOption) | undefined = undefined,
): RenderResult {
  const { strict = true, ...rest } = options ?? {};
  const tree = strict ? <StrictMode>{ui}</StrictMode> : ui;
  return rtlRender(tree, rest);
}

/**
 * StrictMode-by-default counterpart to `renderHook` from
 * @testing-library/react.
 *
 * Implementation note: `@testing-library/react@16` `renderHook` does not
 * propagate StrictMode dev-mode double-effect behaviour through its
 * `wrapper` prop (confirmed empirically; matches pre-v14 behaviour). We
 * reimplement the hook host via `render` above so StrictMode semantics are
 * preserved.
 */
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: (RenderHookOptions<Props> & StrictOption) | undefined = undefined,
): RenderHookResult<Result, Props> {
  const { strict = true, wrapper: UserWrapper, initialProps, ...rest } = options ?? {};
  if (!strict) {
    return rtlRenderHook(callback, { ...rest, wrapper: UserWrapper, initialProps } as RenderHookOptions<Props>);
  }

  const result: { current: Result } = { current: undefined as unknown as Result };
  let currentProps = initialProps as Props;

  const Host = ({ hookProps }: { hookProps: Props }) => {
    result.current = callback(hookProps);
    return null;
  };

  const Wrapped: ComponentType<{ hookProps: Props }> = ({ hookProps }) => {
    const inner = <Host hookProps={hookProps} />;
    if (UserWrapper) {
      const UW = UserWrapper as unknown as ComponentType<{ children: ReactNode }>;
      return <UW>{inner}</UW>;
    }
    return inner;
  };

  const { rerender: baseRerender, unmount } = render(
    <Wrapped hookProps={currentProps} />,
    { strict: true, ...rest },
  );

  const rerender = (nextProps?: Props) => {
    if (nextProps !== undefined) currentProps = nextProps;
    baseRerender(<Wrapped hookProps={currentProps} />);
  };

  return { result, rerender, unmount } as RenderHookResult<Result, Props>;
}

export * from "@testing-library/react";
// Re-export `act` explicitly so test files can `await act(async () => {...})`
// without also importing from react-dom/test-utils.
export { act };
