/**
 * Persistent, value-free crawl profiles.
 *
 * Profiles keep reusable discovery/extraction rules, never product values,
 * response bodies, cookies, headers, or other session data.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SITE_PROFILE_VERSION = 4;
const ALLOWED_CDP_RESOURCE_TYPES = new Set(["XHR", "Fetch"]);
const LISTING_MODES = new Set(["repeated_cards", "single_product", "inline_catalog"]);
const LISTING_PAGINATION_ACTIONS = new Set(["click", "scroll"]);
const ROUTE_RELATION_TYPES = new Set([
  "official_store_handoff",
  "portfolio_brand_site",
  "external_product_detail",
]);
const ROUTE_ACTION_KINDS = new Set([
  "navigation_reveal",
  "catalog_entry",
  "product_entry",
  "pagination",
]);
const CATALOG_COVERAGE_KINDS = new Set(["single", "siblings"]);
const CATALOG_CLOSURE_BASES = new Set([
  "navigation_exhausted",
  "single_listing_catalog",
  "single_product_catalog",
]);
const LISTING_PAGINATION_MODES = new Set(["none", "link", "click", "scroll"]);

function normalizeVariantProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selectors = (key) => [...new Set(
    (Array.isArray(value[key]) ? value[key] : [])
      .filter((selector) => typeof selector === "string" && selector.trim())
      .map((selector) => selector.trim().slice(0, 300)),
  )].slice(0, 16);
  const optionGroupSelectors = selectors("optionGroupSelectors");
  const optionSelectors = selectors("optionSelectors");
  const selectedStateSelectors = selectors("selectedStateSelectors");
  if (optionGroupSelectors.length === 0 && optionSelectors.length === 0
      && selectedStateSelectors.length === 0) return null;
  const settleMs = Number.isFinite(Number(value.settleMs))
    ? Math.min(10_000, Math.max(0, Math.round(Number(value.settleMs))))
    : 800;
  const maxStates = Number.isFinite(Number(value.maxStates))
    ? Math.min(200, Math.max(1, Math.round(Number(value.maxStates))))
    : 48;
  return {
    ...(optionGroupSelectors.length > 0 ? { optionGroupSelectors } : {}),
    ...(optionSelectors.length > 0 ? { optionSelectors } : {}),
    ...(selectedStateSelectors.length > 0 ? { selectedStateSelectors } : {}),
    settleMs,
    maxStates,
  };
}

function normalizedFields(fields = []) {
  return [...new Set(fields.filter((field) => typeof field === "string" && field.trim())
    .map((field) => field.trim()))].sort();
}

function safeSiteIdentity(startUrl) {
  const parsed = new URL(startUrl);
  return {
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
  };
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

export function siteProfileFileName(startUrl) {
  const { origin, hostname } = safeSiteIdentity(startUrl);
  const suffix = createHash("sha256").update(origin).digest("hex").slice(0, 10);
  return `${safeName(hostname)}-${suffix}.json`;
}

export function computeTemplateFingerprint(html) {
  const structural = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/\b(?:value|content|href|src)=["'][^"']*["']/gi, " ")
    .replace(/>[^<]+</g, ">#<")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 250_000);
  return createHash("sha256").update(structural).digest("hex").slice(0, 20);
}

export function normalizeCdpProfile(profile) {
  const responseRules = Array.isArray(profile?.responseRules)
    ? profile.responseRules
      .slice(0, 12)
      .map((rule) => {
        const urlIncludes = typeof rule?.urlIncludes === "string"
          ? rule.urlIncludes.trim().slice(0, 300)
          : "";
        const urlPattern = typeof rule?.urlPattern === "string"
          ? rule.urlPattern.trim().slice(0, 500)
          : "";
        if (!urlIncludes && !urlPattern) return null;
        const requestedTypes = (Array.isArray(rule.resourceTypes)
          ? rule.resourceTypes
          : ["XHR", "Fetch"])
          .filter((type) => ALLOWED_CDP_RESOURCE_TYPES.has(type));
        const resourceTypes = requestedTypes.length > 0
          ? requestedTypes
          : ["XHR", "Fetch"];
        return {
          ...(typeof rule.name === "string" && rule.name.trim()
            ? { name: rule.name.trim().slice(0, 80) }
            : {}),
          ...(urlIncludes ? { urlIncludes } : { urlPattern }),
          resourceTypes: [...new Set(resourceTypes)].slice(0, 2),
        };
      })
      .filter(Boolean)
    : [];
  return responseRules.length > 0 ? { responseRules } : null;
}

export function normalizeListingProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const categoryLinkSelectors = [...new Set(
    (Array.isArray(profile.categoryLinkSelectors) ? profile.categoryLinkSelectors : [])
      .filter((selector) =>
        typeof selector === "string" && selector.trim() && selector.length <= 240
      )
      .map((selector) => selector.trim()),
  )].slice(0, 16);
  const productLinkSelectors = [...new Set(
    (Array.isArray(profile.productLinkSelectors) ? profile.productLinkSelectors : [])
      .filter((selector) =>
        typeof selector === "string" && selector.trim() && selector.length <= 240
      )
      .map((selector) => selector.trim()),
  )].slice(0, 16);
  const paginationActions = (Array.isArray(profile.paginationActions)
    ? profile.paginationActions
    : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const selector = typeof item.selector === "string" ? item.selector.trim() : "";
      if (!selector || selector.length > 240) return null;
      const action = LISTING_PAGINATION_ACTIONS.has(item.action) ? item.action : "click";
      return {
        action,
        selector,
        ...(typeof item.text === "string" && item.text.trim()
          ? { text: item.text.trim().replace(/\s+/g, " ").slice(0, 180) }
          : {}),
      };
    })
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex((candidate) =>
      candidate.action === item.action && candidate.selector === item.selector
    ) === index)
    .slice(0, 8);
  const normalized = {
    ...(categoryLinkSelectors.length > 0 ? { categoryLinkSelectors } : {}),
    productLinkSelectors,
    ...(paginationActions.length > 0 ? { paginationActions } : {}),
    scrollListings: profile.scrollListings !== false,
    listingScrollScreens: Math.min(
      20,
      Math.max(1, Number(profile.listingScrollScreens || 10)),
    ),
    ...(LISTING_MODES.has(profile.listingMode)
      ? { listingMode: profile.listingMode }
      : {}),
    ...(profile.followVerifiedExternalProductLinks === true
      ? { followVerifiedExternalProductLinks: true }
      : {}),
  };
  return categoryLinkSelectors.length > 0 || productLinkSelectors.length > 0
      || paginationActions.length > 0
      || profile.scrollListings !== undefined
      || profile.listingScrollScreens !== undefined
      || LISTING_MODES.has(profile.listingMode)
      || profile.followVerifiedExternalProductLinks === true
    ? normalized
    : null;
}

const VISUAL_PAGE_ROLES = new Set([
  "home",
  "portfolio",
  "listing",
  "detail",
  "inline_catalog",
  "blocked",
  "unknown",
]);
const VISUAL_ROUTE_STATUSES = new Set(["incomplete", "visual_complete", "mapped"]);
const VISUAL_FIELD_AVAILABILITY = new Set([
  "present_visible",
  "present_hidden",
  "not_present",
  "uncertain",
]);
const VISUAL_FIELD_ACTIONS = new Set(["click", "open_details", "scroll"]);
const VISUAL_FIELD_SOURCE_KINDS = new Set(["dom", "gallery_image"]);

function normalizeRouteAction(rawAction, { allowTargetUrl = true } = {}) {
  if (!rawAction || typeof rawAction !== "object") return null;
  const action = {
    ...(typeof rawAction.text === "string" && rawAction.text.trim()
      ? { text: rawAction.text.trim().replace(/\s+/g, " ").slice(0, 180) }
      : {}),
    ...(allowTargetUrl
      && typeof rawAction.targetUrl === "string"
      && /^https?:\/\//i.test(rawAction.targetUrl)
      ? { targetUrl: rawAction.targetUrl.slice(0, 2_000) }
      : {}),
    ...(typeof rawAction.selector === "string" && rawAction.selector.trim()
      ? { selector: rawAction.selector.trim().slice(0, 300) }
      : {}),
    ...(typeof rawAction.generalSelector === "string" && rawAction.generalSelector.trim()
      ? { generalSelector: rawAction.generalSelector.trim().slice(0, 300) }
      : {}),
    ...(rawAction.generalSelectorSource === "repeated_ancestor"
      || rawAction.generalSelectorSource === "repeated_navigation"
      ? { generalSelectorSource: rawAction.generalSelectorSource }
      : {}),
    ...(ROUTE_ACTION_KINDS.has(rawAction.actionKind)
      ? { actionKind: rawAction.actionKind }
      : {}),
    ...(CATALOG_COVERAGE_KINDS.has(rawAction.catalogCoverage)
      ? { catalogCoverage: rawAction.catalogCoverage }
      : {}),
    ...(ROUTE_RELATION_TYPES.has(rawAction.relationType)
      ? { relationType: rawAction.relationType }
      : {}),
  };
  return Object.keys(action).length > 0 ? action : null;
}

function normalizeCatalogCoverage(value) {
  if (!value || typeof value !== "object") return null;
  const listingSeeds = [...new Set(
    (Array.isArray(value.listingSeeds) ? value.listingSeeds : [])
      .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
      .map((url) => url.slice(0, 2_000)),
  )].slice(0, 100);
  const families = (Array.isArray(value.families) ? value.families : [])
    .map((family) => {
      if (!family || typeof family !== "object") return null;
      const sourceUrl = typeof family.sourceUrl === "string"
        && /^https?:\/\//i.test(family.sourceUrl)
        ? family.sourceUrl.slice(0, 2_000)
        : "";
      const selector = typeof family.selector === "string"
        ? family.selector.trim().slice(0, 300)
        : "";
      const urls = [...new Set(
        (Array.isArray(family.listingUrls) ? family.listingUrls : [])
          .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
          .map((url) => url.slice(0, 2_000)),
      )].slice(0, 100);
      if (!sourceUrl || !selector || urls.length === 0) return null;
      return {
        sourceUrl,
        selector,
        listingUrls: urls,
        ...(VISUAL_PAGE_ROLES.has(family.sourcePageRole)
          ? { sourcePageRole: family.sourcePageRole }
          : {}),
        ...(CATALOG_COVERAGE_KINDS.has(family.coverage)
          ? { coverage: family.coverage }
          : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 32);
  const listings = (Array.isArray(value.listings) ? value.listings : [])
    .map((listing) => {
      if (!listing || typeof listing !== "object") return null;
      const url = typeof listing.url === "string" && /^https?:\/\//i.test(listing.url)
        ? listing.url.slice(0, 2_000)
        : "";
      if (!url || !LISTING_PAGINATION_MODES.has(listing.paginationMode)) return null;
      return {
        url,
        paginationMode: listing.paginationMode,
        verifiedVisually: listing.verifiedVisually === true,
      };
    })
    .filter(Boolean)
    .filter((listing, index, items) =>
      items.findIndex((candidate) => candidate.url === listing.url) === index
    )
    .slice(0, 100);
  const closure = value.closure && typeof value.closure === "object"
    ? {
      status: value.closure.status === "complete" ? "complete" : "incomplete",
      verifiedVisually: value.closure.verifiedVisually === true,
      ...(CATALOG_CLOSURE_BASES.has(value.closure.basis)
        ? { basis: value.closure.basis }
        : {}),
    }
    : null;
  if (listingSeeds.length === 0 && families.length === 0 && !closure) return null;
  return {
    status: value.status === "mapped" ? "mapped" : "incomplete",
    listingSeeds,
    families,
    ...(listings.length > 0 ? { listings } : {}),
    ...(closure ? { closure } : {}),
  };
}

function normalizeFieldQuality(quality) {
  if (!quality || typeof quality !== "object") return null;
  const semanticSignals = [...new Set(
    (Array.isArray(quality.semanticSignals) ? quality.semanticSignals : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().slice(0, 80)),
  )].slice(0, 16);
  const reasons = [...new Set(
    (Array.isArray(quality.reasons) ? quality.reasons : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().slice(0, 120)),
  )].slice(0, 16);
  return {
    valid: quality.valid === true,
    score: Number.isFinite(Number(quality.score)) ? Number(quality.score) : 0,
    ...(typeof quality.tagName === "string" && quality.tagName.trim()
      ? { tagName: quality.tagName.trim().toLowerCase().slice(0, 40) }
      : {}),
    selectorCount: Math.max(0, Number(quality.selectorCount || 0)),
    textLength: Math.max(0, Number(quality.textLength || 0)),
    imageCount: Math.max(0, Number(quality.imageCount || 0)),
    videoCount: Math.max(0, Number(quality.videoCount || 0)),
    semanticSignals,
    reasons,
  };
}

function normalizeFieldJourney(journey) {
  if (!journey || typeof journey !== "object") return null;
  const pageUrl = typeof journey.pageUrl === "string"
    && /^https?:\/\//i.test(journey.pageUrl)
    ? journey.pageUrl.slice(0, 2_000)
    : null;
  const fields = (Array.isArray(journey.fields) ? journey.fields : [])
    .slice(0, 40)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const field = typeof item.field === "string"
        ? item.field.trim().slice(0, 80)
        : "";
      if (!field) return null;
      const availability = VISUAL_FIELD_AVAILABILITY.has(item.availability)
        ? item.availability
        : "uncertain";
      const targetSelector = typeof item.targetSelector === "string"
        && item.targetSelector.trim()
        ? item.targetSelector.trim().slice(0, 300)
        : null;
      const rawReveal = item.revealAction && typeof item.revealAction === "object"
        ? item.revealAction
        : null;
      const revealAction = rawReveal ? {
        action: VISUAL_FIELD_ACTIONS.has(rawReveal.action) ? rawReveal.action : "click",
        ...(typeof rawReveal.text === "string" && rawReveal.text.trim()
          ? { text: rawReveal.text.trim().replace(/\s+/g, " ").slice(0, 180) }
          : {}),
        ...(typeof rawReveal.selectorHint === "string" && rawReveal.selectorHint.trim()
          ? { selectorHint: rawReveal.selectorHint.trim().slice(0, 300) }
          : {}),
      } : null;
      const quality = normalizeFieldQuality(item.quality);
      const sourceKind = VISUAL_FIELD_SOURCE_KINDS.has(item.sourceKind)
        ? item.sourceKind
        : null;
      return {
        field,
        availability,
        ...(sourceKind ? { sourceKind } : {}),
        ...(targetSelector ? { targetSelector } : {}),
        ...(revealAction ? { revealAction } : {}),
        ...(quality ? { quality } : {}),
      };
    })
    .filter(Boolean);
  if (fields.length === 0) return null;
  return {
    status: VISUAL_ROUTE_STATUSES.has(journey.status)
      ? journey.status
      : "incomplete",
    ...(pageUrl ? { pageUrl } : {}),
    fields,
  };
}

/**
 * Keep only the route facts needed to replay a visual reconnaissance pass.
 *
 * Screenshot bytes and click coordinates are intentionally transient: they
 * become stale with viewport/layout changes. The persisted route contains
 * page roles, URLs, human-visible action labels, and selectors learned later
 * during the instrumented replay.
 */
