/*
 * Vital — hostname normalization and matching (spec §4).
 *
 * Pure logic, no browser APIs, so it can be unit-tested under Node.
 * Attaches to globalThis.Vital.
 */
(function (root) {
  "use strict";

  const Vital = (root.Vital = root.Vital || {});

  // A minimal, pragmatic set of multi-label public suffixes we reject as
  // "bare" (a rule on one of these would match an entire TLD's worth of
  // unrelated sites). This is NOT a full Public Suffix List — that is a
  // later enhancement (spec §10 style). Single-label hosts (no dot) are
  // rejected separately, which already covers "com", "org", "localhost".
  const KNOWN_MULTI_LABEL_SUFFIXES = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk",
    "com.au", "net.au", "org.au", "gov.au", "edu.au",
    "co.jp", "or.jp", "ne.jp", "ac.jp",
    "co.nz", "com.br", "com.mx", "co.in", "co.za",
    "com.cn", "com.tr", "com.sg", "com.hk",
  ]);

  function isIpv4(host) {
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }

  /**
   * Normalize a raw input (a bare host like "example.com" or a pasted URL)
   * to a lowercase hostname, validating against the spec's rejection rules.
   *
   * @param {string} raw
   * @returns {{ ok: true, host: string } | { ok: false, error: string }}
   */
  function normalizeHost(raw) {
    if (typeof raw !== "string") return { ok: false, error: "Enter a site." };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "Enter a site." };

    // Reject wildcard/pattern input (e.g. "*.example.com", "example.*").
    if (trimmed.includes("*")) {
      return { ok: false, error: "Wildcards aren't allowed. Enter a plain hostname." };
    }

    // Parse. If a scheme is present, honor it (and reject non-HTTP(S)).
    // Otherwise assume https:// so the URL parser can extract the host.
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
    let url;
    try {
      url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    } catch {
      return { ok: false, error: "That doesn't look like a valid site or URL." };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "Only http and https sites are supported." };
    }

    const host = url.hostname.toLowerCase();
    if (!host) return { ok: false, error: "Couldn't find a hostname." };

    // Reject IP literals — subdomain matching is meaningless for them.
    if (host.startsWith("[") || host.includes(":")) {
      return { ok: false, error: "IP addresses aren't supported." };
    }
    if (isIpv4(host)) {
      return { ok: false, error: "IP addresses aren't supported." };
    }

    // Reject single-label hosts and bare public suffixes.
    if (!host.includes(".")) {
      return { ok: false, error: "Enter a full hostname, like example.com." };
    }
    if (KNOWN_MULTI_LABEL_SUFFIXES.has(host)) {
      return { ok: false, error: "That's a public suffix, not a specific site." };
    }

    return { ok: true, host };
  }

  /**
   * Does a rule match a candidate hostname?
   * Default: exact host plus its subdomains ("example.com" matches
   * "www.example.com" but never "notexample.com"). With includeSubdomains
   * false (exact-host toggle), only an exact match counts.
   *
   * @param {{ host: string, includeSubdomains?: boolean }} rule
   * @param {string} candidateHost
   */
  function hostMatchesRule(rule, candidateHost) {
    if (!rule || !candidateHost) return false;
    const ruleHost = String(rule.host).toLowerCase();
    const host = String(candidateHost).toLowerCase();
    if (host === ruleHost) return true;
    if (rule.includeSubdomains === false) return false;
    return host.endsWith(`.${ruleHost}`);
  }

  /**
   * Find the first enabled rule matching a hostname, or null.
   * @param {Array} rules
   * @param {string} candidateHost
   */
  function findMatchingRule(rules, candidateHost) {
    if (!Array.isArray(rules)) return null;
    for (const rule of rules) {
      if (rule && rule.enabled !== false && hostMatchesRule(rule, candidateHost)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * Extract a hostname from a full page URL for matching, or null if the URL
   * is not an ordinary HTTP(S) page (extension/internal pages are excluded).
   * @param {string} pageUrl
   */
  function hostFromPageUrl(pageUrl) {
    if (typeof pageUrl !== "string") return null;
    let url;
    try {
      url = new URL(pageUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase() || null;
  }

  /**
   * The origin patterns to request as host permissions so a content script
   * can be injected for this rule (spec §7 permission strategy).
   * @param {{ host: string, includeSubdomains?: boolean }} rule
   * @returns {string[]}
   */
  function originPatternsForRule(rule) {
    const host = String(rule.host).toLowerCase();
    if (rule.includeSubdomains === false) {
      return [`*://${host}/*`];
    }
    return [`*://${host}/*`, `*://*.${host}/*`];
  }

  Vital.matcher = {
    normalizeHost,
    hostMatchesRule,
    findMatchingRule,
    hostFromPageUrl,
    originPatternsForRule,
  };

  // Allow `require()` from a Node test harness without disturbing browser use.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Vital.matcher;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
