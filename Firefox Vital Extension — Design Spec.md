# Vital — Firefox extension design spec

**Status:** v0.1, ready for an MVP implementation  
**Platform:** Firefox desktop WebExtension  
**Goal:** Make the moment of opening a distracting site a small, recoverable decision. Reward closing the tab promptly; preserve a neutral way to leave it in the background.

## 1. Product principles

- The list is a **watchlist**, not a hard blocker. The site remains usable.
- Reward the observable action of closing the distracting tab, not a claim about productivity.
- Switching tabs, switching windows, or leaving Firefox is neutral. Background music must not cost points.
- Feedback is brief, kind, and dismissible. No shame copy, streak resets, sounds, or full-screen interruption in the MVP.
- All event data stays on the device. No account, analytics service, or page-content collection.

## 2. Definitions and defaults

| Term | Meaning |
| --- | --- |
| Watchlisted site | A hostname the user explicitly added, including its subdomains by default. |
| Foreground | The tab is selected **and** its Firefox window is focused. |
| Visit | A foreground episode on a watchlisted site, beginning when a matching top-level URL becomes active. |
| Active time | Elapsed wall-clock time spent in foreground during that episode; time in a background tab or unfocused window is excluded. |
| Close | The tab is removed while that visit is still foreground. The in-page **Close tab** button counts the same as a normal tab close. |
| Focus away | Another tab/window becomes active, Firefox loses focus, or the current tab navigates to a nonmatching site. This ends the visit neutrally. |

**Recommended MVP defaults:** reward window 30 seconds; linger threshold 90 seconds; 30-minute reward cooldown per site; daily earning cap 30 points; daily loss cap 10 points. These values are configuration constants in v0.1 and user-adjustable in a later release.

## 3. Visit state machine

1. On a matching top-level URL becoming foreground, create one visit with a unique ID, tab ID, normalized hostname, start timestamp, and `foregroundStartedAt`. Log `visit_started`. A tab opened in the background does not start a visit until activated.
2. Show one temporary in-page warning per visit. Its appearance or failure to appear does not affect timing or scoring.
3. If a new matching hostname loads in the same foreground tab, finish the old visit neutrally and start a new one. Same-document URL changes and reloads on the same hostname do not start another visit or reset its clock.
4. On focus away, finalize the visit immediately as `focused_away`, recording active duration and zero points for that transition. Do not keep a reward opportunity open while the tab is backgrounded.
5. If a watchlisted tab is activated again, start a **new** visit. Reward cooldown prevents repeated tab toggling from farming points. Show the warning again, at most once for that new visit.
6. On tab removal while foreground, finalize as `closed`; award points according to active duration. On removal after a visit was finalized by focus away, do nothing further.
7. At 90 seconds of uninterrupted foreground time, apply one `linger` debit to the open visit, at most once. Closing later does not cause another debit. A focus-away before the threshold is neutral and does not trigger it. If a delayed timer fires after focus was lost, recheck the visit state and do not debit.
8. On browser shutdown, extension reload, crash, or ambiguous event ordering, finalize open visits as `interrupted` with no new points. Never infer a close from a missing tab. Persist enough visit state to reconcile on startup, and make all finalization and debit operations idempotent by visit ID and event type.

**Scoring table** (defaults; measured from visit start to close, provided the visit never ended by focus away):

| Foreground close time | Award |
| --- | ---: |
| `0 <= t <= 5s` | +5 vital |
| `5s < t <= 15s` | +3 vital |
| `15s < t <= 30s` | +1 vital |
| `t > 30s` | 0 vital |
| Foreground for `>= 90s` | −2 vital once, at threshold |
| Any focus-away transition | 0 vital for the transition |

The debit and close award are separate ledger entries. A visit that lingers past 90 seconds cannot earn the close award. Vital balance has a floor of zero; a zero-balance debit is logged as a would-be debit with `appliedDelta: 0`. Award only the first eligible close for each normalized site in a rolling 30-minute window, and cap total awarded points at 30 per local calendar day. Cap actual losses at 10 per local day. Capped/cooldown closes are still logged as closes with `appliedDelta: 0`. Daily caps reset at local midnight; a timezone change follows the device's current local date.

