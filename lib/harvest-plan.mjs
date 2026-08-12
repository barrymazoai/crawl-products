/**
 * Harvest contracts: the two documents that separate model judgment from
 * mechanical crawling (see references/harvest-architecture.md).
 *
 * - HarvestPlan: what the model's three preflight steps hand to the script
 *   engine. The engine refuses to start on an invalid plan, which forces
 *   preflight step C (termination contract) to actually happen.
 * - EvidencePackage: what the script hands back per product. It carries all
 *   evidence the offline semantic phase needs, plus a coverage manifest so
 *   "not_present" claims can be machine-audited instead of self-reported.
 * - VerificationTrace: the universal "how/where/with-what was this concluded"
 *   record every verdict must carry.
 */

export const HARVEST_STATES = Object.freeze([
  "missing",
  "plan_ready",
  "harvest_done",
  "incomplete",
  "semantic_done",
  "verifying",
  "verified",
  "complete",
  "terminal",
  "blocked",
]);

export const HARVEST_FILE_LAYOUT = Object.freeze({
  state: "state.json",
  plan: "harvest-plan.json",
  checkpoint: "checkpoint.json",
  result: "harvest-result.json",
  evidenceDir: "evidence",
  evidenceImageDir: "evidence/img",
  evidenceRecords: "evidence/records.json",
  fieldPresenceStats: "evidence/field-presence-stats.json",
  semanticQueue: "semantic-queue.json",
  semanticReviewQueue: "semantic-review-queue.json",
  needsBrowserQueue: "needs-browser-queue.json",
  workerNotes: "worker-notes.json",
  verificationReport: "verification-report.json",
});

export const PAGINATION_MODES = Object.freeze(["link", "click", "scroll", "none"]);

export const ORACLE_TYPES = Object.freeze([
  "sitemap",
  "collection_count",
  "shopify_products_json",
]);

export const VERIFICATION_METHODS = Object.freeze([
  "visual_image_read",
  "dom_recheck",
  "live_site_reopen",
  "artifact_audit",
  "count_reconcile",
  "coverage_audit",
]);

export const VERIFICATION_SURFACES = Object.freeze([
  "local_file",
  "dom_snapshot",
  "live_site",
  "artifacts",
]);

export const DEFAULT_HARVEST_BUDGETS = Object.freeze({
  maxItems: 200,
  maxPagesPerSeed: 50,
  wallClockMinutes: 60,
  stallMinutes: 5,
  // Idle (no-progress) ceiling for a single extract/upgrade call. NOT a total
  // duration cap: the deadline resets on every progress signal from inside the
  // hook, so legitimately slow work (heavy multi-page chunks) keeps going as
  // long as it makes progress. Only a call that emits nothing for this long —
  // a genuine hang / dead binding — is aborted (resumable). Kept generous so
  // slow-but-alive sites are never mistaken for hung ones.
  operationIdleMinutes: 5,
  retryPerUrl: 2,
  verifyRounds: 2,
  familyCircuitBreakerRatio: 0.5,
  reviewAlertRatio: 0.2,
  extraRoundsAfterConverge: 1,
});

const ENTRY_DECISION_KINDS = new Set([
  "storefront",
  "official_store_handoff",
  "portfolio",
]);

const BROWSER_MODES = new Set(["extension", "iab"]);

/**
 * Exhaustion signals a listing seed may declare. Parameterized signals encode
 * their threshold after a colon, e.g. "no_new_urls_after_clicks:3".
 */