export function normalizeVisualRoute(route) {
  if (!route || typeof route !== "object") return null;
  const rawSteps = Array.isArray(route.steps) ? route.steps : [];
  const steps = rawSteps
    .slice(0, 16)
    .map((step) => {
      if (!step || typeof step !== "object") return null;
      const url = typeof step.url === "string" ? step.url.trim().slice(0, 2_000) : "";
      if (!/^https?:\/\//i.test(url)) return null;
      const pageRole = VISUAL_PAGE_ROLES.has(step.pageRole) ? step.pageRole : "unknown";
      const action = normalizeRouteAction(step.action);
      return {
        pageRole,
        url,
        ...(typeof step.templateFingerprint === "string" && step.templateFingerprint.trim()
          ? { templateFingerprint: step.templateFingerprint.trim().slice(0, 80) }
          : {}),
        ...(action && Object.keys(action).length > 0 ? { action } : {}),
      };
    })
    .filter(Boolean);
  if (steps.length === 0) return null;
  const fieldJourney = normalizeFieldJourney(route.fieldJourney);
  const catalogCoverage = normalizeCatalogCoverage(route.catalogCoverage);
  const variantProfile = normalizeVariantProfile(route.variantProfile);
  const requestedFields = normalizedFields(
    Array.isArray(route.requestedFields) && route.requestedFields.length > 0
      ? route.requestedFields
      : fieldJourney?.fields.map((item) => item.field) || [],
  );
  return {
    version: 3,
    status: VISUAL_ROUTE_STATUSES.has(route.status) ? route.status : "incomplete",
    targetRole: VISUAL_PAGE_ROLES.has(route.targetRole)
      ? route.targetRole
      : steps.at(-1)?.pageRole || "unknown",
    requestedFields,
    steps,
    ...(catalogCoverage ? { catalogCoverage } : {}),
    ...(fieldJourney ? { fieldJourney } : {}),
    ...(variantProfile ? { variantProfile } : {}),
  };
}

/**
 * Gate batch crawling on a complete screenshot-first journey.
 *
 * "Mapped" means both halves have completed: visual reconnaissance located
 * every requested field, then the replay mapped visible targets and reveal
 * controls to reusable selectors. A field explicitly verified as absent is a
 * valid checkpoint and becomes an allow-missing policy.
 */
export function validateMappedVisualRoute(routeInput, input = {}) {
  const route = normalizeVisualRoute(routeInput);
  const reasons = [];
  if (!route) return { valid: false, reasons: ["visual_route_missing"], missingFields: [] };
  if (route.version !== 3 || route.status !== "mapped") reasons.push("visual_route_not_mapped");
  if (route.fieldJourney?.status !== "mapped") reasons.push("field_journey_not_mapped");

  for (let index = 0; index < route.steps.length - 1; index += 1) {
    const step = route.steps[index];
    const next = route.steps[index + 1];
    try {
      if (new URL(step.url).origin !== new URL(next.url).origin
          && !ROUTE_RELATION_TYPES.has(step.action?.relationType)) {
        reasons.push("cross_origin_relation_missing");
      }
    } catch {
      reasons.push("route_url_invalid");
    }
    if (step.pageRole === "listing" && next.pageRole === "detail"
        && !step.action?.generalSelector && !step.action?.selector) {
      reasons.push("product_link_selector_missing");
    }
    if (step.action?.actionKind === "pagination" && !step.action?.selector) {
      reasons.push("pagination_selector_missing");
    }
  }

  const catalogFamilies = route.catalogCoverage?.families || [];
  for (const step of route.steps.slice(0, -1)) {
    if (step.action?.actionKind !== "catalog_entry") continue;
    const family = catalogFamilies.find((candidate) =>
      candidate.sourceUrl === step.url
        && candidate.selector === (step.action.generalSelector || step.action.selector)
    );
    if (!family) {
      reasons.push("catalog_family_missing");
      continue;
    }
    if (step.action.catalogCoverage === "siblings" && family.listingUrls.length < 2) {
      reasons.push("catalog_sibling_coverage_incomplete");
    }
  }

  if (input.requireCatalogCompletion === true) {
    const coverage = route.catalogCoverage;
    const closure = coverage?.closure;
    const singleProductCatalog = closure?.basis === "single_product_catalog";
    if (!coverage || coverage.status !== "mapped") {
      reasons.push("catalog_coverage_not_mapped");
    }
    if (closure?.status !== "complete"
        || closure?.verifiedVisually !== true
        || !CATALOG_CLOSURE_BASES.has(closure?.basis)) {
      reasons.push("catalog_closure_not_proven");
    }
    if ((coverage?.listingSeeds || []).length === 0 && !singleProductCatalog) {
      reasons.push("catalog_listing_seeds_missing");
    }
    const listingProofs = new Map(
      (coverage?.listings || []).map((listing) => [listing.url, listing]),
    );
    for (const seed of coverage?.listingSeeds || []) {
      const proof = listingProofs.get(seed);
      if (!proof || proof.verifiedVisually !== true) {
        reasons.push("catalog_listing_pagination_unverified");
      }
    }
    if (singleProductCatalog
        && !route.steps.some((step) => step.pageRole === "detail")) {
      reasons.push("single_product_catalog_detail_missing");
    }
  }

  const requestedFields = normalizedFields(input.fields?.length
    ? input.fields
    : route.requestedFields);
  const checkpoints = new Map(
    (route.fieldJourney?.fields || []).map((item) => [item.field, item]),
  );
  const missingFields = [];
  for (const field of requestedFields) {
    const checkpoint = checkpoints.get(field);
    if (!checkpoint || checkpoint.availability === "uncertain") {
      missingFields.push(field);
      continue;
    }
    if (checkpoint.availability !== "not_present" && !checkpoint.targetSelector) {
      missingFields.push(field);
      continue;
    }
    if (checkpoint.availability !== "not_present"
        && (!checkpoint.quality?.valid || checkpoint.quality.selectorCount !== 1)) {
      missingFields.push(field);
      continue;
    }
    if ((field === "images" || field === "image"
          || checkpoint.sourceKind === "gallery_image")
        && checkpoint.availability !== "not_present"
        && (checkpoint.quality.imageCount < 1
          || checkpoint.quality.videoCount > 0 && checkpoint.quality.imageCount === 0)) {
      missingFields.push(field);
      continue;
    }
    if (checkpoint.availability === "present_hidden"
        && checkpoint.sourceKind !== "gallery_image"
        && checkpoint.revealAction?.action !== "scroll"
        && !checkpoint.revealAction?.selectorHint) {
      missingFields.push(field);
    }
  }
  const scalarSelectors = new Map();
  for (const checkpoint of route.fieldJourney?.fields || []) {
    if (!checkpoint.targetSelector
        || checkpoint.availability === "not_present"
        || ["images", "image"].includes(checkpoint.field)
        || checkpoint.sourceKind === "gallery_image") continue;
    const alias = ["title", "name"].includes(checkpoint.field)
      ? "title_or_name"
      : checkpoint.field;
    const previous = scalarSelectors.get(checkpoint.targetSelector);
    if (previous && previous !== alias) reasons.push("field_selector_collision");
    else scalarSelectors.set(checkpoint.targetSelector, alias);
  }
  if (missingFields.length > 0) reasons.push("field_journey_incomplete");
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    missingFields: [...new Set(missingFields)],
  };
}

