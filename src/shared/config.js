/*
 * Vital — shared configuration constants.
 *
 * Time with a watchlisted site as the active tab in the focused window counts
 * against a daily allowance (a user setting, see storage DEFAULT_SETTINGS) that
 * resets at local midnight.
 *
 * Loaded as a classic script in every context (background, popup, options).
 * It attaches everything to `globalThis.Vital` so the other classic scripts can
 * build on it without a module system.
 */
(function (root) {
  "use strict";

  const Vital = (root.Vital = root.Vital || {});

  Vital.CONFIG = Object.freeze({
    defaultAllowanceMin: 30,
    minAllowanceMin: 1,
    maxAllowanceMin: 24 * 60,

    // While a visit is open the background re-observes it this often, recording
    // time and refreshing the toolbar tooltip.
    tickMinutes: 1,
    // Longest stretch counted without an observation (covers a missed tick; caps
    // time counted across sleep/suspend).
    maxUnobservedMs: 3 * 60 * 1000,

    // The popup readout turns to the signal color when this little time is left.
    lowRemainingMs: 5 * 60 * 1000,

    // The first seconds of every visit are free, so closing a tab opened by
    // reflex costs nothing. The in-page toast stays up for exactly this long:
    // its bar runs out when counting starts.
    graceMs: 4 * 1000,

    // How long to keep visit history and per-day usage.
    detailRetentionDays: 30,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
