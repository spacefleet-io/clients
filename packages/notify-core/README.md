# @space/notify-core

The one notification system every SpaceFleet app shares (spec "Notices", UX-NOTICE-01 to 14):
plain TypeScript with no React, DOM or React Native, so the computer apps, the web players, the website, the phone
and TV apps, the api and the Kodi and Jellyfin text generators all use the same rules.

- `kinds`: the five kinds (`confirmation`, `headsUp`, `lasting`, `decision`, `job`), their timings (4 s, 8 s, 8 s idle
  with an action, no timer for one-time TV messages and decisions), what goes to the history, how many fit on screen
  per surface.
- `queue`: the on-screen line. A notice with the key of one already shown replaces it in place with a fresh timer;
  hover or focus pauses it; the rest wait their turn.
- `history`: the last 50 notices behind the bell, stored with text keys (not words) so they follow a language change,
  replace-on-key moving an entry back to the top as unread, the unread count and its `9+` badge, account news merged
  with this device's entries, `localStorage` and AsyncStorage backends, and a reader for the old desktop history.
- `texts`: the shared words in English, French, Dutch, German and Spanish (bell, history, default titles, job and
  account notices, TV hints), an i18next merge helper and a small translator for places without i18next.
- `hostMapping`: which Kodi and Jellyfin pop-up shows each kind.
- `a11y`: the live-region politeness and role for each level.

## Non-goals
- No drawing: each surface keeps its own toast, card, bell and history screen, and its own React hook around the
  queue and the history.
- No transport: account news comes from the api; this package only merges it.

## Tests
- `bun run --cwd packages/notify-core test`