export function createSiteProfile(input) {
  const { origin, hostname } = safeSiteIdentity(input.startUrl);
  const now = input.updatedAt || new Date().toISOString();
  return {
    version: SITE_PROFILE_VERSION,
    kind: "crawl-products-site-profile",
    site: {
      startUrl: input.startUrl,
      origin,
      hostname,
    },
    fields: normalizedFields(input.fields),
    templateFingerprint: input.templateFingerprint || null,
    discovery: input.discovery ? {
      strategy: input.discovery.strategy || input.discovery.source || "navigation",
      listingSeeds: [...new Set(input.discovery.listingSeeds || [])].slice(0, 100),
      storefrontOrigins: [...new Set(input.discovery.storefrontOrigins || [origin])].slice(0, 24),
      sampleProductUrl: input.discovery.sampleProductUrl || null,
    } : null,
    listingProfile: normalizeListingProfile(input.listingProfile),
    visualRoute: normalizeVisualRoute(input.visualRoute),
    detailProfile: input.detailProfile || null,
    imageProfile: input.imageProfile || null,
    cdpProfile: normalizeCdpProfile(input.cdpProfile),
    portfolio: input.portfolio || null,
    learnedAt: input.learnedAt || now,
    updatedAt: now,
    validation: {
      lastValidatedAt: input.validation?.lastValidatedAt || null,
      successCount: Number(input.validation?.successCount || 0),
      failureCount: Number(input.validation?.failureCount || 0),
    },
  };
}

