/*
 * Behavioral tests for the visit state machine and time accounting, run
 * against a fake `browser` API. "Suspending" the event page is simulated by
 * booting a fresh copy of the background scripts over the same persisted
 * storage; elapsed time is simulated by moving the stored open visit's
 * timestamps into the past before such a wake-up.
 * Run: node test/visits.test.js
 */
const path = require("path");

const SCRIPTS = [
  "src/shared/config.js",
  "src/shared/usage.js",
  "src/shared/matcher.js",
  "src/shared/storage.js",
  "src/background/visits.js",
].map((p) => path.join(__dirname, "..", p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 400; // > reconcile debounce
const M = 60 * 1000;

function makeEvent() {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener() {}, fire: (...a) => ls.map((f) => f(...a)) };
}

function makeBrowser(store, world) {
  const b = {
    storage: {
      onChanged: makeEvent(),
      local: {
        async get(keys) {
          const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const out = {};
          for (const k of ks) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = structuredClone(v);
          }
          b.storage.onChanged.fire(changes, "local");
        },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    tabs: {
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      async query({ active, windowId }) {
        return world.tabs.filter((t) => t.windowId === windowId && (!active || t.active)).map((t) => ({ ...t }));
      },
      async remove() {},
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: makeEvent(),
      async getLastFocused() { return { id: world.focusedWindow, focused: world.focusedWindow !== -1 }; },
    },
    alarms: {
      onAlarm: makeEvent(),
      async create(name, info) { world.alarms[name] = info; },
      async clear(name) { delete world.alarms[name]; },
      async getAll() { return Object.keys(world.alarms).map((name) => ({ name })); },
    },
    scripting: { async executeScript(opts) { world.injected.push(opts.files ? "file" : "info"); return []; } },
    action: {
      async setBadgeText({ text }) { world.badge.text = text; },
      async setBadgeBackgroundColor({ color }) { world.badge.color = color; },
      async setTitle({ title }) { world.badge.title = title; },
    },
    runtime: { onMessage: makeEvent(), onStartup: makeEvent(), onInstalled: makeEvent() },
  };
  return b;
}

/** Load a fresh copy of the background scripts (a new event-page lifetime). */
function boot(store, world) {
  const browser = makeBrowser(store, world);
  globalThis.browser = browser;
  delete globalThis.Vital;
  for (const s of SCRIPTS) {
    delete require.cache[require.resolve(s)];
    require(s);
  }
  return browser;
}

function freshWorld() {
  return {
    focusedWindow: 1,
    alarms: {},
    injected: [],
    badge: {},
    tabs: [
      { id: 10, windowId: 1, active: true, url: "https://web.whatsapp.com/" },
      { id: 11, windowId: 1, active: false, url: "https://example.org/" },
    ],
  };
}
function freshStore(extra = {}) {
  return {
    rules: [{ id: "r1", host: "web.whatsapp.com", includeSubdomains: true, enabled: true }],
    settings: { paused: false, warningEnabled: true, dailyAllowanceMin: 30 },
    ...extra,
  };
}
function activate(world, tabId) {
  for (const t of world.tabs) if (t.windowId === 1) t.active = t.id === tabId;
}
function closeTab(world, b, tabId) {
  world.tabs = world.tabs.filter((t) => t.id !== tabId);
  b.tabs.onRemoved.fire(tabId, {});
}
/** Pretend the open visit has been running (unrecorded) for `ms`. */
function backdate(store, ms) {
  store.openVisit.startedAt -= ms;
  store.openVisit.countedUntil -= ms;
}

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.error("FAIL:", label); } }
const lastVisit = (store) => (store.visits || []).at(-1);
const todayKey = () => globalThis.Vital.usage.dateKey(Date.now());
const usedToday = (store) => (store.usage && store.usage[todayKey()]) || 0;
const near = (actual, expected, tol = 2000) => Math.abs(actual - expected) <= tol;