**Examples:** open and close a listed site in 4 seconds: +5. Open YouTube, switch to a work tab after 12 seconds, and leave music playing: 0, with a 12-second neutral visit. Return to YouTube later: a new visit starts. Stay on a listed site for 100 seconds: one −2 debit at roughly 90 seconds; closing at 100 seconds adds 0. Open a listed page in the background and never select it: no visit.

## 4. Watchlist and matching

- Options page: add, edit, remove, enable/disable, and search hostname rules. Accept either `example.com` or a pasted URL; show the normalized hostname before saving. Require explicit confirmation of any pasted URL's extracted hostname.
- Match the exact hostname plus subdomains (`example.com`, `www.example.com`, `m.example.com`), never lookalikes such as `notexample.com`. Offer an **exact host only** toggle per rule. Lowercase and normalize using the URL parser; reject invalid hosts, duplicates, schemes other than HTTP(S), IP wildcard patterns, and bare public suffixes.
- Paths, query strings, ports, and page contents are ignored in MVP. If `youtube.com` is listed, every HTTP(S) page on that host family counts. Explain this beside the form.
- Exclude extension pages and Firefox internal pages. If an in-page warning cannot be injected into a browser-restricted page, keep logging and toolbar feedback if URL access is available; show a small `warningUnavailable` indicator in the visit detail.
- Editing a rule affects new visits. An already-open visit keeps the rule and scoring snapshot it began with.

## 5. Feedback and screens

### In-page warning

Within about one second of detection, render a small, high-contrast toast in the page's top-right corner. Suggested copy: **“You marked this site as distracting. Want to close this tab?”** Actions: **Close tab** and **Dismiss**. It auto-hides after five seconds. Dismiss and timeout do not cost points. Never cover a large part of the page, trap focus, intercept typing, or play sound. Use a shadow root or isolated styling and a high z-index; provide an accessible label and visible keyboard focus. Respect reduced-motion preferences.

### Toolbar action

The toolbar icon is the persistent entry point. On an award, play a restrained 0.8–1.2-second frame sequence (for example, a small leaf brightens) by changing the icon, and briefly show a `+5`, `+3`, or `+1` badge. Restore the normal icon/badge afterward, including after an interrupted animation. If icon-frame timing is unreliable, the badge and a static success frame are an acceptable fallback. A loss uses a static muted `−2` badge, without a celebratory animation. If rewards arrive close together, show the latest delta and avoid overlapping animations.

### Popup

Show current vital balance, today's earned/lost points, and a compact “recent visits” list (site, start time, active duration, close/focus-away/linger outcome, point change). Include a link to manage sites and a pause toggle. The pause toggle stops new tracking and warnings; finalizes open visits neutrally. Its state is conspicuous in the icon and popup. Include a way to delete history and reset the balance, with confirmation.

### Options

Show the watchlist and matching rules, a short explanation of scoring, privacy controls, and a **Test warning** action on a permitted test page. Let users disable the in-page warning and reward animation separately. Keep the scoring defaults fixed in MVP; add adjustable windows, point amounts, cooldown, and caps after observing usability.

## 6. Data and privacy

Use local extension storage. Suggested records:

```ts
type SiteRule = { id: string; host: string; includeSubdomains: boolean; enabled: boolean };
type Visit = {
  id: string; tabId: number; host: string; startedAt: number;
  foregroundStartedAt: number; endedAt?: number; activeMs?: number;
  outcome?: 'closed' | 'focused_away' | 'navigated' | 'interrupted';
  warningShown?: boolean; lingerDebited?: boolean;
};
type LedgerEntry = {
  id: string; visitId: string; at: number;
  reason: 'quick_close' | 'linger'; nominalDelta: number;
  appliedDelta: number; suppression?: 'cooldown' | 'daily_cap' | 'zero_floor';
};
```

