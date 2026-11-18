# @space/desktop-shell

Framework-agnostic desktop renderer shell contracts for Space Fleet desktop apps.

Current scope (B1 scaffolding):
- `DesktopPlatformBridge` contract and in-memory test double.
- Theme token contract (`DesktopShellTheme`) and merge helpers.
- Shared auth/runtime service interfaces.
- Shared desktop shell surfaces for:
  - starfield app backdrop (`AppBackdrop` and `useAppPlaybackMark` from `@space/ui`, shared with the Parrot web player)
  - app brand block (`AppBrand` from `@space/ui`, shared with the Parrot web player)
  - composed app top nav shell (`DesktopAppTopNav`)
  - top navigation framing (`DesktopTopNavFrame`)
  - top-nav action shells (`DesktopTopNavIconAction`, `DesktopTopNavTextAction`)
  - top-nav spacing/typography helpers (`desktopTopNavItemClassName`, `desktopTopNavTextActionBaseClassName`)
  - right-side notification tray shell (`DesktopNotificationTray`)
  - startup page shell (`DesktopStartupPage`)
  - startup controls dock (`DesktopStartupControls`)
  - startup card shell for auth/onboarding/recovery (`DesktopStartupCard`)
  - auth-form field/button/prompt chrome (`DesktopAuthForm`)
  - auth card layout (`AuthCardLayout`)
  - widescreen empty-state welcome hero (`DesktopWelcomeHero`)
  - shell notices/error surfaces
  - first-open tour for Badger and Parrot (`@space/desktop-shell/tour`: `DesktopTourHost`, `startDesktopTour`; step 1 a drop modal, steps 2 and 3 on the places marked `data-tour="import-review" | "jobs-panel" | "jobs"`; strings for every language in `src/tour/strings.ts`; UX-TOUR-01..04, PAR-TOUR-01..04)
- Placeholder module boundaries for remaining components/pages/guards.

## Development
- `bun run --cwd packages/desktop-shell typecheck`
- `bun run --cwd packages/desktop-shell test`
