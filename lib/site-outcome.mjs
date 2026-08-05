/**
 * Value-free site and browser-access outcome classification.
 *
 * Browser execution failures must never become durable facts about a site.
 * Actual access failures may be remembered briefly so a retry loop does not
 * hammer an unavailable origin, but they expire and never replace a crawl
 * profile.
 */

export const SITE_OUTCOME_KINDS = Object.freeze([
  "storefront",
  "multi_brand_retailer",
  "official_store_handoff",
  "portfolio",
  "manufacturer_catalog",
  "service_or_out_of_scope",
  "parked",
  "challenge",
  "access_error",
]);

export const ACCESS_ERROR_KINDS = Object.freeze([
  "navigation_timeout",
  "connection_closed",
  "tls_certificate_error",
  "http_error",
  "browser_execution_error",
  "challenge",
  "unknown_access_error",
]);

export const ENTRY_CRAWL_MODES = Object.freeze([
  "site",
  "official_store_handoff",
  "portfolio",
  "needs_visual_classification",
  "needs_brand_verification",
  "terminal",
]);

const BROWSER_EXECUTION_RE =
  /blocked_by_browser_url_policy|cannot attach|browser (?:is )?disconnected|target closed|no such tab|session closed|browser_operation_timeout|visual_route_replay_budget_exceeded|visual_route_operation_timeout/i;
const SCREENSHOT_EXECUTION_RE =
  /page\.capturescreenshot|capture ?screenshot|screenshot(?:_render)?_(?:timeout|blank|failed)|timed out.*screenshot/i;
const NAVIGATION_TIMEOUT_RE = /err_timed_out|navigation timeout|timed out after|timeout.*navigat/i;
const CONNECTION_CLOSED_RE =
  /err_connection_closed|connection (?:was )?closed|socket hang up|connection reset/i;
const TLS_RE =
  /err_cert_|common_name_invalid|certificate|privacy error|your connection is not private/i;
const CHALLENGE_RE =
  /captcha|cloudflare|checking your browser|verify you are human|security challenge|access denied/i;
const HTTP_ERROR_RE = /\b(?:http|status)\s*(?:error\s*)?(4\d\d|5\d\d)\b/i;