Store the hostname, timestamps, outcomes, and point ledger; do **not** store full URLs, page titles, queries, or browsing content. Balance is the sum of applied ledger deltas or a transactionally maintained snapshot derived from it. Keep visits and ledger for 30 days by default and prune old detail, while retaining the balance. The user can clear detail or reset everything. Private browsing is excluded in MVP; do not request private-window access. No network requests or telemetry.

## 7. Firefox implementation notes

- Target Firefox desktop with Manifest V3 and `background.scripts` as a non-persistent event page. Register listeners at module top level. Do not assume a continuously running background timer. Firefox's MV3 background model uses event pages. [MDN background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- Track tab selection/URL/removal and browser-window focus with `tabs.onActivated`, `tabs.onUpdated`, `tabs.onRemoved`, and `windows.onFocusChanged`; query a tab when activation arrives before its URL. The `tabs` permission (or matching host permissions) is needed to read `Tab.url`. [MDN tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs) · [MDN activation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onActivated)
- Inject the warning through a minimal content script with the necessary `scripting` and host permission strategy. The watchlist is user-defined: choose a permission strategy that actually covers newly added sites, handle denied grants clearly, and keep tab-based logging independent of injection. Content scripts require host permissions to run. [MDN content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- Use `browser.action.setIcon()` and badge APIs for icon feedback. Animate by swapping packaged static frames, not by expecting an animated GIF to play in the toolbar. [MDN action API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action)
- For the linger deadline, persist `startedAt` and pending state. Schedule a wake-up via `alarms` and recheck foreground state and elapsed time before debiting; also reconcile deadlines whenever a tab/window event or popup wake-up occurs. Timer precision may vary, so display approximate durations and test the actual Firefox version. [MDN alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms) · [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
- Serialize state changes (one reducer/event queue or equivalent) so a near-simultaneous activation and removal cannot score twice. Use event timestamps from the extension's monotonic observation where available, persisted wall-clock timestamps for recovery, and guard negative/implausible durations caused by clock changes.

## 8. MVP acceptance scenarios

1. Adding `youtube.com` matches `www.youtube.com` and `m.youtube.com`, not `fakeyoutube.com`; exact-host mode excludes subdomains.
2. Foreground opening triggers one warning and one visit; reload or same-host SPA navigation does not reset the timer.
3. Close at 4, 12, 25, and 45 seconds produces +5, +3, +1, and 0 respectively, subject to caps and cooldown.
4. Switching away at 12 seconds produces 0; closing the now-background YouTube tab later produces no award or loss.
5. A background tab starts no visit until activated. Moving Firefox out of focus at 20 seconds ends its visit neutrally.
6. Staying foreground past 90 seconds debits once; switching away before the threshold never debits, even if the background tab stays open for hours.
7. Rapid reactivation and close on the same site within 30 minutes logs the visit but gives 0 due to cooldown.
8. Near-simultaneous close/focus events create one terminal outcome and at most one award. Startup after a crash creates no guessed close award.
9. A site whose content script cannot run still logs a matching foreground visit and displays a graceful warning-unavailable state.
10. Pausing suppresses new visits, warnings, and score changes. Clear-history and reset controls do what their labels say. Private tabs remain untracked.

## 9. Build sequence

1. Manifest, permissions, site rule editor, local storage model, and URL matcher.
2. Visit reducer and tab/window event wiring; test edge cases and idempotency.
3. Scoring ledger, cooldown/caps, linger wake-up and restart reconciliation.
4. In-page toast, toolbar feedback, popup/history, pause/reset controls.
5. Manual Firefox checks on ordinary sites, background audio, restricted pages, multiple windows, close races, and browser restart.

## 10. Later decisions

- Tune thresholds and points after trying the extension for a week. The initial numbers are product hypotheses, not behavioral evidence.
- Consider an optional **focus session** mode, achievements for cumulative quick closes, and self-set goals. Avoid streak loss and escalating penalties until the core loop feels helpful.
- Consider path-specific rules only if whole-host matching proves too coarse.
- Decide whether data export and Firefox Sync are useful after the local-only MVP.
