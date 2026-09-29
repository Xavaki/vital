/*
 * Standalone assertions for the URL matcher (no test framework).
 * Run: node test/matcher.test.js
 */
const m = require("../src/shared/matcher.js");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", label); }
}
function eqHost(input, expected, label) {
  const r = m.normalizeHost(input);
  ok(r.ok && r.host === expected, `${label} — got ${JSON.stringify(r)}`);
}
function rejects(input, label) {
  const r = m.normalizeHost(input);
  ok(!r.ok, `${label} should be rejected — got ${JSON.stringify(r)}`);
}

// --- normalizeHost: acceptance ---
eqHost("example.com", "example.com", "bare host");
eqHost("  Example.COM ", "example.com", "trim + lowercase");
eqHost("https://www.youtube.com/watch?v=abc", "www.youtube.com", "pasted URL -> host");
eqHost("http://m.youtube.com/", "m.youtube.com", "http URL");
eqHost("sub.example.co.uk", "sub.example.co.uk", "specific host under a public suffix");

// --- normalizeHost: rejection (spec §4) ---
rejects("", "empty");
rejects("com", "single-label / bare TLD");
rejects("localhost", "single label");
rejects("co.uk", "bare public suffix");
rejects("*.example.com", "wildcard");
rejects("example.*", "trailing wildcard");
rejects("ftp://example.com", "non-http scheme");
rejects("file:///etc/passwd", "file scheme");
rejects("192.168.1.1", "IPv4 literal");
rejects("[::1]", "IPv6 literal");
rejects("not a host", "invalid host with space");

// --- hostMatchesRule (spec §8.1) ---
const yt = { host: "youtube.com", includeSubdomains: true };
ok(m.hostMatchesRule(yt, "youtube.com"), "exact match");
ok(m.hostMatchesRule(yt, "www.youtube.com"), "www subdomain");
ok(m.hostMatchesRule(yt, "m.youtube.com"), "m subdomain");
ok(!m.hostMatchesRule(yt, "fakeyoutube.com"), "lookalike must NOT match");
ok(!m.hostMatchesRule(yt, "notexample.com"), "unrelated must NOT match");

const exact = { host: "youtube.com", includeSubdomains: false };
ok(m.hostMatchesRule(exact, "youtube.com"), "exact-mode exact match");
ok(!m.hostMatchesRule(exact, "www.youtube.com"), "exact-mode excludes subdomains");

// --- findMatchingRule respects enabled ---
const rules = [
  { host: "reddit.com", includeSubdomains: true, enabled: false },
  { host: "youtube.com", includeSubdomains: true, enabled: true },
];
ok(m.findMatchingRule(rules, "www.youtube.com") && m.findMatchingRule(rules, "www.youtube.com").host === "youtube.com", "finds enabled rule");
ok(m.findMatchingRule(rules, "old.reddit.com") === null, "skips disabled rule");

// --- hostFromPageUrl excludes non-http pages ---
ok(m.hostFromPageUrl("https://x.com/a") === "x.com", "page url host");
ok(m.hostFromPageUrl("about:blank") === null, "about: excluded");
ok(m.hostFromPageUrl("moz-extension://abc/page.html") === null, "extension page excluded");

// --- originPatternsForRule ---
ok(JSON.stringify(m.originPatternsForRule(yt)) === JSON.stringify(["*://youtube.com/*", "*://*.youtube.com/*"]), "origin patterns with subdomains");
ok(JSON.stringify(m.originPatternsForRule(exact)) === JSON.stringify(["*://youtube.com/*"]), "origin patterns exact host");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
