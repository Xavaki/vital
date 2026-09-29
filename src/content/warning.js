/*
 * Vital — in-page warning toast (spec §5).
 *
 * Injected on demand when a watchlisted visit starts. Renders a small,
 * dismissible toast in the top-right corner inside a shadow root so page styles
 * can't touch it and it can't touch the page. Auto-hides after five seconds.
 * Never traps focus, intercepts typing, covers the page, or plays sound.
 *
 * The background sets `window.__vitalWarning = { remainingMs, allowanceMs }`
 * (same isolated world) just before injecting this file. "Close tab" asks the
 * background to remove the tab, which ends the visit like a normal close.
 */
(function () {
  "use strict";

  const browserApi = window.browser || window.chrome;
  const AUTO_HIDE_MS = 5000;
  const HOST_ID = "vital-warning-host";
  const info = window.__vitalWarning || null;
  delete window.__vitalWarning;

  function fmtMinutes(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return "under a minute";
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  // Only ever one toast; a fresh visit replaces any leftover.
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Keep the host out of layout flow and above page content.
  host.style.cssText = "position:fixed;top:0;right:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    /* Always dark ink so it stays legible on any page; orange edge = Vital. */
    .toast {
      position: fixed; top: 16px; right: 16px;
      width: 300px;
      font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #111113; color: #ededee;
      border: 1px solid #2c2c30;
      border-left: 3px solid #ff7a3d;
      border-radius: 2px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      padding: 12px 14px 0;
      overflow: hidden;
      ${reduceMotion ? "" : "animation: vital-in 140ms ease-out;"}
    }
    @keyframes vital-in {
      from { opacity: 0; transform: translateX(8px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .eyebrow {
      margin: 0 0 6px;
      font: 500 10.5px/1 ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
      letter-spacing: 0.1em; text-transform: uppercase; color: #8b8d93;
    }
    .left {
      margin: 0 0 4px;
      font: 600 20px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
      letter-spacing: -0.01em;
    }
    .left.over { color: #ff7a3d; }
    .msg { margin: 0 0 12px; color: #a1a1a8; }
    .row { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 12px; }
    button {
      font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      cursor: pointer; border-radius: 2px; padding: 7px 12px;
    }
    .close { background: #ededee; color: #111113; border: 1px solid #ededee; }
    .close:hover { background: #ffffff; }
    .dismiss { background: transparent; color: #a1a1a8; border: 1px solid #3a3a40; }
    .dismiss:hover { color: #ededee; border-color: #6e6e76; }
    button:focus-visible { outline: 2px solid #ff7a3d; outline-offset: 2px; }
    /* Hairline showing time until auto-hide. */
    .timer { height: 2px; margin: 0 -14px; background: #2c2c30; }
    .timer span {
      display: block; height: 100%; background: #6e6e76; transform-origin: left;
      ${reduceMotion ? "" : `animation: vital-drain ${AUTO_HIDE_MS}ms linear forwards;`}
    }
    @keyframes vital-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  `;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "alertdialog");
  toast.setAttribute("aria-label", "Vital reminder");

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Vital \u00B7 watchlisted site"; // escaped: host page charset can vary

  // Headline: time left today (or how far over), when the background supplied it.
  const left = document.createElement("p");
  left.className = "left";
  if (info && typeof info.remainingMs === "number") {
    if (info.remainingMs > 0) {
      left.textContent = `${fmtMinutes(info.remainingMs)} left today`;
    } else {
      left.classList.add("over");
      left.textContent = info.remainingMs === 0
        ? "No time left today"
        : `${fmtMinutes(-info.remainingMs)} over today`;
    }
  } else {
    left.hidden = true;
  }

  const msg = document.createElement("p");
  msg.className = "msg";
  msg.textContent = "Time on this tab counts against your daily allowance. Close it?";

  const row = document.createElement("div");
  row.className = "row";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "dismiss";
  dismissBtn.type = "button";
  dismissBtn.textContent = "Dismiss";

  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.type = "button";
  closeBtn.textContent = "Close tab";

  row.append(dismissBtn, closeBtn);
  const timer = document.createElement("div");
  timer.className = "timer";
  timer.append(document.createElement("span"));
  toast.append(eyebrow, left, msg, row, timer);
  shadow.append(style, toast);
  document.documentElement.appendChild(host);

  let hideTimer = null;
  function teardown() {
    if (hideTimer) clearTimeout(hideTimer);
    host.remove();
  }

  // Auto-hide (neutral — costs nothing).
  hideTimer = setTimeout(teardown, AUTO_HIDE_MS);

  dismissBtn.addEventListener("click", teardown);
  closeBtn.addEventListener("click", () => {
    teardown();
    try {
      browserApi.runtime.sendMessage({ type: "closeTabFromWarning" });
    } catch (e) {
      // If messaging fails, fall back to closing via window (best effort).
      window.close();
    }
  });
})();
