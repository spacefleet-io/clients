// Dark-only. Light mode was removed app-wide; the `mode` and `theme` fields are
// retained on the settings shape so existing call sites keep working, but both
// are constrained to a single literal. If a stored `light` value exists from a
// prior release it is coerced to `dark` on next read — no migration step needed.

export type UiMode = "dark";
export type UiTheme = "space";

type UiThemeSettings = {
  mode: UiMode;
  theme: UiTheme;
};

const STORAGE_KEY = "sf-client-ui";

export function getInitialTheme(): UiThemeSettings {
  return { mode: "dark", theme: "space" };
}

export function applyTheme(_settings?: UiThemeSettings) {
  document.documentElement.dataset.theme = "space";
  document.documentElement.dataset.mode = "dark";
  document.documentElement.classList.add("dark");
}

export function persistTheme(_settings?: UiThemeSettings) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ mode: "dark", theme: "space" })
  );
}
