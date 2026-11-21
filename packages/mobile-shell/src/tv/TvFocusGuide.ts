import type { ComponentProps, ComponentType, Ref } from "react";
import { TVFocusGuideView } from "react-native";
import type { TvViewInstance } from "./tvViewInstance";

type TvFocusGuideProps = ComponentProps<typeof TVFocusGuideView> & { ref?: Ref<TvViewInstance> };

/**
 * `TVFocusGuideView` typed with the ref it forwards at runtime: the guide's own native view. `requestTVFocus()` on it
 * moves the focus into the guide, with `autoFocus` onto the view last focused there (so a screen shown again can hand
 * the focus back to the card that left it). react-native-tvos's types leave `ref` out of the guide's props.
 */
export const TvFocusGuide = TVFocusGuideView as unknown as ComponentType<TvFocusGuideProps>;
