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
  from Firefox never count. There is no pause or manual reset — the only
  way to get more time today is to raise the allowance.
- **Grace period:** the first `graceMs` (4 s) of every visit are free, so
  closing a tab opened out of habit costs nothing. Counting starts when the
  in-page toast disappears.
- **Day boundary:** usage is stored per local day; a visit spanning midnight is
  split between the two days.
- **Over the allowance:** nothing is blocked; the popup, toast and toolbar
  tooltip show how far over you are.
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
  navigation/SPA handling, periodic time recording, toolbar indicator.
- **In-page toast** (§5): a small card with time left (or over) today, a
  "Close tab" button, a dismiss ×, and "Stop seeing this" (opens settings at
  the warning toggle); stays up exactly for the grace period, reduced-motion
  aware.
- **Toolbar indicator:** the icon gains a small orange dot while time is
  being counted (a watchlisted site is in front and its grace period is over);
  hovering the icon shows the time left today.
- **Popup:** live countdown, used vs. allowance, 10-segment meter, a
  counting / grace indicator, a 7-day column chart (overage stacked in the
  signal color, allowance line, hover/focus tooltips, screen-reader table),
  recent visits with duration bars, and "Clear history" (visit list and
  earlier days; today is kept).
- **Options:** daily allowance, site-rule editor, warning toggle, explanation
  and privacy notes.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json`.
3. Open the extension's options, set your allowance and add watchlisted sites —
   adding a site prompts for page access (used for the in-page toast; time is
   counted even if you decline). Then visit the site: the toast shows the time
   left, the toolbar icon gets an orange dot once counting starts, and the popup shows a live countdown.

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
