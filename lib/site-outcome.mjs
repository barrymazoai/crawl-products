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
  if (Number(input.productCount || 0) > 0 || input.hasPurchasableProducts === true) {
    return { kind: "storefront", terminal: false };
  }
  if (typeof input.officialStoreUrl === "string" && /^https?:\/\//i.test(input.officialStoreUrl)) {
    return {
      kind: "official_store_handoff",
      terminal: false,
      officialStoreUrl: input.officialStoreUrl.slice(0, 2_000),
    };
  }
  if (Array.isArray(input.portfolioOrigins) && input.portfolioOrigins.length > 0) {
    return { kind: "portfolio", terminal: false };
  }
  if (input.hasManufacturerCatalog === true) {
    return { kind: "manufacturer_catalog", terminal: true };
  }
  if (input.isParked === true) return { kind: "parked", terminal: true };
  return { kind: "service_or_out_of_scope", terminal: true };
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