const EXHAUSTION_SIGNALS_BY_MODE = Object.freeze({
  link: [/^next_link_absent$/],
  click: [/^button_gone$/, /^no_new_urls_after_clicks:[1-9]\d*$/],
  scroll: [/^no_new_cards_after_scrolls:[1-9]\d*$/],
  none: [/^single_page_confirmed$/],
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value) {
  const candidate = text(value);
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function ratio(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 1 ? numeric : fallback;
}

// ---------------------------------------------------------------------------
// Verification traces
// ---------------------------------------------------------------------------

/**
 * Every verdict in the pipeline must say how it was reached. A trace without
 * method/surface/evidence is treated as "unverified" by the Tier 1 audit.
 */
export function normalizeVerificationTrace(input = {}) {
  if (!isPlainObject(input)) return null;
  const trace = {
    verdict: text(input.verdict),
    method: text(input.method),
    surface: text(input.surface),
    evidence: (Array.isArray(input.evidence) ? input.evidence : [])
      .map((item) => text(item))
      .filter(Boolean),
    verifier: text(input.verifier),
  };
  if (Number.isFinite(Number(input.round))) trace.round = Number(input.round);
  return trace;
}

export function validateVerificationTrace(input) {
  const trace = normalizeVerificationTrace(input);
  const errors = [];
  if (!trace) return ["trace_not_object"];
  if (!trace.verdict) errors.push("trace_verdict_missing");
  if (!VERIFICATION_METHODS.includes(trace.method)) {
    errors.push(`trace_method_invalid:${trace.method || "missing"}`);
  }
  if (!VERIFICATION_SURFACES.includes(trace.surface)) {
    errors.push(`trace_surface_invalid:${trace.surface || "missing"}`);
  }
  if (trace.evidence.length === 0) errors.push("trace_evidence_missing");
  if (!trace.verifier) errors.push("trace_verifier_missing");
  return errors;
}

// ---------------------------------------------------------------------------
// HarvestPlan
// ---------------------------------------------------------------------------

export function isValidExhaustionSignal(paginationMode, signal) {
  const patterns = EXHAUSTION_SIGNALS_BY_MODE[paginationMode];
  if (!patterns) return false;
  const candidate = text(signal);
  return patterns.some((pattern) => pattern.test(candidate));
}

export function normalizeHarvestPlan(input = {}) {
  const plan = isPlainObject(input) ? input : {};
  const site = isPlainObject(plan.site) ? plan.site : {};
  const decision = isPlainObject(plan.decision) ? plan.decision : {};
  const route = isPlainObject(plan.route) ? plan.route : {};
  const termination = isPlainObject(plan.termination) ? plan.termination : {};
  const budgets = isPlainObject(termination.budgets) ? termination.budgets : {};

  return {
    site: {
      origin: text(site.origin),
      entryUrl: text(site.entryUrl),
      browserMode: BROWSER_MODES.has(text(site.browserMode))
        ? text(site.browserMode)
        : "extension",
    },
    decision: {
      kind: text(decision.kind),
      evidence: (Array.isArray(decision.evidence) ? decision.evidence : [])
        .map((item) => text(item))
        .filter(Boolean),
    },
    route: {
      listingSeeds: (Array.isArray(route.listingSeeds) ? route.listingSeeds : [])
        .filter(isPlainObject)
        .map((seed) => ({
          url: text(seed.url),
          paginationMode: text(seed.paginationMode),
          ...(isPlainObject(seed.nextAction) ? { nextAction: seed.nextAction } : {}),
        })),
      detailProfile: isPlainObject(route.detailProfile) ? route.detailProfile : null,
      listingProfile: isPlainObject(route.listingProfile) ? route.listingProfile : null,
      imageProfile: isPlainObject(route.imageProfile) ? route.imageProfile : null,
      variantProfile: isPlainObject(route.variantProfile) ? route.variantProfile : null,
      expandActions: Array.isArray(route.expandActions) ? route.expandActions : [],
    },
    termination: {
      perSeed: (Array.isArray(termination.perSeed) ? termination.perSeed : [])
        .filter(isPlainObject)
        .map((entry) => ({
          url: text(entry.url),
          exhaustionSignal: text(entry.exhaustionSignal),
        })),
      fixpoint: {
        extraRoundsAfterConverge: positiveNumber(
          termination.fixpoint?.extraRoundsAfterConverge,
          DEFAULT_HARVEST_BUDGETS.extraRoundsAfterConverge,
        ),
      },
      oracles: (Array.isArray(termination.oracles) ? termination.oracles : [])
        .filter(isPlainObject)
        .map((oracle) => ({
          type: text(oracle.type),
          ...(Number.isFinite(Number(oracle.expected))
            ? { expected: Number(oracle.expected) }
            : {}),
          ...(text(oracle.source) ? { source: text(oracle.source) } : {}),
          ...(text(oracle.url) ? { url: text(oracle.url) } : {}),
        })),
      budgets: {
        maxItems: positiveNumber(budgets.maxItems, DEFAULT_HARVEST_BUDGETS.maxItems),
        maxPagesPerSeed: positiveNumber(
          budgets.maxPagesPerSeed,
          DEFAULT_HARVEST_BUDGETS.maxPagesPerSeed,
        ),
        wallClockMinutes: positiveNumber(
          budgets.wallClockMinutes,
          DEFAULT_HARVEST_BUDGETS.wallClockMinutes,
        ),
        stallMinutes: positiveNumber(
          budgets.stallMinutes,
          DEFAULT_HARVEST_BUDGETS.stallMinutes,
        ),
        operationIdleMinutes: positiveNumber(
          budgets.operationIdleMinutes ?? budgets.operationTimeoutMinutes,
          DEFAULT_HARVEST_BUDGETS.operationIdleMinutes,
        ),
        verifyRounds: positiveNumber(
          budgets.verifyRounds,
          DEFAULT_HARVEST_BUDGETS.verifyRounds,
        ),
        familyCircuitBreakerRatio: ratio(
          budgets.familyCircuitBreakerRatio,
          DEFAULT_HARVEST_BUDGETS.familyCircuitBreakerRatio,
        ),
        reviewAlertRatio: ratio(
          budgets.reviewAlertRatio,
          DEFAULT_HARVEST_BUDGETS.reviewAlertRatio,
        ),
      },
      retryPerUrl: positiveNumber(
        termination.retryPerUrl,
        DEFAULT_HARVEST_BUDGETS.retryPerUrl,
      ),
    },
  };
}

export function validateHarvestPlan(input) {
  const plan = normalizeHarvestPlan(input);
  const errors = [];

  if (!isHttpUrl(plan.site.entryUrl)) errors.push("site_entry_url_invalid");
  if (!plan.site.origin) errors.push("site_origin_missing");

  if (!ENTRY_DECISION_KINDS.has(plan.decision.kind)) {
    errors.push(`decision_kind_not_crawlable:${plan.decision.kind || "missing"}`);
  }
  if (plan.decision.evidence.length === 0) errors.push("decision_evidence_missing");

  if (plan.route.listingSeeds.length === 0) errors.push("route_listing_seeds_missing");
  const seedUrls = new Set();
  for (const seed of plan.route.listingSeeds) {
    if (!isHttpUrl(seed.url)) errors.push(`seed_url_invalid:${seed.url || "empty"}`);
    if (seedUrls.has(seed.url)) errors.push(`seed_url_duplicate:${seed.url}`);
    seedUrls.add(seed.url);
    if (!PAGINATION_MODES.includes(seed.paginationMode)) {
      errors.push(`seed_pagination_mode_invalid:${seed.url}`);
    }
    if ((seed.paginationMode === "click" || seed.paginationMode === "link")
        && !isPlainObject(seed.nextAction)) {
      errors.push(`seed_next_action_missing:${seed.url}`);
    }
  }
  if (!plan.route.detailProfile) errors.push("route_detail_profile_missing");

  const terminationByUrl = new Map(
    plan.termination.perSeed.map((entry) => [entry.url, entry]),
  );
  for (const seed of plan.route.listingSeeds) {
    const entry = terminationByUrl.get(seed.url);
    if (!entry) {
      errors.push(`termination_missing_for_seed:${seed.url}`);
      continue;
    }
    if (!isValidExhaustionSignal(seed.paginationMode, entry.exhaustionSignal)) {
      errors.push(
        `termination_signal_invalid:${seed.url}:${entry.exhaustionSignal || "missing"}`,
      );
    }
  }
  for (const entry of plan.termination.perSeed) {
    if (!seedUrls.has(entry.url)) errors.push(`termination_orphan_seed:${entry.url}`);
  }

  for (const oracle of plan.termination.oracles) {
    if (!ORACLE_TYPES.includes(oracle.type)) {
      errors.push(`oracle_type_invalid:${oracle.type || "missing"}`);
    }
  }

  return { valid: errors.length === 0, errors, plan };
}

// ---------------------------------------------------------------------------
// EvidencePackage
// ---------------------------------------------------------------------------

export function normalizeEvidencePackage(input = {}) {
  const pkg = isPlainObject(input) ? input : {};
  const coverage = isPlainObject(pkg.coverage) ? pkg.coverage : {};
  return {
    productUrl: text(pkg.productUrl),
    fields: isPlainObject(pkg.fields) ? pkg.fields : {},
    gallery: (Array.isArray(pkg.gallery) ? pkg.gallery : [])
      .filter(isPlainObject)
      .map((image, index) => ({
        url: text(image.url),
        alt: text(image.alt),
        index: Number.isFinite(Number(image.index)) ? Number(image.index) : index,
        localPath: text(image.localPath),
        mime: text(image.mime),
        ...(Number.isFinite(Number(image.width)) ? { width: Number(image.width) } : {}),
        ...(Number.isFinite(Number(image.height)) ? { height: Number(image.height) } : {}),
        ...(Number.isFinite(Number(image.factsCandidateRank))
          ? { factsCandidateRank: Number(image.factsCandidateRank) }
          : {}),
      })),
    coverage: {
      gallerySaved: text(coverage.gallerySaved),
      domSectionsExpanded: (Array.isArray(coverage.domSectionsExpanded)
        ? coverage.domSectionsExpanded
        : []).map((item) => text(item)).filter(Boolean),
      pageTextSearched: (Array.isArray(coverage.pageTextSearched)
        ? coverage.pageTextSearched
        : []).map((item) => text(item)).filter(Boolean),
      jsonLdCaptured: coverage.jsonLdCaptured === true,
    },
    flags: (Array.isArray(pkg.flags) ? pkg.flags : [])
      .map((item) => text(item))
      .filter(Boolean),
  };
}

export function validateEvidencePackage(input) {
  const pkg = normalizeEvidencePackage(input);
  const errors = [];
  if (!isHttpUrl(pkg.productUrl)) errors.push("evidence_product_url_invalid");
  if (!text(pkg.fields.title)) errors.push("evidence_title_missing");
  for (const image of pkg.gallery) {
    if (!isHttpUrl(image.url)) errors.push(`evidence_image_url_invalid:${image.index}`);
    if (!image.localPath
        && !pkg.flags.some((flag) => flag.startsWith("image_download_failed"))) {
      errors.push(`evidence_image_not_saved:${image.url}`);
    }
  }
  return { valid: errors.length === 0, errors, package: pkg };
}

/**
 * Coverage gaps for adjudicating a "didn't find it" outcome. An empty result
 * means the search space was fully covered, so a not_present claim is
 * admissible; any gap means "not looked everywhere yet", and the follow-up
 * targets exactly the listed gaps rather than restarting the search.
 */
export function evidenceCoverageGaps(input) {
  const pkg = normalizeEvidencePackage(input);
  const gaps = [];
  const saved = pkg.coverage.gallerySaved;
  const match = /^(\d+)\/(\d+)$/.exec(saved);
  if (!match) {
    gaps.push("gallery_coverage_unrecorded");
  } else if (Number(match[1]) < Number(match[2])) {
    gaps.push(`gallery_images_unsaved:${Number(match[2]) - Number(match[1])}`);
  }
  if (pkg.gallery.length > 0 && match && Number(match[2]) !== pkg.gallery.length) {
    gaps.push("gallery_coverage_count_mismatch");
  }
  if (pkg.coverage.domSectionsExpanded.length === 0) {
    gaps.push("dom_sections_not_expanded");
  }
  if (!pkg.coverage.jsonLdCaptured) gaps.push("json_ld_not_captured");
  return gaps;
}

/**
 * A not_present claim is only admissible when the package's coverage is
 * complete and the claim carries a valid verification trace.
 */
export function validateNotPresentClaim(claim = {}, evidencePackage = {}) {
  const errors = [];
  if (!text(claim.field)) errors.push("not_present_field_missing");
  const gaps = evidenceCoverageGaps(evidencePackage);
  errors.push(...gaps.map((gap) => `not_present_coverage_gap:${gap}`));
  errors.push(...validateVerificationTrace(claim.trace));
  return errors;
}
