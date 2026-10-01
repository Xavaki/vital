/*
 * Assertions for the daily time accounting (no framework).
 * Run: node test/usage.test.js
 */
require("../src/shared/config.js"); // populates globalThis.Vital.CONFIG
const U = require("../src/shared/usage.js");
const { CONFIG } = globalThis.Vital;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.error("FAIL:", label); } }
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} — got ${JSON.stringify(actual)}`);
}

const S = 1000, M = 60 * S;
const at = (d, h, m = 0, s = 0) => new Date(2026, 8, d, h, m, s).getTime(); // Sept 2026, local

// --- dateKey: local, zero-padded, sortable ---
eq(U.dateKey(at(9, 12)), "2026-09-09", "dateKey pads month and day");
ok(U.dateKey(at(29, 23, 59, 59)) < U.dateKey(at(30, 0)), "dateKey sorts chronologically");

// --- creditSpan ---
eq(U.creditSpan({}, at(29, 10), at(29, 10, 5)), { "2026-09-29": 5 * M }, "span within one day");
eq(U.creditSpan({ "2026-09-29": 2 * M }, at(29, 10), at(29, 10, 1)), { "2026-09-29": 3 * M }, "adds to existing total");
eq(
  U.creditSpan({}, at(29, 23, 59), at(30, 0, 1)),
  { "2026-09-29": 1 * M, "2026-09-30": 1 * M },
  "span across midnight is split between days"
);
eq(U.creditSpan({}, at(29, 10), at(29, 10)), {}, "empty span credits nothing");

// --- observedEnd: caps unobserved gaps, ignores clock going backwards ---
eq(U.observedEnd(at(29, 10), at(29, 10, 1)), at(29, 10, 1), "gap under cap counts fully");
eq(U.observedEnd(at(29, 10), at(29, 18)), at(29, 10) + CONFIG.maxUnobservedMs, "8h gap (sleep) capped");
eq(U.observedEnd(at(29, 10), at(29, 9)), at(29, 10), "clock went backwards counts nothing");

// --- usedTodayMs: stored total + live time of the open visit ---
const usage = { "2026-09-29": 10 * M, "2026-09-28": 50 * M };
eq(U.usedTodayMs(usage, null, at(29, 12)), 10 * M, "no open visit: today's total only");
eq(U.usedTodayMs(usage, { countedUntil: at(29, 12) }, at(29, 12, 1, 30)), 11.5 * M, "adds live time");
eq(
  U.usedTodayMs({}, { countedUntil: at(29, 23, 59) }, at(30, 0, 1)),
  1 * M,
  "live span from yesterday: only today's part counts"
);
eq(
  U.usedTodayMs({}, { countedUntil: at(29, 1) }, at(29, 9)),
  CONFIG.maxUnobservedMs,
  "live span is capped like recorded time"
);
eq(U.usedTodayMs({}, { host: "legacy" }, at(29, 9)), 0, "open visit without countedUntil adds nothing");
eq(U.usedTodayMs(usage, { countedUntil: at(29, 12, 0, 4) }, at(29, 12, 0, 2)), 10 * M, "grace period (countedUntil ahead) adds nothing");

// --- prune ---
const pruned = U.prune({ "2026-07-01": 1, "2026-09-20": 2, "2026-09-29": 3 }, at(29, 12));
eq(Object.keys(pruned), ["2026-09-20", "2026-09-29"], "drops days past retention");

// --- allowance ---
eq(U.allowanceMs({ dailyAllowanceMin: 30 }), 30 * M, "allowance minutes → ms");

// --- formatters ---
eq(U.fmtClock(0), "0:00", "fmtClock zero");
eq(U.fmtClock(65 * S), "1:05", "fmtClock m:ss");
eq(U.fmtClock(3723 * S), "1:02:03", "fmtClock h:mm:ss");
eq(U.fmtClock(-4 * M - 12 * S), "−4:12", "fmtClock negative");
eq(U.fmtShort(45 * S), "45s", "fmtShort seconds");
eq(U.fmtShort(12 * M + 40 * S), "12m", "fmtShort minutes");
eq(U.fmtShort(65 * M), "1h 05m", "fmtShort hours");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
