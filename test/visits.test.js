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
      async create({ url }) { world.opened.push(url); return { id: 99 }; },
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
    scripting: {
      async executeScript(opts) {
        world.injected.push(opts.files ? "file" : "info");
        if (opts.args) world.toastInfo = opts.args[0];
        return [];
      },
    },
    action: {
      async setIcon({ path }) { world.toolbar.counting = /counting/.test(path[16]); },
      async setTitle({ title }) { world.toolbar.title = title; },
    },
    runtime: {
      onMessage: makeEvent(), onStartup: makeEvent(), onInstalled: makeEvent(),
      getURL: (path) => `moz-extension://vital/${path}`,
    },
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
    opened: [],
    toolbar: {},
    tabs: [
      { id: 10, windowId: 1, active: true, url: "https://web.whatsapp.com/" },
      { id: 11, windowId: 1, active: false, url: "https://example.org/" },
    ],
  };
}
function freshStore(extra = {}) {
  return {
    rules: [{ id: "r1", host: "web.whatsapp.com", includeSubdomains: true, enabled: true }],
    settings: { warningEnabled: true, dailyAllowanceMin: 30 },
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
const GRACE = () => globalThis.Vital.CONFIG.graceMs;

(async () => {
  // A. Visit starts in front; a close inside the grace period costs nothing.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    ok(store.openVisit && store.openVisit.host === "web.whatsapp.com", "A: visit starts on foreground watchlisted tab");
    ok(world.alarms["vital-tick"], "A: tick alarm running during the visit");
    ok(world.injected.join() === "info,file", "A: toast gets its numbers, then is injected");
    ok(world.toastInfo && world.toastInfo.durationMs === GRACE(), "A: toast lasts exactly the grace period");
    closeTab(world, b, 10);
    await sleep(SETTLE);
    ok(lastVisit(store).outcome === "closed", "A: outcome closed");
    ok(usedToday(store) === 0 && lastVisit(store).activeMs === 0, `A: close within grace records nothing (${usedToday(store)}ms)`);
    ok(!store.openVisit && !world.alarms["vital-tick"], "A: no open visit, tick stopped");
    ok(world.toolbar.counting === false && world.toolbar.title === "Vital", "A: no counting dot off-site");
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
    ok(near(usedToday(store), 2 * M - GRACE()), `B: 2 min in front → 2 min minus grace used (${usedToday(store)}ms)`);
    ok(near(lastVisit(store).activeMs, 2 * M - GRACE()), "B: visit duration matches");
  }

  // C. The periodic tick records time while the visit stays open, and the toolbar shows it's counting.
  {
    const store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    backdate(store, 1 * M);
    const b2 = boot(store, world);
    await sleep(SETTLE);
    b2.alarms.onAlarm.fire({ name: "vital-tick" });
    await sleep(SETTLE);
    ok(near(usedToday(store), 1 * M - GRACE()), `C: tick records 1 min minus grace (${usedToday(store)}ms)`);
    ok(store.openVisit && near(store.openVisit.countedUntil, Date.now()), "C: visit still open, recorded up to now");
    ok(world.toolbar.counting === true, "C: counting dot on once grace is over");
    ok(/(28|29)m left today/.test(world.toolbar.title), `C: tooltip shows time left (${world.toolbar.title})`);
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
    ok(near(afterSwitch, 3 * M - GRACE()), `D: foreground time recorded (${afterSwitch}ms)`);
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

  // I. Pause was removed: a leftover `paused: true` setting must not stop
  //    counting (there's no longer any way to unpause).
  {
    const store = freshStore(), world = freshWorld();
    store.settings.paused = true;
    boot(store, world);
    await sleep(SETTLE);
    ok(store.openVisit && store.openVisit.host === "web.whatsapp.com", "I: legacy paused setting is ignored");
    ok(/left today/.test(world.toolbar.title), `I: tooltip shows time, not paused (${world.toolbar.title})`);
  }

  // J. Tooltip reflects today's usage, including time over the allowance.
  {
    const key = globalThis.Vital.usage.dateKey(Date.now());
    let store = freshStore({ usage: { [key]: 20 * M } }), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    ok(/(9|10)m left today/.test(world.toolbar.title), `J: 20 of 30 min used → ~10m (${world.toolbar.title})`);

    store = freshStore({ usage: { [key]: 35 * M } }); world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    ok(/(5|6)m over today's allowance/.test(world.toolbar.title), `J: over allowance (${world.toolbar.title})`);
  }

  // K. Raising the allowance applies immediately.
  {
    const key = globalThis.Vital.usage.dateKey(Date.now());
    const store = freshStore({ usage: { [key]: 35 * M } }), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    await globalThis.browser.storage.local.set({ settings: { ...store.settings, dailyAllowanceMin: 60 } });
    await sleep(SETTLE);
    ok(/(24|25)m left today/.test(world.toolbar.title), `K: 35 of 60 min → ~25m left (${world.toolbar.title})`);
  }

  // L. Update/reload drops data, settings and alarms from earlier versions.
  {
    const store = freshStore({ ledger: [1], scoreState: {}, balance: 5 }), world = freshWorld();
    store.settings.paused = true;
    world.alarms["vital-linger:old"] = {};
    const b = boot(store, world);
    b.runtime.onInstalled.fire({ reason: "update" });
    await sleep(SETTLE);
    ok(!("ledger" in store) && !("scoreState" in store) && !("balance" in store), "L: legacy keys removed");
    ok(!("paused" in store.settings) && store.settings.dailyAllowanceMin === 30, "L: legacy paused setting dropped, others kept");
    ok(!world.alarms["vital-linger:old"], "L: legacy alarms cleared");
  }

  // N. Clear history drops the visit list and earlier days, never today.
  {
    const today = globalThis.Vital.usage.dateKey(Date.now());
    const yesterday = globalThis.Vital.usage.dateKey(Date.now() - 24 * 60 * M);
    const store = freshStore({
      usage: { [today]: 7 * M, [yesterday]: 40 * M },
      visits: [{ id: "old", host: "web.whatsapp.com", startedAt: 1, endedAt: 2, activeMs: 1, outcome: "closed" }],
    });
    const world = freshWorld();
    world.tabs = []; // nothing in front, so no visit gets recorded meanwhile
    boot(store, world);
    await sleep(SETTLE);
    await globalThis.Vital.storage.clearHistory();
    ok(store.visits.length === 0, "N: visit list cleared");
    ok(store.usage[today] === 7 * M && !(yesterday in store.usage), "N: earlier days dropped, today kept");
  }

  // M. Grace period boundaries.
  {
    // Leave at 3s (inside grace): nothing counts.
    let store = freshStore(), world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    backdate(store, 3000);
    let b2 = boot(store, world);
    closeTab(world, b2, 10);
    await sleep(SETTLE);
    ok(usedToday(store) === 0, `M: closed at 3s → nothing counted (${usedToday(store)}ms)`);

    // Leave at 10s: only the time after the grace period counts.
    store = freshStore(); world = freshWorld();
    boot(store, world);
    await sleep(SETTLE);
    backdate(store, 10000);
    b2 = boot(store, world);
    closeTab(world, b2, 10);
    await sleep(SETTLE);
    ok(near(usedToday(store), 10000 - GRACE(), 1000), `M: closed at 10s → ~6s counted (${usedToday(store)}ms)`);

    // A tick or event during grace doesn't pull counting forward.
    store = freshStore(); world = freshWorld();
    b2 = boot(store, world);
    await sleep(SETTLE);
    const graceEnds = store.openVisit.startedAt + GRACE();
    b2.alarms.onAlarm.fire({ name: "vital-tick" });
    await sleep(SETTLE);
    ok(store.openVisit.countedUntil === graceEnds && usedToday(store) === 0, "M: tick during grace keeps the grace window intact");
    ok(world.toolbar.counting === false, "M: no counting dot during grace");

    // Browser restart during grace: interrupted visit doesn't end in the future.
    const before = Date.now();
    b2 = boot(store, world);
    b2.runtime.onStartup.fire();
    await sleep(SETTLE);
    const interrupted = store.visits.find((v) => v.outcome === "interrupted");
    ok(interrupted && interrupted.endedAt <= Date.now() && interrupted.endedAt >= interrupted.startedAt,
      `M: interrupted-in-grace visit ends in the past (${interrupted && interrupted.endedAt - before}ms)`);
  }

  // N. The toast's "Stop seeing this" opens settings at the warning toggle.
  {
    const store = freshStore(), world = freshWorld();
    const b = boot(store, world);
    await sleep(SETTLE);
    const [reply] = b.runtime.onMessage.fire({ type: "openWarningSettings" }, { tab: { id: 10 } });
    ok((await reply).ok === true, "N: background confirms");
    ok(world.opened.length === 1 && world.opened[0].endsWith("src/options/options.html#feedback"),
      `N: settings opened at the warning toggle (${world.opened})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
