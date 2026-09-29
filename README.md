# Vital

A Firefox WebExtension that gives distracting sites a **daily time allowance**.
Time counts only while a watchlisted site is the active tab in the focused
Firefox window; it comes off today's allowance, which resets at local midnight.
A watchlist, **not** a blocker — running out just shows you're over. All data
stays on your device — no account, no network requests, no telemetry.

See [`Firefox Vital Extension — Design Spec.md`](./Firefox%20Vital%20Extension%20—%20Design%20Spec.md)
for the original product spec.

## How time is counted (differs from the spec)

The spec's point rewards and penalties have been replaced by a time allowance:

- **Allowance:** set on the options page (default 30 min/day, shared by all
  watchlisted sites). Changes apply immediately, including to today.
- **What counts:** foreground time only — the site's tab is active *and* its
  window is focused. Background tabs (e.g. music), other windows, and time away
  from Firefox never count. Pausing stops counting.
- **Day boundary:** usage is stored per local day; a visit spanning midnight is
  split between the two days.
- **Over the allowance:** nothing is blocked; the badge, popup and toast show
  how far over you are, in the signal color.
- **Safety caps:** while a visit is open the background re-observes it every
  minute (`tickMinutes`). An unobserved stretch longer than `maxUnobservedMs`
  (3 min; e.g. the machine slept with the site in front) counts only that much.
  After a browser restart or extension reload, the open visit ends at its last
  observation — unobserved time is never guessed.

Defaults live in `src/shared/config.js`.

## Status

- Manifest, permissions, and the non-persistent background event page.
- Pure hostname matcher (§4) and time accounting (`src/shared/usage.js`).
- Local storage (§6): site rules, settings (incl. allowance), per-day usage,
  visit history, and the open visit (survives the event page being unloaded).
- **Visit state machine** (`src/background/visits.js`): tab/window event
  wiring, serialized handling, close vs. focus-away race resolution,
  navigation/SPA handling, periodic time recording, pause, toolbar badge.
- **In-page toast** (§5): shows time left (or over) today with Close/Dismiss,
  five-second auto-hide, reduced-motion aware.
- **Toolbar badge:** time left today while you're on a watchlisted site
  (`12m`, `1h05`, `-4m`), in the signal color when ≤ 5 min or over; `⏸` when
  paused; empty otherwise.
- **Popup:** live countdown, used vs. allowance, 10-segment meter, a
  "counting" indicator, recent visits with durations, pause, clear history /
  reset today.
- **Options:** daily allowance, site-rule editor, warning toggle, explanation
  and privacy notes.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json`.
3. Open the extension's options, set your allowance and add watchlisted sites —
   adding a site prompts for page access (used for the in-page toast; time is
   counted even if you decline). Then visit the site: the toast shows the time
   left, the toolbar badge counts down, and the popup shows a live countdown.

Temporary add-ons are removed when Firefox restarts. Note: after loading, the
active tab is `about:debugging` — switch to (or open) a watchlisted tab.

## Run the tests

Dependency-free tests:

```sh
node test/matcher.test.js    # hostname normalization + matching (§4, §8.1)
node test/usage.test.js      # per-day accounting, midnight split, sleep cap, formatting
node test/visits.test.js     # state machine + time counting vs. a fake browser API
```

## Layout

```
manifest.json
src/
  shared/      config.js, usage.js, matcher.js, storage.js   (classic scripts → globalThis.Vital)
  background/  visits.js                                     (event page)
  content/     warning.js                                    (in-page toast)
  options/     options.html / .css / .js
  popup/       popup.html / .css / .js
icons/         icon.svg (dark ink, light themes) · icon-light.svg (dark themes)
test/          matcher / usage / visits tests
```
