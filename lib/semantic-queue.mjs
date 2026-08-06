/**
 * Semantic queue driver (references/harvest-architecture.md §5, §7).
 *
 * The model processes evidence packages offline — local image files and
 * serialized DOM only, never a browser — so this phase is immune to binding
 * loss. Each entry must reach one of three terminal states:
 *
 * - enriched:      semantic fields filled, with evidence
 * - review:        evidence exists but no defensible inference; reason given
 * - needs_browser: the evidence itself is missing; lists the exact gaps so
 *                  the follow-up targets holes instead of restarting
 *
 * "Didn't find it" is adjudicated here, not retried: a not_present claim is
 * admissible only with complete coverage plus a verification trace, and
 * surprising claims (the site usually has that field) are marked for one
 * targeted second look before being accepted.
 */

import {
  evidenceCoverageGaps,
  normalizeEvidencePackage,
  validateNotPresentClaim,
  validateVerificationTrace,
} from "./harvest-plan.mjs";

export const SEMANTIC_TERMINAL_STATES = Object.freeze([
  "enriched",
  "review",
  "needs_browser",
  // Harvest only excludes by URL pattern; the full nutrition/bundle judgment
  // (classifyNutritionSingleProduct) runs here once evidence is readable, so
  // scope exclusion is also a semantic-stage terminal state.
  "excluded",
]);

const DEFAULT_SURPRISE_THRESHOLD = 0.5;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the pending queue from harvested evidence packages. Packages whose
 * evidence is already known to be incomplete (flags, coverage gaps) start as
 * needs_browser with the exact gaps attached — no semantic effort is wasted
 * on records that cannot pass anyway.
 */
export function buildSemanticQueue(evidencePackages) {
  return (Array.isArray(evidencePackages) ? evidencePackages : []).map((raw) => {
    const pkg = normalizeEvidencePackage(raw);
    const gaps = [
      ...evidenceCoverageGaps(pkg),
      ...pkg.flags.filter((flag) => flag.startsWith("image_download_failed")
        || flag === "heading_only_ingredients"),
    ];
    if (gaps.length > 0) {
      return {
        productUrl: pkg.productUrl,
        status: "needs_browser",
        reason: `evidence_gaps:${gaps.join(",")}`,
        gaps,
      };
    }
    return { productUrl: pkg.productUrl, status: "pending" };
  });
}

/**
 * Field presence priors across the site's harvested packages. Used to decide
 * which not_present claims are surprising enough to deserve a targeted
 * second look — attention goes where the claim is anomalous, not everywhere.
 */
export function computeFieldPresencePriors(evidencePackages) {
  const packages = (Array.isArray(evidencePackages) ? evidencePackages : [])
    .map(normalizeEvidencePackage);
  const total = packages.length;
  const rate = (count) => (total > 0 ? count / total : 0);
  return {
    records: total,
    factsImage: rate(packages.filter((pkg) =>
      pkg.gallery.some((image) => image.factsCandidateRank != null)).length),
    ingredientsText: rate(packages.filter((pkg) =>
      text(pkg.fields.ingredients_text || pkg.fields.ingredients)).length),
    description: rate(packages.filter((pkg) => text(pkg.fields.description)).length),
  };
}

const PRIOR_KEY_BY_FIELD = Object.freeze({
  facts_image: "factsImage",
  ingredients: "ingredientsText",
  description: "description",
});

export function isNotPresentSurprising(field, priors, threshold = DEFAULT_SURPRISE_THRESHOLD) {
  const key = PRIOR_KEY_BY_FIELD[field] || field;
  const presenceRate = Number(priors?.[key]);
  return Number.isFinite(presenceRate) && presenceRate >= threshold;
}

/**
 * Adjudicate a "didn't find field X" outcome for one package.
 *
 * Returns exactly one of:
 * - { action: "fill_gaps", gaps }            coverage has holes → targeted follow-up
 * - { action: "second_look", reason }        coverage complete but claim is surprising
 * - { action: "accept_not_present" }         coverage complete, claim expected
 *
 * Never consumes a retry: genuine absence costs zero attempts, and misses are
 * caught by coverage gaps or the surprise check, both of which are targeted.
 */
export function adjudicateNotFound(field, evidencePackage, priors, options = {}) {
  const gaps = evidenceCoverageGaps(evidencePackage);
  if (gaps.length > 0) return { action: "fill_gaps", gaps };
  if (options.secondLookDone !== true
      && isNotPresentSurprising(field, priors, options.surpriseThreshold)) {
    return {
      action: "second_look",
      reason: `site_presence_rate_high:${field}`,
    };
  }
  return { action: "accept_not_present" };
}

/**
 * Apply a model-produced outcome to a queue entry. Validates the terminal
 * state contract: reasons on review/needs_browser, gap lists on
 * needs_browser, admissible not_present claims, and a verification trace on
 * every enriched outcome.
 */
export function applySemanticOutcome(entry, outcome = {}, evidencePackage = null) {
  const errors = [];
  const status = text(outcome.status);
  if (!SEMANTIC_TERMINAL_STATES.includes(status)) {
    errors.push(`semantic_status_invalid:${status || "missing"}`);
  }
  if ((status === "review" || status === "needs_browser" || status === "excluded")
      && !text(outcome.reason)) {
    errors.push("semantic_reason_missing");
  }
  if (status === "needs_browser"
      && !(Array.isArray(outcome.gaps) && outcome.gaps.length > 0)) {
    errors.push("needs_browser_gaps_missing");
  }
  if (status === "enriched") {
    errors.push(...validateVerificationTrace(outcome.trace));
    for (const claim of Array.isArray(outcome.notPresent) ? outcome.notPresent : []) {
      errors.push(...validateNotPresentClaim(claim, evidencePackage || {}));
    }
  }
  if (errors.length > 0) {
    return { applied: false, errors, entry };
  }
  return {
    applied: true,
    errors: [],
    entry: {
      ...entry,
      status,
      ...(text(outcome.reason) ? { reason: text(outcome.reason) } : {}),
      ...(Array.isArray(outcome.gaps) && outcome.gaps.length > 0
        ? { gaps: outcome.gaps }
        : {}),
      ...(outcome.trace ? { trace: outcome.trace } : {}),
      ...(Array.isArray(outcome.notPresent) && outcome.notPresent.length > 0
        ? { notPresent: outcome.notPresent }
        : {}),
    },
  };
}

/**
 * Queue roll-up. drained means every entry is terminal — the phase's only
 * exit condition. reviewRatio feeds the "alert the user" threshold.
 */
export function semanticQueueSummary(queue) {
  const entries = Array.isArray(queue) ? queue : [];
  const counts = { pending: 0, enriched: 0, review: 0, needs_browser: 0, excluded: 0 };
  for (const entry of entries) {
    const status = SEMANTIC_TERMINAL_STATES.includes(entry?.status)
      ? entry.status
      : "pending";
    counts[status] += 1;
  }
  const total = entries.length;
  return {
    total,
    counts,
    drained: counts.pending === 0,
    reviewRatio: total > 0 ? counts.review / total : 0,
  };
}