function boundedText(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function classifyBrowserAccessError(error, page = {}) {
  const evidence = boundedText([
    error instanceof Error ? `${error.name}: ${error.message}` : error,
    page.title,
    page.bodyText,
  ].filter(Boolean).join(" "), 2_000);
  const checkedAt = page.checkedAt || new Date().toISOString();

  if (SCREENSHOT_EXECUTION_RE.test(evidence)) {
    return {
      kind: "browser_execution_error",
      reason: "browser_screenshot_failed",
      retryable: true,
      persistable: false,
      checkedAt,
    };
  }
  if (BROWSER_EXECUTION_RE.test(evidence)) {
    return {
      kind: "browser_execution_error",
      reason: "browser_execution_surface_failed",
      retryable: true,
      persistable: false,
      checkedAt,
    };
  }
  if (CHALLENGE_RE.test(evidence)) {
    return {
      kind: "challenge",
      reason: "anti_bot_or_access_challenge",
      retryable: true,
      persistable: true,
      ttlMs: 30 * 60 * 1_000,
      checkedAt,
    };
  }
  if (TLS_RE.test(evidence)) {
    return {
      kind: "tls_certificate_error",
      reason: "origin_certificate_invalid",
      retryable: false,
      persistable: true,
      ttlMs: 24 * 60 * 60 * 1_000,
      checkedAt,
    };
  }
  if (NAVIGATION_TIMEOUT_RE.test(evidence)) {
    return {
      kind: "navigation_timeout",
      reason: "origin_navigation_timed_out",
      retryable: true,
      persistable: true,
      ttlMs: 60 * 60 * 1_000,
      checkedAt,
    };
  }
  if (CONNECTION_CLOSED_RE.test(evidence)) {
    return {
      kind: "connection_closed",
      reason: "origin_closed_connection",
      retryable: true,
      persistable: true,
      ttlMs: 60 * 60 * 1_000,
      checkedAt,
    };
  }
  const httpStatus = Number(evidence.match(HTTP_ERROR_RE)?.[1] || page.httpStatus || 0);
  if (httpStatus >= 400 && httpStatus <= 599) {
    return {
      kind: "http_error",
      reason: `http_status_${httpStatus}`,
      httpStatus,
      retryable: httpStatus === 408 || httpStatus === 429 || httpStatus >= 500,
      persistable: true,
      ttlMs: 60 * 60 * 1_000,
      checkedAt,
    };
  }
  return {
    kind: "unknown_access_error",
    reason: "unclassified_access_failure",
    retryable: true,
    persistable: false,
    checkedAt,
  };
}

export function classifySiteOutcome(input = {}) {
  if (input.accessError || input.page?.challenge === true) {
    const access = classifyBrowserAccessError(
      input.accessError || "security challenge",
      input.page,
    );
    return {
      kind: access.kind === "challenge" ? "challenge" : "access_error",
      terminal: true,
      access,
    };
  }
  // A retailer/reseller can expose thousands of valid product cards, so this
  // decision must precede the generic storefront check. Only an explicit
  // per-task override may turn it back into a crawlable storefront.
  if ((input.isMultiBrandRetailer === true || input.isMarketplace === true)
      && input.includeMultiBrandRetailers !== true) {
    return {
      kind: "multi_brand_retailer",
      terminal: true,
      reason: "multi_brand_retailer_excluded",
    };
  }
  if (Number(input.productCount || 0) > 0 || input.hasPurchasableProducts === true) {
    return { kind: "storefront", terminal: false };
  }
  if (Array.isArray(input.portfolioOrigins) && input.portfolioOrigins.length > 0) {
    return { kind: "portfolio", terminal: false };
  }
  if (typeof input.officialStoreUrl === "string" && /^https?:\/\//i.test(input.officialStoreUrl)) {
    return {
      kind: "official_store_handoff",
      terminal: false,
      officialStoreUrl: input.officialStoreUrl.slice(0, 2_000),
    };
  }
  if (input.hasManufacturerCatalog === true) {
    return { kind: "manufacturer_catalog", terminal: true };
  }
  if (input.isParked === true) return { kind: "parked", terminal: true };
  return { kind: "service_or_out_of_scope", terminal: true };
}

/**
 * Turn screenshot-led entry evidence into an explicit crawl decision.
 *
 * A parent site with no own catalog is never terminal while it still exposes
 * direct official Brand candidates. Verified direct Brands override an
 * earlier empty/out-of-scope classification and become a one-level portfolio.
 */
export function resolveEntryCrawlPlan(startUrl, input = {}) {
  const outcome = input.entryOutcome ?? input.outcome ?? null;
  const verifiedSites = [
    ...(Array.isArray(input.verifiedSites) ? input.verifiedSites : []),
    ...(Array.isArray(input.portfolioProfile?.sites) ? input.portfolioProfile.sites : []),
  ];
  const brandCandidates = Array.isArray(input.brandCandidates)
    ? input.brandCandidates.filter(Boolean)
    : [];

  // Brand filters/directories on a reseller are shopping taxonomy, not a
  // corporate portfolio. Do not let those links override the terminal result.
  if (outcome?.kind === "multi_brand_retailer") {
    return {
      mode: "terminal",
      terminal: true,
      startUrl,
      reason: outcome.reason || "multi_brand_retailer_excluded",
      outcome,
    };
  }

  if (verifiedSites.length > 0 && outcome?.kind !== "storefront") {
    return {
      mode: "portfolio",
      terminal: false,
      startUrl,
      reason: "verified_direct_brands_replace_empty_parent",
      outcome: { kind: "portfolio", terminal: false },
    };
  }
  if (outcome?.kind === "portfolio") {
    if (verifiedSites.length === 0) {
      return {
        mode: "needs_brand_verification",
        terminal: false,
        startUrl,
        reason: "portfolio_brands_not_verified",
        brandCandidates,
        outcome,
      };
    }
    return {
      mode: "portfolio",
      terminal: false,
      startUrl,
      reason: "verified_direct_brand_portfolio",
      outcome,
    };
  }
  if (brandCandidates.length > 0
      && !["storefront", "official_store_handoff"].includes(outcome?.kind)) {
    return {
      mode: "needs_brand_verification",
      terminal: false,
      startUrl,
      reason: "direct_brand_candidates_require_visual_verification",
      brandCandidates,
      outcome,
    };
  }
  if (!outcome) {
    return {
      mode: "needs_visual_classification",
      terminal: false,
      startUrl,
      reason: "visual_entry_outcome_required",
      outcome: null,
    };
  }
  if (outcome.kind === "storefront") {
    return { mode: "site", terminal: false, startUrl, reason: "own_catalog", outcome };
  }
  if (outcome.kind === "official_store_handoff") {
    return {
      mode: "official_store_handoff",
      terminal: false,
      startUrl: outcome.officialStoreUrl,
      parentUrl: startUrl,
      reason: "official_store_handoff",
      outcome,
    };
  }
  return {
    mode: "terminal",
    terminal: true,
    startUrl,
    reason: outcome.reason || outcome.kind || "service_or_out_of_scope",
    outcome,
  };
}

export function createSiteObservation(startUrl, outcome, opts = {}) {
  const access = outcome?.access;
  if (access && access.persistable !== true) return null;
  const checkedAt = opts.checkedAt || access?.checkedAt || new Date().toISOString();
  return {
    version: 1,
    kind: "crawl-products-site-observation",
    origin: new URL(startUrl).origin,
    outcomeKind: outcome?.kind || "access_error",
    ...(access ? {
      accessKind: access.kind,
      reason: access.reason,
      expiresAt: new Date(
        Date.parse(checkedAt) + Math.max(1_000, Number(access.ttlMs || 60 * 60 * 1_000)),
      ).toISOString(),
    } : {}),
    checkedAt,
  };
}

export function isSiteObservationFresh(observation, now = Date.now()) {
  if (!observation || observation.kind !== "crawl-products-site-observation") return false;
  if (!observation.expiresAt) return true;
  const expiresAt = Date.parse(observation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
