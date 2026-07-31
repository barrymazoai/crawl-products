/**
 * Corporate-site -> official storefront candidate discovery.
 *
 * This module only nominates candidates. Verification and navigation remain in
 * crawl.mjs so cross-origin expansion is explicit, capped, and observable.
 */

import {
  isSameSite,
  registrableDomain,
} from "./engine.mjs";

const EXCLUDED_HOST_RE =
  /(?:^|\.)(?:amazon|facebook|instagram|linkedin|pinterest|tiktok|twitter|x|youtube)\./i;
const EXCLUDED_TEXT_RE =
  /\b(?:facebook|instagram|linkedin|pinterest|privacy|terms|careers?|jobs?|investors?|press|news|support|contact)\b/i;
const STRONG_TEXT_RE =
  /\b(?:our brands?|brands?|portfolio|shop|store|official store|buy|products?|visit site|discover|explore)\b/i;
const STORE_HOST_RE = /^(?:shop|store|eshop|e-shop)\./i;

function safeRoot(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function safeHttpUrl(value, baseUrl) {
  try {
    const parsed = new URL(value, baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * Normalize only the direct brands of one supplied parent site.
 *
 * Legacy v1 entries did not persist depth/parentOrigin, so missing values are
 * interpreted as a direct relationship. Explicit depth > 1 or a different
 * parent is rejected instead of being silently recursed.
 */
export function normalizeDirectBrandSites(startUrl, inputSites = []) {
  const parentOrigin = safeRoot(startUrl);
  const sites = [];
  const rejected = [];
  const seen = new Set();
  for (const rawSite of inputSites || []) {
    const declaredDepth = Number(rawSite?.depth ?? 1);
    const declaredParentOrigin = safeRoot(rawSite?.parentOrigin || parentOrigin);
    const brandUrl = safeHttpUrl(
      rawSite?.brandUrl || rawSite?.url || rawSite?.origin,
      startUrl,
    );
    const brandOrigin = safeRoot(rawSite?.brandOrigin || brandUrl || rawSite?.origin);
    const entryUrl = safeHttpUrl(
      rawSite?.entryUrl || rawSite?.finalUrl || rawSite?.finalOrigin || brandUrl,
      brandUrl || startUrl,
    );
    const finalOrigin = safeRoot(rawSite?.finalOrigin || entryUrl || brandOrigin);
    let reason = "";
    if (!parentOrigin || !brandOrigin || !entryUrl || !finalOrigin) {
      reason = "invalid_brand_site";
    } else if (declaredDepth !== 1) {
      reason = "portfolio_depth_exceeded";
    } else if (declaredParentOrigin !== parentOrigin) {
      reason = "portfolio_parent_mismatch";
    } else if (isExcludedPortfolioOrigin(brandOrigin)
        || isExcludedPortfolioOrigin(finalOrigin)) {
      reason = "excluded_portfolio_origin";
    }
    if (reason) {
      rejected.push({
        origin: rawSite?.origin || "",
        depth: declaredDepth,
        reason,
      });
      continue;
    }
    const identity = `${brandOrigin}|${entryUrl}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    sites.push({
      ...rawSite,
      parentOrigin,
      depth: 1,
      brandOrigin,
      brandUrl,
      origin: brandOrigin,
      finalOrigin,
      entryUrl,
      relation: rawSite?.relation || "official_brand",
    });
  }
  return { sites, rejected };
}

/**
 * Once crawling a direct brand (depth 1), its route may hand off to that same
 * brand's official store or exact hosted product details, but it may not enter
 * another portfolio/sub-brand.
 */
export function assertPortfolioRouteWithinDepth(routeInput, currentDepth = 1) {
  if (Number(currentDepth) < 1) return true;
  const steps = Array.isArray(routeInput?.steps) ? routeInput.steps : [];
  const nestedStepIndex = steps.findIndex((step) =>
    step?.pageRole === "portfolio"
      || step?.action?.relationType === "portfolio_brand_site"
  );
  if (nestedStepIndex < 0) return true;
  const error = new Error(`portfolio_depth_exceeded:step_${nestedStepIndex}`);
  error.code = "portfolio_depth_exceeded";
  error.currentDepth = Number(currentDepth);
  error.maxDepth = 1;
  error.stepIndex = nestedStepIndex;
  throw error;
}

export function isExcludedPortfolioOrigin(value) {
  try {
    return EXCLUDED_HOST_RE.test(new URL(value).hostname);
  } catch {
    return true;
  }
}

export function createRedirectPortfolioCandidate(startUrl, resolvedUrl) {
  const startOrigin = safeRoot(startUrl);
  const resolvedOrigin = safeRoot(resolvedUrl);
  if (!startOrigin || !resolvedOrigin || startOrigin === resolvedOrigin) return null;
  if (isExcludedPortfolioOrigin(resolvedOrigin)) return null;
  const parsed = new URL(resolvedOrigin);
  const sameSite = isSameSite(startUrl, resolvedUrl);
  return {
    origin: resolvedOrigin,
    url: resolvedUrl,
    label: parsed.hostname,
    relation: sameSite ? "storefront" : "official_brand_candidate",
    sameSite,
    registrableDomain: registrableDomain(parsed.hostname),
    score: 8,
    evidence: [
      "direct_parent_redirect",
      ...(sameSite ? ["same_registrable_domain"] : []),
    ],
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function portfolioLinks(baseUrl, html) {
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) !== null) {
    const attrs = match[1] || "";
    const href = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]?.trim();
    if (!href || !/^https?:\/\//i.test(decodeHtml(href))) continue;
    let resolved;
    try {
      resolved = new URL(decodeHtml(href), baseUrl).toString();
    } catch {
      continue;
    }
    const ariaLabel = attrs.match(/\baria-label\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const title = attrs.match(/\btitle\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    const text = decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    links.push({
      href: resolved,
      text,
      ariaLabel: decodeHtml(ariaLabel),
      title: decodeHtml(title),
    });
  }
  return links;
}

function linkLabel(link) {
  return [link.text, link.ariaLabel, link.title].find((value) => value?.trim())?.trim() || "";
}

function candidateScore(baseUrl, link, pageHtml) {
  const label = linkLabel(link);
  if (!label || EXCLUDED_TEXT_RE.test(label)) return 0;
  let parsed;
  try {
    parsed = new URL(link.href);
  } catch {
    return 0;
  }
  if (EXCLUDED_HOST_RE.test(parsed.hostname)) return 0;

  let score = 1;
  if (STRONG_TEXT_RE.test(label)) score += 3;
  if (STORE_HOST_RE.test(parsed.hostname)) score += 2;
  if ((parsed.pathname.replace(/\/+$/, "") || "/") === "/") score += 1;
  if (isSameSite(baseUrl, parsed)) score += 2;
  if (/\b(?:our brands?|brand portfolio|nuestras marcas|nos marques|unsere marken)\b/i.test(pageHtml)) {
    score += 1;
  }
  return score;
}

export function discoverPortfolioCandidates(baseUrl, html, opts = {}) {
  const base = new URL(baseUrl);
  const out = new Map();
  for (const link of portfolioLinks(baseUrl, html)) {
    let parsed;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.hostname === base.hostname) continue;
    const score = candidateScore(baseUrl, link, html);
    const sameSite = isSameSite(baseUrl, parsed);
    // A logo-only brand grid often has no "shop" text. On a page that declares
    // an Our Brands/Portfolio section, an external root link reaches score 3
    // and is worth a lightweight storefront verification.
    const minimum = sameSite ? 3 : (opts.minimumExternalScore ?? 3);
    if (score < minimum) continue;
    const origin = safeRoot(parsed);
    if (!origin) continue;
    const candidate = {
      origin,
      url: link.href,
      label: linkLabel(link),
      relation: sameSite ? "storefront" : "official_brand_candidate",
      sameSite,
      registrableDomain: registrableDomain(parsed.hostname),
      score,
      evidence: [
        sameSite ? "same_registrable_domain" : "parent_site_link",
        ...(STRONG_TEXT_RE.test(linkLabel(link)) ? ["commerce_or_brand_label"] : []),
        ...(STORE_HOST_RE.test(parsed.hostname) ? ["store_hostname"] : []),
      ],
    };
    const current = out.get(origin);
    if (!current || candidate.score > current.score) out.set(origin, candidate);
  }
  return [...out.values()]
    .sort((a, b) => b.score - a.score || a.origin.localeCompare(b.origin))
    .slice(0, Math.max(1, opts.maxCandidates ?? 24));
}

export function isAllowedPortfolioCandidate(candidate, opts = {}) {
  const mode = opts.scopeMode || "same_site";
  if (candidate.sameSite) return true;
  if (mode === "verified_brand_sites") return true;
  if (mode !== "explicit_allowlist") return false;
  const allowed = new Set((opts.allowedOrigins || []).map((value) => safeRoot(value)).filter(Boolean));
  return allowed.has(candidate.origin);
}

export function createPortfolioProfile(startUrl, sites, opts = {}) {
  const normalized = normalizeDirectBrandSites(startUrl, sites);
  return {
    version: 2,
    kind: "crawl-products-portfolio-profile",
    parentSite: startUrl,
    parentOrigin: safeRoot(startUrl),
    scopeMode: opts.scopeMode || "same_site",
    maxDepth: 1,
    directBrandOnly: true,
    sites: normalized.sites.map((site) => ({
      origin: site.origin,
      finalOrigin: site.finalOrigin || site.origin,
      parentOrigin: site.parentOrigin,
      depth: 1,
      brandOrigin: site.brandOrigin,
      brandUrl: site.brandUrl,
      entryUrl: site.entryUrl,
      label: site.label || "",
      relation: site.relation || "official_brand",
      confidence: site.confidence ?? 0,
      evidence: [...new Set(site.evidence || [])],
      profileRef: site.profileRef || null,
    })),
    learnedAt: opts.learnedAt || new Date().toISOString(),
  };
}