export function mergeSiteProfile(existing, updates) {
  return createSiteProfile({
    ...existing,
    ...updates,
    startUrl: updates.startUrl || existing.site.startUrl,
    fields: updates.fields || existing.fields,
    discovery: updates.discovery || existing.discovery,
    listingProfile: updates.listingProfile ?? existing.listingProfile,
    visualRoute: updates.visualRoute ?? existing.visualRoute,
    detailProfile: updates.detailProfile ?? existing.detailProfile,
    imageProfile: updates.imageProfile ?? existing.imageProfile,
    cdpProfile: updates.cdpProfile ?? existing.cdpProfile,
    portfolio: updates.portfolio ?? existing.portfolio,
    learnedAt: existing.learnedAt,
    validation: updates.validation || existing.validation,
  });
}

export function validateSiteProfile(profile, input = {}) {
  const reasons = [];
  if (!profile || profile.kind !== "crawl-products-site-profile") reasons.push("wrong_kind");
  const legacyVersion = profile?.version === 3;
  if (legacyVersion) reasons.push("legacy_profile_quality_revalidation_required");
  else if (profile?.version !== SITE_PROFILE_VERSION) reasons.push("version_mismatch");
  if (input.startUrl) {
    try {
      if (new URL(input.startUrl).origin !== profile?.site?.origin) reasons.push("origin_mismatch");
    } catch {
      reasons.push("invalid_start_url");
    }
  }
  const requested = normalizedFields(input.fields);
  const learned = new Set(profile?.fields || []);
  if (requested.some((field) => !learned.has(field))) reasons.push("fields_not_covered");
  if (input.templateFingerprint && profile?.templateFingerprint
      && input.templateFingerprint !== profile.templateFingerprint) {
    reasons.push("template_changed");
  }
  if (profile?.visualRoute && !legacyVersion) {
    const routeValidation = validateMappedVisualRoute(profile.visualRoute, {
      fields: requested.length > 0 ? requested : profile.fields,
    });
    reasons.push(...routeValidation.reasons);
  }
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    ...(legacyVersion ? {
      migration: {
        reusable: ["discovery", "listingProfile", "visualRoute.steps", "cdpProfile"],
        revalidate: ["visualRoute.fieldJourney.quality", "imageProfile"],
      },
    } : {}),
  };
}

export async function loadSiteProfile(profileDir, startUrl, opts = {}) {
  if (!profileDir) return null;
  const filePath = path.join(profileDir, siteProfileFileName(startUrl));
  try {
    const profile = JSON.parse(await readFile(filePath, "utf8"));
    const validation = validateSiteProfile(profile, {
      startUrl,
      fields: opts.fields,
      templateFingerprint: opts.templateFingerprint,
    });
    return { profile, filePath, validation };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      profile: null,
      filePath,
      validation: { valid: false, reasons: ["read_failed"] },
      error: String(error),
    };
  }
}

export async function saveSiteProfile(profileDir, profile) {
  if (!profileDir) throw new Error("profileDir is required");
  const validation = validateSiteProfile(profile, {
    startUrl: profile?.site?.startUrl,
    fields: profile?.fields,
  });
  if (!validation.valid) {
    throw new Error(`invalid site profile: ${validation.reasons.join(", ")}`);
  }
  await mkdir(profileDir, { recursive: true });
  const filePath = path.join(profileDir, siteProfileFileName(profile.site.startUrl));
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
  return filePath;
}