(async () => {
  // A. Visit starts in front; a quick close records its (short) time.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    ok(store.openVisit && store.openVisit.host === "web.whatsapp.com", "A: visit starts on foreground watchlisted tab");
    ok(world.alarms["vital-tick"], "A: tick alarm running during the visit");
    ok(world.injected.join() === "info,file", "A: toast gets its numbers, then is injected");
    closeTab(world, b, 10);
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "closed", "A: outcome closed");
    ok(usedToday(store) > 0 && usedToday(store) < 2000, `A: short visit records its time (${usedToday(store)}ms)`);
    ok(!store.openVisit && !world.alarms["vital-tick"], "A: no open visit, tick stopped");
    ok(world.badge.text === "", "A: badge cleared off-site");
  }

  // B. Close after the event page was unloaded: all foreground time counts.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    backdate(store, 2 * M);
    const b2 = boot(store, world); // page unloaded while idle, now waking
    closeTab(world, b2, 10);
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "closed", `B: close after wake is 'closed' (got ${lastVisit(store).outcome})`);
    ok(near(usedToday(store), 2 * M), `B: 2 min in front → 2 min used (${usedToday(store)}ms)`);
    ok(near(lastVisit(store).activeMs, 2 * M), "B: visit duration matches");
  }

  // C. The periodic tick records time while the visit stays open, and the badge counts down.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    backdate(store, 1 * M);
    const b2 = boot(store, world);
    await sleep(SETTLE);
    b2.alarms.onAlarm.fire({ name: "vital-tick" });
    await sleep(SETTLE);
    ok(near(usedToday(store), 1 * M), `C: tick records 1 min (${usedToday(store)}ms)`);
    ok(store.openVisit && near(store.openVisit.countedUntil, Date.now()), "C: visit still open, recorded up to now");
    ok(world.badge.text === "28m" || world.badge.text === "29m", `C: badge shows time left (${world.badge.text})`);
  }

  // D. Switching tabs stops the clock; closing the background tab later adds nothing.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    backdate(store, 3 * M);
    const b2 = boot(store, world);
    activate(world, 11);
    b2.tabs.onActivated.fire({ tabId: 11, windowId: 1 });
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "focused_away", "D: switching away ends the visit");
    const afterSwitch = usedToday(store);
    ok(near(afterSwitch, 3 * M), `D: foreground time recorded (${afterSwitch}ms)`);
    await sleep(600);
    closeTab(world, b2, 10);
    await sleep(SETTLE);
    ok(usedToday(store) === afterSwitch, "D: background time and the later close add nothing");
    ok(store.visits.length === 1, "D: no further visit recorded");
    ok(b, "D: (first boot kept for symmetry)");
  }

  // E. Firefox losing focus ends the visit even though the tab stays active.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    world.focusedWindow = -1;
    b.windows.onFocusChanged.fire(-1);
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "focused_away" && !store.openVisit, "E: leaving Firefox ends the visit");
    const used = usedToday(store);
    await sleep(600);
    ok(usedToday(store) === used, "E: no time counted while Firefox is unfocused");
    world.focusedWindow = 1;
    b.windows.onFocusChanged.fire(1);
    await sleep(SETTLE);
    ok(store.openVisit && store.visits.length === 1, "E: coming back starts a new visit");
  }

  // F. Machine slept with the site in front: at most maxUnobservedMs counts.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    const { maxUnobservedMs } = globalThis.Vital.CONFIG;
    backdate(store, 8 * 60 * M);
    const b2 = boot(store, world);
    b2.windows.onFocusChanged.fire(1); // woke up, Firefox focused again
    await sleep(SETTLE);
    ok(near(usedToday(store), maxUnobservedMs), `F: 8h asleep counts only ${maxUnobservedMs / M} min (${usedToday(store)}ms)`);
  }

  // G. Browser restart: the open visit is interrupted and unobserved time isn't guessed.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    const oldId = store.openVisit.id;
    backdate(store, 2 * M);
    const b2 = boot(store, world);
    b2.runtime.onStartup.fire();
    await sleep(SETTLE);
    ok(store.visits.some((v) => v.id === oldId && v.outcome === "interrupted"), "G: open visit interrupted on startup");
    ok(usedToday(store) < 2000, `G: unobserved time not counted (${usedToday(store)}ms)`);
    ok(store.openVisit && store.openVisit.id !== oldId, "G: still-foreground tab starts a fresh visit");
  }

  // H. Close race: activation of the next tab arrives before onRemoved.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    world.tabs = world.tabs.filter((t) => t.id !== 10);
    activate(world, 11);
    b.tabs.onActivated.fire({ tabId: 11, windowId: 1 });
    b.tabs.onRemoved.fire(10, {});
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "closed", `H: close wins the race (got ${lastVisit(store).outcome})`);
    ok(store.visits.length === 1, `H: exactly one terminal outcome (${store.visits.length})`);
  }

  // I. Pausing ends the visit and stops counting; badge shows paused.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    await globalThis.browser.storage.local.set({ settings: { ...store.settings, paused: true } });
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "paused" && !store.openVisit, "I: pause ends the visit");
    ok(world.badge.text === "⏸", "I: paused badge");
  }

  // J. Badge reflects today's usage and turns to the signal color when low/over.
  {
    const key = globalThis.Vital.usage.dateKey(Date.now());
    let store = freshStore({ usage: { [key]: 20 * M } }), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    ok(world.badge.text === "9m" || world.badge.text === "10m", `J: 20 of 30 min used → ~10m (${world.badge.text})`);
    ok(world.badge.color === "#111113", "J: neutral badge with time to spare");

    store = freshStore({ usage: { [key]: 35 * M } }); world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    ok(world.badge.text === "-5m" || world.badge.text === "-6m", `J: over allowance → negative (${world.badge.text})`);
    ok(world.badge.color === "#d9480f", "J: signal color when over");
  }

  // K. Raising the allowance applies immediately.
  {
    const key = globalThis.Vital.usage.dateKey(Date.now());
    const store = freshStore({ usage: { [key]: 35 * M } }), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    await globalThis.browser.storage.local.set({ settings: { ...store.settings, dailyAllowanceMin: 60 } });
    await sleep(SETTLE);
    ok(world.badge.text === "24m" || world.badge.text === "25m", `K: 35 of 60 min → ~25m left (${world.badge.text})`);
  }

  // L. Update/reload drops data from the points-based versions.
  {
    const store = freshStore({ ledger: [1], scoreState: {}, balance: 5 }), world = freshWorld();
    world.alarms["vital-linger:old"] = {};
    const b = boot(store, world);
    b.runtime.onInstalled.fire({ reason: "update" });
    await sleep(SETTLE);
    ok(!("ledger" in store) && !("scoreState" in store) && !("balance" in store), "L: legacy keys removed");
    ok(!world.alarms["vital-linger:old"], "L: legacy alarms cleared");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
