/**
 * Browser-driven crawl orchestration for the `crawl-products` skill.
 *
 * `engine.mjs` holds the deterministic rules (built from the browserbase-worker
 * source; see apps/browserbase-worker/src/skill-engine.ts). This file is the
 * only part that touches a browser, and it exists so the *loops live in Node*:
 * every function here takes Codex's `tab` / `browser` binding and returns a
 * compact result. Calling `crawlSite()` once walks hundreds of pages inside a
 * single `js` tool call, so page content never lands in the agent's context.
 *
 * Two-speed detail extraction, mirroring the worker's `http` vs `browser` modes:
 *   fast  — `browser.tabs.content({urls})` loads a small batch in background
 *           tabs and returns HTML. No interaction, so it only works when the
 *           template exposes the requested fields in the loaded document. The
 *           default batch size is deliberately one for external Chrome: a
 *           single extension/profile must not contend with concurrent
 *           navigations. A caller with an already-validated profile may opt
 *           into a larger `batchSize` explicitly.
 *   slow  — per-product `tab.goto()` + overlay dismissal + accordion expansion
 *           + lazy-load scroll. Used only for products the fast path left with
 *           required fields missing.
 *
 * Unknown-site entry discovery is intentionally not implemented here. A
 * single entry starts from a mapped screenshot-first route or valid saved
 * profile; multi-entry tasks use `crawlTargets()` so one successful origin
 * cannot terminate the remaining origins. Every field value still comes from
 * a rendered product page.
 */

import {
  applyDetailExtractionProfile,
  collectDetailUrls,
  deriveOriginalImageCandidate,
  findNextListingPage,
  imageIdentityKey,
  isLikelyProductImageUrl,
  isSameSite,
  looksLikeCategoryUrl,
  missingDetailExtractionFields,
  normalizeImageUrl,
  normalizeProductUrl,
  splitMissingDetailExtractionFieldsByPolicy,
  uniqueImages,
  validateDetailExtractionProfile,
} from "./engine.mjs";
import {
  captureBrowserActionEvidence,
  captureBrowserEvidence,
  inspectEvidenceCapabilities,
} from "./browser-evidence.mjs";
import {
  computeTemplateFingerprint,
  createSiteProfile,
  loadSiteProfile,
  normalizeCdpProfile,
  normalizeListingProfile,
  normalizeVisualRoute,
  saveSiteProfile,
  validateMappedVisualRoute,
  validateSiteProfile,
} from "./profile-store.mjs";
import {
  extractionProfilesFromVisualRoute,
  mapVisualFieldTarget,
  mapVisualRouteAction,
  replayVisualRoute,
} from "./visual-route.mjs";
import {
  captureVisualScreenshot,
  replaceTaintedTab,
  runWithHardTimeout,
  shouldDiscardBrowserTab,
} from "./operation-control.mjs";
import {
  assertPortfolioRouteWithinDepth,
  createRedirectPortfolioCandidate,
  createPortfolioProfile,
  discoverPortfolioCandidates,
  isExcludedPortfolioOrigin,
  isAllowedPortfolioCandidate,
  normalizeDirectBrandSites,
} from "./portfolio.mjs";
import {
  PRODUCT_SCOPE_POLICY,
  classifyNutritionProductUrl,
  filterNutritionSingleProductRecords,
} from "./product-scope.mjs";
import {
  normalizeVariantOptions,
  normalizeVariantUrl,
  variantDisplayName,
  variantIdentity,
  variantQualifiedProductName,
  withVariantState,
} from "./product-variants.mjs";
import {
  ACCESS_ERROR_KINDS,
  ENTRY_CRAWL_MODES,
  SITE_OUTCOME_KINDS,
  classifyBrowserAccessError,
  classifySiteOutcome,
  createSiteObservation,
  isSiteObservationFresh,
  resolveEntryCrawlPlan,
} from "./site-outcome.mjs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export {
  ACCESS_ERROR_KINDS,
  ENTRY_CRAWL_MODES,
  SITE_OUTCOME_KINDS,
  classifyBrowserAccessError,
  classifySiteOutcome,
  createSiteObservation,
  isSiteObservationFresh,
  resolveEntryCrawlPlan,
};

export {
  captureBrowserActionEvidence,
  captureBrowserEvidence,
  inspectEvidenceCapabilities,
};
export {
  captureVisualScreenshot,
  replaceTaintedTab,
  shouldDiscardBrowserTab,
};
export { bundleObservedProductAssets } from "./browser-evidence.mjs";
export {
  computeTemplateFingerprint,
  createSiteProfile,
  loadSiteProfile,
  normalizeCdpProfile,
  normalizeListingProfile,
  normalizeVisualRoute,
  saveSiteProfile,
};
export { validateSiteProfile };
export {
  assertPortfolioRouteWithinDepth,
  createRedirectPortfolioCandidate,
  createPortfolioProfile,
  discoverPortfolioCandidates,
  isExcludedPortfolioOrigin,
  isAllowedPortfolioCandidate,
  normalizeDirectBrandSites,
};
export {
  extractionProfilesFromVisualRoute,
  mapVisualFieldTarget,
  mapVisualRouteAction,
  replayVisualRoute,
};
export {
  PRODUCT_SCOPE_POLICY,
  classifyNutritionProductUrl,
  filterHarvestStageRecords,
  filterNutritionSingleProductRecords,
} from "./product-scope.mjs";
export {
  normalizeVariantOptions,
  normalizeVariantUrl,
  variantDisplayName,
  variantIdentity,
  variantQualifiedProductName,
  withVariantState,
} from "./product-variants.mjs";

const DEFAULT_FIELDS = [
  "title",
  "price",
  "description",
  "images",
  "ingredients",
  "supplement_facts",
  // Optional detail field (see OPTIONAL_DETAIL_FIELDS): extracted when the
  // page exposes it, but a missing sku never marks the record partial.
  "sku",
];
const NAV_TIMEOUT_MS = 45_000;
const BATCH_TIMEOUT_MS = 45_000;
const BATCH_SIZE = 1;
const MAX_SCROLL_SCREENS = 10;
const ORIGINAL_IMAGE_SAMPLE_SIZE = 2;
const ORIGINAL_IMAGE_MAX_GROUPS = 12;
const ORIGINAL_IMAGE_MIN_DIMENSION = 800;
const MIN_IMAGES_BEFORE_GALLERY_UPGRADE = 2;
const SEMANTIC_PRODUCT_LINK_SELECTORS = [
  "a.product-item-link[href]",
  "a.product-item-photo[href]",
  ".product-card a[href]",
  ".productCard a[href]",
  "a.productBuyBtn[href]",
  "[data-product-id] a[href]",
  "[data-product-sku] a[href]",
  "[itemtype*='Product'] a[href]",
  "[itemprop='itemListElement'] [itemprop='url'][href]",
  "a[data-product-url][href]",
];

function shouldUseLearnedCdp(opts = {}) {
  if (opts.useCdp === false) return false;
  return opts.useCdp === true || Boolean(normalizeCdpProfile(opts.cdpProfile));
}
const NON_CATALOG_PATH_RE =
  /\/(?:cart|basket|checkout|account|login|register|wishlist|search|blog|news|contact|about|privacy|terms|faq|compare|carrito|cuenta|buscar|contacto|acerca|privacidad|condiciones|preguntas-frecuentes)(?:\/|$)/i;
const EXTERNAL_NON_DETAIL_PATH_RE =
  /\/(?:brands?|brand|category|categories|collections?|catalog|shop|store|menu|znacka|marcas?)(?:\/|$)/i;

// ---------------------------------------------------------------------------
// Page IO
// ---------------------------------------------------------------------------

/**
 * Read the current page as a string.
 *
 * Chrome renders JSON and XML documents inside a synthetic `<pre>` wrapper, so
 * `outerHTML` on /products.json or /sitemap.xml would hand the engine markup it
 * cannot parse. Detect those and return the raw text instead.
 */
export async function readPageBody(tab) {
  return tab.playwright.evaluate(() => {
    const type = document.contentType || "";
    const isMarkup = type.includes("html");
    const onlyPre = document.body
      && document.body.children.length === 1
      && document.body.children[0].tagName === "PRE";
    if (!isMarkup || onlyPre) {
      return { text: document.body ? document.body.innerText : "", markup: false };
    }
    return { text: document.documentElement.outerHTML, markup: true };
  }, undefined, { timeoutMs: NAV_TIMEOUT_MS });
}

/** Navigate and return the body, tolerating slow/partial loads. */
export async function openPage(tab, url, opts = {}) {
  const previousUrl = await tab.url().catch(() => "");
  let navigationError = null;
  try {
    await runWithHardTimeout(
      () => tab.goto(url),
      {
        label: "open_page_navigation",
        timeoutMs: opts.navigationOperationTimeoutMs ?? opts.operationTimeoutMs ?? 20_000,
        discardTab: true,
      },
    );
  } catch (error) {
    if (shouldDiscardBrowserTab(error)) throw error;
    navigationError = error;
  }
  try {
    await tab.playwright.waitForLoadState({
      state: opts.waitUntil || "domcontentloaded",
      timeoutMs: opts.timeoutMs || NAV_TIMEOUT_MS,
    });
  } catch {
    // A load-state timeout is not fatal: many storefronts keep long-poll or
    // analytics connections open forever. Read whatever rendered.
  }
  const body = await readPageBody(tab);
  const resolved = (await tab.url()) || url;
  if (navigationError) {
    const stayedOnUnrelatedPreviousPage = previousUrl
      && resolved === previousUrl
      && normalizeComparableNavigationUrl(previousUrl) !== normalizeComparableNavigationUrl(url);
    if (stayedOnUnrelatedPreviousPage || !body.text?.trim()) throw navigationError;
  }
  return {
    url: resolved,
    body: body.text,
    markup: body.markup,
    ...(navigationError ? { navigationWarning: String(navigationError) } : {}),
  };
}

function normalizeComparableNavigationUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

/**
 * A `FetchResult`-shaped fetcher backed by the browser, for the engine's
 * enumeration helpers. Requests go through a real tab, so they carry the user's
 * cookies and TLS fingerprint — the main reason a local browser beats a
 * datacenter fetch on bot-protected storefronts.
 */
export function createTabFetcher(tab) {
  return async (url) => {
    try {
      const page = await openPage(tab, url);
      const body = page.body || "";
      // Chrome renders a soft 404 as a normal document, so the engine's
      // `status !== 200` guard needs help: an empty or error-shaped body for a
      // data endpoint is a miss, not an empty catalog.
      const status = body.trim() === "" ? 404 : 200;
      return { status, body, headers: {}, url: page.url };
    } catch (error) {
      return { status: 0, body: "", headers: {}, url, error: String(error) };
    }
  };
}

// ---------------------------------------------------------------------------
// Page readiness
// ---------------------------------------------------------------------------

const OVERLAY_SELECTORS = [
  "[role='dialog']",
  "[aria-modal='true']",
  ".modal.show",
  ".newsletter-modal",
  "#onetrust-banner-sdk",
  ".klaviyo-form",
];

const DISMISS_LABELS = ["Accept", "Accept all", "Close", "No thanks", "Got it", "同意", "接受", "关闭"];

/**
 * Best-effort overlay dismissal.
 *
 * The worker force-removes the overlay root via DOM mutation, which read-only
 * `evaluate` cannot do here. So this clicks real dismiss controls instead —
 * slower, but it goes through the same code path a user would, which is also
 * less likely to trip anti-bot heuristics. Returns the number dismissed.
 */
export async function dismissOverlays(tab, opts = {}) {
  const log = opts.log || (() => {});
  let dismissed = 0;
  for (const selector of OVERLAY_SELECTORS) {
    let overlay;
    try {
      overlay = tab.playwright.locator(selector);
      if ((await overlay.count()) === 0) continue;
      if (!(await overlay.first().isVisible())) continue;
    } catch {
      continue;
    }
    for (const label of DISMISS_LABELS) {
      try {
        const button = overlay.first().getByRole("button", { name: label });
        if ((await button.count()) !== 1) continue;
        await button.click({ timeoutMs: 5_000 });
        dismissed += 1;
        log("overlay_dismissed", { selector, label });
        break;
      } catch {
        // Try the next label.
      }
    }
  }
  if (dismissed === 0) {
    // Escape closes most well-behaved dialogs and costs one keystroke.
    try {
      await tab.playwright.locator("body").press("Escape", { timeoutMs: 3_000 });
    } catch {
      // Nothing focusable; ignore.
    }
  }
  return dismissed;
}

/**
 * Drive lazy-loaded content into the DOM before snapshotting.
 *
 * IntersectionObserver-mounted blocks and `data-src` images are the single
 * biggest cause of "the field exists on screen but not in the HTML". Read-only
 * `evaluate` cannot call `window.scrollTo`, so this pages down with real key
 * presses and stops as soon as the document stops growing.
 */
export async function lazyLoadScroll(tab, opts = {}) {
  const screens = opts.maxScreens || MAX_SCROLL_SCREENS;
  const body = tab.playwright.locator("body");
  let previousLength = 0;
  let stable = 0;
  let screensVisited = 0;
  let stoppedByError = false;
  for (let i = 0; i < screens; i += 1) {
    try {
      await body.press("PageDown", { timeoutMs: 5_000 });
    } catch {
      stoppedByError = true;
      break;
    }
    screensVisited += 1;
    await tab.playwright.waitForTimeout(350);
    let length = 0;
    try {
      length = await tab.playwright.evaluate(() => document.documentElement.outerHTML.length);
    } catch {
      stoppedByError = true;
      break;
    }
    if (length <= previousLength) {
      stable += 1;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    previousLength = length;
  }
  try {
    await body.press("Home", { timeoutMs: 5_000 });
  } catch {
    // Position does not matter for extraction; only the DOM does.
  }
  if (opts.returnReport === true) {
    return {
      documentLength: previousLength,
      screensVisited,
      stableRounds: stable,
      exhausted: stable >= 2,
      stoppedByError,
      hitScreenLimit: screensVisited >= screens && stable < 2,
    };
  }
  return previousLength;
}

/**
 * Expand tabs / accordions / "read more" blocks named by the profile.
 *
 * Only hints the learning step produced are used — this never hunts blindly,
 * because clicking arbitrary controls on a product page can add to cart.
 */
export async function expandDetailSections(tab, profile, opts = {}) {
  const log = opts.log || (() => {});
  const hints = [
    ...(profile?.interactionHints || []),
    ...Object.values(profile?.fieldPolicy || {}).flatMap((policy) => policy?.interactionHints || []),
  ];
  let expanded = 0;
  for (const hint of hints.slice(0, 8)) {
    if (hint.action === "scroll") continue;
    try {
      const target = hint.selectorHint
        ? tab.playwright.locator(hint.selectorHint)
        : tab.playwright.getByText(hint.labelPattern || "", { exact: false });
      const count = await target.count();
      if (count !== 1) {
        log("expand_skipped", { hint: hint.selectorHint || hint.labelPattern, count });
        continue;
      }
      await target.click({ timeoutMs: 8_000 });
      await tab.playwright.waitForTimeout(300);
      expanded += 1;
    } catch (error) {
      log("expand_failed", { hint: hint.selectorHint || hint.labelPattern, error: String(error) });
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Phase 1 — discovery
// ---------------------------------------------------------------------------

function isSafeCatalogUrl(baseUrl, value, opts = {}) {
  try {
    const parsed = new URL(value, baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const sameSite = isSameSite(baseUrl, parsed);
    if (!sameSite && opts.followVerifiedExternalProductLinks !== true) return false;
    if (!sameSite && isExcludedPortfolioOrigin(parsed.origin)) return false;
    if (!sameSite && EXTERNAL_NON_DETAIL_PATH_RE.test(parsed.pathname)) return false;
    if (parsed.origin === new URL(baseUrl).origin
        && (parsed.pathname.replace(/\/+$/, "") || "/") === "/") return false;
    if (NON_CATALOG_PATH_RE.test(parsed.pathname)) return false;
    if (/\.(?:css|js|json|xml|pdf|zip|jpe?g|png|webp|gif|svg|woff2?)$/i.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function collectLinksBySelectors(tab, selectors, limit = 1000) {
  try {
    const links = await tab.playwright.evaluate(({ selectors: pageSelectors, limit: pageLimit }) => {
      const elements = new Set();
      for (const selector of pageSelectors) {
        try {
          for (const element of document.querySelectorAll(selector)) elements.add(element);
        } catch {
          // Ignore a stale learned selector and keep the generic fallbacks.
        }
      }
      return [...elements].slice(0, pageLimit).map((element) => ({
        href: element.href || element.getAttribute("href") || "",
        text: (element.innerText
          || element.getAttribute("aria-label")
          || element.getAttribute("title")
          || element.querySelector("img")?.alt
          || "").trim().replace(/\s+/g, " ").slice(0, 160),
        className: String(element.className || "").slice(0, 240),
      }));
    }, { selectors, limit });
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

/**
 * Read anchors already identified by storefront product-card semantics. This
 * covers catalog shapes such as `/brands/<brand>/<slug>` that cannot be
 * recognized safely from URL syntax alone.
 */
export async function collectRenderedProductCardUrls(tab, baseUrl, opts = {}) {
  const learnedSelectors = (opts.productLinkSelectors || []).filter((selector) =>
    typeof selector === "string" && selector.trim() && selector.length <= 240
  );
  const selectors = (learnedSelectors.length > 0
    ? learnedSelectors
    : SEMANTIC_PRODUCT_LINK_SELECTORS).slice(0, 24);
  const links = await collectLinksBySelectors(
    tab,
    selectors,
    Math.min(2000, Math.max(1, opts.maxRenderedProductLinks || 1000)),
  );
  return dedupe(links
    .map((link) => link.href)
    .filter((url) => isSafeCatalogUrl(baseUrl, url, opts))
    .map((url) => normalizeProductUrl(url)));
}

/**
 * Some storefronts mount product cards asynchronously after the initial
 * DOMContentLoaded event. A zero-link first read is therefore not evidence of
 * an empty listing. Wait only when the mapped/semantic selector set returns
 * zero links, and stop as soon as the first real card appears.
 */
async function collectRenderedProductCardUrlsWhenReady(tab, baseUrl, opts = {}) {
  let links = await collectRenderedProductCardUrls(tab, baseUrl, opts);
  if (links.length > 0) return links;
  // Unit/fake tabs do not represent an asynchronously rendered browser page;
  // avoid turning their deterministic empty fixture into a five-second wait.
  if (!tab?.id) return links;

  // A visual/DOM snapshot is also a readiness signal for hydration-heavy
  // storefronts: some grids do not mount their anchors until the browser has
  // performed the accessibility/visibility pass used by the snapshot API.
  try {
    if (typeof tab.playwright.domSnapshot === "function") {
      await tab.playwright.domSnapshot();
      links = await collectRenderedProductCardUrls(tab, baseUrl, opts);
      if (links.length > 0) return links;
    }
  } catch {
    // Continue with the bounded polling fallback below.
  }

  const timeoutMs = Number.isFinite(Number(opts.listingSettleTimeoutMs))
    ? Math.min(15_000, Math.max(0, Number(opts.listingSettleTimeoutMs)))
    : 15_000;
  const pollMs = Number.isFinite(Number(opts.listingSettlePollMs))
    ? Math.min(2_000, Math.max(100, Number(opts.listingSettlePollMs)))
    : 350;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await tab.playwright.waitForTimeout(pollMs);
    } catch {
      break;
    }
    links = await collectRenderedProductCardUrls(tab, baseUrl, opts);
    if (links.length > 0) return links;
  }
  return links;
}

/**
 * Expand the one visually proven category path to sibling categories using
 * only the repeated selector mapped during replay.
 */
export async function collectVerifiedCategoryUrls(tab, baseUrl, opts = {}) {
  const selectors = (opts.categoryLinkSelectors || []).filter((selector) =>
    typeof selector === "string" && selector.trim() && selector.length <= 240
  ).slice(0, 16);
  if (selectors.length === 0) return [];
  const verifiedSeeds = (opts.verifiedListingSeeds || []).filter(Boolean);
  const verifiedFamilies = new Set(verifiedSeeds.map((value) => {
    try {
      return new URL(value, baseUrl).pathname.split("/").filter(Boolean)[0] || "";
    } catch {
      return "";
    }
  }).filter(Boolean));
  const links = await collectLinksBySelectors(tab, selectors, 500);
  return dedupe(links
    .map((link) => link.href)
    .filter((url) => {
      if (!isSafeCatalogUrl(baseUrl, url) || !isSameSite(baseUrl, url)) return false;
      if (looksLikeCategoryUrl(url)) return true;
      try {
        const family = new URL(url, baseUrl).pathname.split("/").filter(Boolean)[0] || "";
        return verifiedFamilies.has(family);
      } catch {
        return false;
      }
    })
    .map((url) => normalizeProductUrl(url)));
}

async function applyMappedListingPagination(tab, actions, opts = {}) {
  for (const action of actions || []) {
    if (action?.action !== "click" || !action.selector) continue;
    try {
      const locator = tab.playwright.locator(action.selector);
      const count = Math.min(await locator.count(), 20);
      for (let index = 0; index < count; index += 1) {
        const candidate = count === 1 ? locator : locator.nth(index);
        if (candidate.isVisible && !await candidate.isVisible()) continue;
        await candidate.click();
        await tab.playwright.waitForTimeout?.(opts.paginationSettleMs ?? 1_000);
        return { applied: true, selector: action.selector };
      }
    } catch {
      // A stale or exhausted mapped trigger is equivalent to no next page.
    }
  }
  return { applied: false };
}

/**
 * Recover small catalogs that render several products inside one page instead
 * of linking to independent detail URLs. Candidates are deliberately strict:
 * at least two unique blocks must each have a product-like title, image and
 * either semantic product markup or a local detail/buy action.
 */
export async function collectRenderedInlineProductRecords(tab, baseUrl, opts = {}) {
  const maxItems = Math.min(200, Math.max(1, opts.maxItems || 200));
  let candidates;
  try {
    candidates = await tab.playwright.evaluate(({ limit }) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const actionRe =
        /\b(?:add to (?:cart|bag)|buy now|shop now|view details?|see details?|drug facts?|learn more|a(?:ñ|n)adir al carrito|agregar al carrito|comprar ahora|ver detalles?|m[aá]s informaci[oó]n|ajouter au panier|acheter maintenant|voir les d[eé]tails?|en savoir plus|in den warenkorb|jetzt kaufen|details ansehen|mehr erfahren|aggiungi al carrello|acquista ora|vedi dettagli|dodaj do koszyka|kup teraz|szczeg[oó]ły|do ko[sš][ií]ku|koupit|zobrazit detail)\b/i;
      const genericTitleRe =
        /^(?:our )?(?:products?|shop|catalog|details?|drug facts?|learn more|buy now)$/i;
      const semanticSelector = [
        "[itemtype*='Product']",
        "[data-product-id]",
        "[data-product-sku]",
        ".product-card",
        ".productCard",
        ".product-item",
        ".product-grid-item",
        ".product-tile",
        ".product-list-item",
      ].join(",");
      const roots = new Map();
      const addRoot = (element, semantic = false) => {
        if (!(element instanceof Element)) return;
        const current = roots.get(element) || { semantic: false, action: false };
        current.semantic ||= semantic;
        current.action ||= actionRe.test(clean(element.innerText));
        roots.set(element, current);
      };

      for (const element of document.querySelectorAll(semanticSelector)) addRoot(element, true);
      for (const action of document.querySelectorAll("a,button,[role='button']")) {
        if (!actionRe.test(clean(action.textContent))) continue;
        const dialog = action.closest("dialog,[role='dialog'],.modal");
        if (dialog && dialog.querySelector("h1,h2,h3,h4,[itemprop='name']")
            && dialog.querySelector("img,picture source")) {
          addRoot(dialog, false);
        }
        let root = action.parentElement;
        for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
          const text = clean(root.innerText);
          const headings = root.querySelectorAll("h1,h2,h3,h4,[itemprop='name']");
          if (text.length >= 8 && text.length <= 3500 && headings.length >= 1
              && headings.length <= 5 && root.querySelector("img,picture source")) {
            addRoot(root, false);
            break;
          }
        }
      }

      const output = [];
      for (const [root, signals] of roots) {
        if (!signals.semantic && !signals.action) continue;
        const headings = [...root.querySelectorAll("h1,h2,h3,h4,[itemprop='name']")]
          .map((element) => ({ element, text: clean(element.textContent) }))
          .filter((item) => item.text && item.text.length <= 180);
        const primary = headings.find((item) => !genericTitleRe.test(item.text));
        if (!primary) continue;

        let title = primary.text;
        const sibling = primary.element.nextElementSibling;
        const subtitle = sibling && /^(?:p|h[2-6])$/i.test(sibling.tagName)
          ? clean(sibling.textContent)
          : "";
        if (subtitle && subtitle.length <= 160 && !actionRe.test(subtitle)
            && !/[$€£¥₹₽₩]|\b(?:EUR|USD|GBP|CAD|AUD|JPY|CNY)\b/i.test(subtitle)
            && !title.toLowerCase().includes(subtitle.toLowerCase())) {
          title = `${title} ${subtitle}`;
        }
        title = clean(title);
        if (title.length < 3 || title.length > 240 || genericTitleRe.test(title)) continue;

        const images = [];
        for (const image of root.querySelectorAll("img,picture source")) {
          const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
          const bestSrcset = srcset.split(",").map((part) => part.trim().split(/\s+/)[0])
            .filter(Boolean).pop();
          const src = bestSrcset
            || image.currentSrc
            || image.getAttribute("src")
            || image.getAttribute("data-src")
            || image.getAttribute("data-lazy-src");
          if (src) images.push(src);
        }
        if (images.length === 0) continue;

        const paragraphs = [...root.querySelectorAll("p")]
          .filter((element) => !/(?:footnote|disclaimer|legal)/i.test(element.className || ""))
          .map((element) => clean(element.textContent))
          .filter((text) => text.length >= 40 && text.length <= 1800
            && !actionRe.test(text) && !title.includes(text));
        const detailLink = primary.element.closest("a[href]")
          || root.querySelector([
            "a[itemprop='url'][href]",
            "a.product-item-link[href]",
            "a.product-item-photo[href]",
            "a[data-product-url][href]",
            "a[href]",
          ].join(","));
        output.push({
          title,
          description: paragraphs.sort((a, b) => b.length - a.length)[0] || "",
          text: clean(root.innerText).slice(0, 4000),
          images,
          semantic: signals.semantic,
          action: signals.action,
          href: detailLink?.href || "",
        });
        if (output.length >= limit * 4) break;
      }
      return output;
    }, { limit: maxItems }, { timeoutMs: NAV_TIMEOUT_MS });
  } catch {
    return [];
  }
  if (!Array.isArray(candidates)) return [];

  const recordsByTitle = new Map();
  for (const candidate of candidates) {
    const title = String(candidate?.title || "").replace(/\s+/g, " ").trim();
    const titleKey = normalizeInlineTitleKey(title);
    if (!titleKey) continue;
    const images = dedupeImagesByIdentity(
      (candidate.images || [])
        .map((url) => normalizeImageUrl(url, baseUrl))
        .filter((url) => url && isLikelyCrawlImageUrl(url, baseUrl)),
      baseUrl,
    );
    if (images.length === 0) continue;
    const candidateHref = (() => {
      try {
        if (typeof candidate.href !== "string" || candidate.href.trim() === "") return "";
        const url = new URL(candidate.href, baseUrl).toString();
        const sameSite = isSameSite(baseUrl, url);
        const verifiedExternal = opts.followVerifiedExternalProductLinks === true
          && isSafeCatalogUrl(baseUrl, url, opts);
        return (sameSite || verifiedExternal) && isSafeCatalogUrl(baseUrl, url, opts)
          ? normalizeProductUrl(url)
          : "";
      } catch {
        return "";
      }
    })();
    const sourceUrl = candidateHref
      || `${String(baseUrl).replace(/#.*$/, "")}#inline-product=${encodeURIComponent(titleKey)}`;
    const price = inlinePriceFromText(candidate.text);
    const record = {
      sourceUrl,
      pageType: "detail",
      fields: {
        url: sourceUrl,
        ...(candidateHref ? { product_url: candidateHref } : {}),
        title,
        name: title,
        ...(candidate.description ? { description: candidate.description } : {}),
        images,
        ...(price ? { price } : {}),
      },
      _meta: {
        layer: "inline-catalog",
        sourcePageUrl: String(baseUrl).replace(/#.*$/, ""),
        detailPageDiscovered: Boolean(candidateHref),
      },
    };
    const previous = recordsByTitle.get(titleKey);
    recordsByTitle.set(titleKey, previous
      ? mergeProductRecords([previous, record])[0]
      : record);
  }
  const records = [...recordsByTitle.values()];
  const minimum = Math.max(2, opts.minInlineProducts || 2);
  return records.length >= minimum ? records.slice(0, maxItems) : [];
}

function normalizeInlineTitleKey(value) {
  const key = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return key.length >= 3 ? key.slice(0, 180) : "";
}

function inlinePriceFromText(value) {
  const text = String(value || "");
  return text.match(
    /(?:(?:[$€£¥₹₽₩]|EUR|USD|GBP|CAD|AUD|JPY|CNY|Kč|zł)\s*\d{1,6}(?:(?:[ .'’]\d{3})+)?(?:[.,]\d{1,2})?|\d{1,6}(?:(?:[ .'’]\d{3})+)?(?:[.,]\d{1,2})?\s*(?:[$€£¥₹₽₩]|EUR|USD|GBP|CAD|AUD|JPY|CNY|Kč|zł))/i,
  )?.[0]?.trim() || "";
}

/**
 * Replay an already verified corporate -> storefront relationship.
 *
 * The old DOM/platform portfolio discovery path is intentionally gone. A new
 * relationship must first be proven visually and supplied as verifiedSites;
 * later runs replay the persisted portfolio profile.
 */
export async function discoverPortfolioSites(_tab, _startUrl, opts = {}) {
  if (opts.forcePortfolioDiscovery === true) {
    throw new Error("automatic_portfolio_discovery_removed");
  }
  const cachedSites = opts.verifiedSites || opts.portfolioProfile?.sites || [];
  if (cachedSites.length === 0) {
    throw new Error("visual_portfolio_route_required");
  }
  const normalized = normalizeDirectBrandSites(_startUrl, cachedSites);
  if (normalized.sites.length === 0) {
    const error = new Error("visual_direct_brand_route_required");
    error.code = "visual_direct_brand_route_required";
    error.rejectedSites = normalized.rejected;
    throw error;
  }
  const requestedMaxOrigins = Number(opts.maxOrigins ?? 12);
  const maxOrigins = Number.isFinite(requestedMaxOrigins) && requestedMaxOrigins > 0
    ? Math.max(1, Math.floor(requestedMaxOrigins))
    : 12;
  const admittedSites = normalized.sites.slice(0, maxOrigins);
  const rejectedSites = [
    ...normalized.rejected,
    ...normalized.sites.slice(maxOrigins).map((site) => ({
      origin: site.origin,
      depth: 1,
      reason: "portfolio_origin_limit",
    })),
  ];
  return {
    sites: admittedSites.map((site) => ({
      ...site,
      profileReplay: !opts.verifiedSites,
    })),
    candidates: [],
    rejectedSites,
    source: opts.verifiedSites ? "verified_visual_portfolio" : "portfolio_profile",
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — listing pagination
// ---------------------------------------------------------------------------

/**
 * Walk a listing seed and its pagination, collecting product detail URLs.
 *
 * Returns explicit per-seed completion evidence. Reaching maxItems, a page
 * limit, a fetch failure, or missing pagination proof is resumable incomplete
 * work, never catalog exhaustion.
 */
export async function collectProductUrls(tab, seedUrls, opts = {}) {
  const log = opts.log || (() => {});
  const maxItems = opts.maxItems || 200;
  const maxPagesPerSeed = opts.maxPagesPerSeed || 50;
  const found = new Set(opts.known || []);
  const inlineRecords = new Map(
    (opts.knownInlineRecords || []).map((record) => [record.sourceUrl, record]),
  );
  const visited = new Set();
  const storefrontOrigins = new Set(opts.storefrontOrigins || []);
  const listingProofs = new Map(
    (opts.listingCoverage || []).map((listing) => [listing.url, listing]),
  );
  const seedReports = [];
  let externalProductUrlsFound = 0;
  let pagesVisited = 0;

  for (const [seedIndex, seed] of seedUrls.entries()) {
    const proof = listingProofs.get(seed) || null;
    const seedReport = {
      seedUrl: seed,
      status: "incomplete",
      pagesVisited: 0,
      uniqueProductsAdded: 0,
      endReason: "not_started",
      paginationMode: proof?.paginationMode ?? null,
      verifiedVisually: proof?.verifiedVisually === true,
    };
    seedReports.push(seedReport);
    if (found.size + inlineRecords.size >= maxItems) {
      seedReport.endReason = "max_items_reached";
      for (const pendingSeed of seedUrls.slice(seedIndex + 1)) {
        seedReports.push({
          seedUrl: pendingSeed,
          status: "incomplete",
          pagesVisited: 0,
          uniqueProductsAdded: 0,
          endReason: "not_started_max_items_reached",
          paginationMode: listingProofs.get(pendingSeed)?.paginationMode ?? null,
          verifiedVisually: listingProofs.get(pendingSeed)?.verifiedVisually === true,
        });
      }
      break;
    }
    let pageUrl = seed;
    let emptyRounds = 0;
    let reuseCurrentPage = false;
    const productsBeforeSeed = found.size + inlineRecords.size;
    let ended = false;
    for (let page = 0;
      page < maxPagesPerSeed && found.size + inlineRecords.size < maxItems;
      page += 1) {
      let listing;
      if (reuseCurrentPage) {
        const rendered = await readPageBody(tab);
        listing = {
          url: await tab.url().catch(() => pageUrl) || pageUrl,
          body: rendered.text,
          markup: rendered.markup,
        };
      } else {
        if (!pageUrl) {
          seedReport.endReason = "listing_url_missing";
          ended = true;
          break;
        }
        if (visited.has(pageUrl)) {
          seedReport.endReason = "pagination_url_loop";
          ended = true;
          break;
        }
        visited.add(pageUrl);
        try {
          listing = await openPage(tab, pageUrl);
        } catch (error) {
          log("listing_fetch_failed", { url: pageUrl, error: String(error) });
          seedReport.endReason = "listing_fetch_failed";
          ended = true;
          break;
        }
      }
      pagesVisited += 1;
      seedReport.pagesVisited += 1;
      reuseCurrentPage = false;

      let body = listing.body;
      let semanticUrls = await collectRenderedProductCardUrlsWhenReady(tab, listing.url, opts);
      let scrollReport = null;
      if (opts.scrollListings !== false) {
        scrollReport = await lazyLoadScroll(tab, {
          maxScreens: opts.listingScrollScreens ?? MAX_SCROLL_SCREENS,
          returnReport: true,
        });
        const rendered = await readPageBody(tab);
        body = rendered.text || body;
        semanticUrls = dedupe([
          ...semanticUrls,
          ...await collectRenderedProductCardUrlsWhenReady(tab, listing.url, opts),
        ]);
      }

      const before = found.size;
      const hasMappedProductSelector = (opts.productLinkSelectors || []).length > 0;
      const deterministicUrls = hasMappedProductSelector
        ? []
        : collectDetailUrls(listing.url, body);
      for (const url of dedupe([...semanticUrls, ...deterministicUrls])) {
        const sameSite = isSameSite(seed, url);
        const verifiedExternal = !sameSite
          && semanticUrls.includes(url)
          && isSafeCatalogUrl(listing.url, url, opts);
        if (!sameSite && !verifiedExternal) continue;
        const normalizedUrl = normalizeProductUrl(url);
        const isNew = !found.has(normalizedUrl);
        found.add(normalizedUrl);
        if (verifiedExternal && isNew) {
          externalProductUrlsFound += 1;
          storefrontOrigins.add(new URL(url).origin);
        }
        if (found.size + inlineRecords.size >= maxItems) break;
      }
      let added = found.size - before;
      const inlineCatalogConfirmed = opts.listingMode === "inline_catalog"
        || opts.allowInlineCatalogFallback === true;
      if (added === 0 && inlineCatalogConfirmed) {
        const inline = await collectRenderedInlineProductRecords(tab, listing.url, {
          ...opts,
          maxItems: maxItems - found.size,
        });
        const beforeInline = inlineRecords.size;
        for (const record of inline) {
          if (record?._meta?.detailPageDiscovered) {
            const isNew = !found.has(record.sourceUrl);
            found.add(record.sourceUrl);
            if (!isSameSite(seed, record.sourceUrl) && isNew) {
              externalProductUrlsFound += 1;
              storefrontOrigins.add(new URL(record.sourceUrl).origin);
            }
          } else {
            inlineRecords.set(record.sourceUrl, record);
          }
        }
        added += inlineRecords.size - beforeInline;
        added += found.size - before;
      }
      log("listing_page", {
        url: pageUrl,
        added,
        total: found.size + inlineRecords.size,
        inlineRecords: inlineRecords.size,
      });

      emptyRounds = added === 0 ? emptyRounds + 1 : 0;
      if (emptyRounds >= 2) {
        if (proof?.verifiedVisually === true && proof.paginationMode !== "none") {
          seedReport.status = "complete";
          seedReport.endReason = "stable_after_verified_pagination";
        } else {
          seedReport.endReason = "unverified_no_new_products";
        }
        ended = true;
        break;
      }

      if (found.size + inlineRecords.size >= maxItems) {
        seedReport.endReason = "max_items_reached";
        ended = true;
        break;
      }

      const nextPageUrl = findNextListingPage(listing.url, body, visited);
      if (nextPageUrl) {
        pageUrl = nextPageUrl;
        continue;
      }
      const pagination = await applyMappedListingPagination(
        tab,
        opts.paginationActions,
        opts,
      );
      if (pagination.applied) {
        reuseCurrentPage = true;
        pageUrl = listing.url;
        log("listing_pagination_replay", {
          url: listing.url,
          selector: pagination.selector,
        });
        continue;
      }
      if (proof?.verifiedVisually !== true) {
        seedReport.endReason = "pagination_mapping_missing";
      } else if (proof.paginationMode === "none") {
        seedReport.status = "complete";
        seedReport.endReason = "verified_single_page";
      } else if (proof.paginationMode === "link") {
        seedReport.status = "complete";
        seedReport.endReason = "verified_last_page";
      } else if (proof.paginationMode === "scroll") {
        if (scrollReport?.exhausted) {
          seedReport.status = "complete";
          seedReport.endReason = "verified_scroll_stable";
        } else {
          seedReport.endReason = scrollReport?.hitScreenLimit
            ? "listing_scroll_limit_reached"
            : "listing_scroll_not_stable";
        }
      } else if (proof.paginationMode === "click") {
        const hasMappedClick = (opts.paginationActions || []).some((action) =>
          action?.action === "click" && action.selector
        );
        if (hasMappedClick) {
          seedReport.status = "complete";
          seedReport.endReason = "verified_pagination_control_exhausted";
        } else {
          seedReport.endReason = "pagination_action_missing";
        }
      }
      ended = true;
      break;
    }
    seedReport.uniqueProductsAdded = found.size + inlineRecords.size - productsBeforeSeed;
    if (!ended && seedReport.status !== "complete") {
      seedReport.endReason = found.size + inlineRecords.size >= maxItems
        ? "max_items_reached"
        : "max_pages_reached";
    }
    if (found.size + inlineRecords.size >= maxItems) {
      for (const pendingSeed of seedUrls.slice(seedIndex + 1)) {
        seedReports.push({
          seedUrl: pendingSeed,
          status: "incomplete",
          pagesVisited: 0,
          uniqueProductsAdded: 0,
          endReason: "not_started_max_items_reached",
          paginationMode: listingProofs.get(pendingSeed)?.paginationMode ?? null,
          verifiedVisually: listingProofs.get(pendingSeed)?.verifiedVisually === true,
        });
      }
      break;
    }
  }

  const productUrls = [...found].slice(0, maxItems);
  const incompleteSeeds = seedReports.filter((report) => report.status !== "complete");
  return {
    productUrls,
    inlineRecords: [...inlineRecords.values()].slice(0, Math.max(0, maxItems - productUrls.length)),
    pagesVisited,
    storefrontOrigins: [...storefrontOrigins],
    externalProductUrlsFound,
    coverage: {
      status: seedReports.length > 0 && incompleteSeeds.length === 0
        ? "complete"
        : "incomplete",
      seedReports,
      incompleteSeeds: incompleteSeeds.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — detail extraction
// ---------------------------------------------------------------------------

/** Build the evidence object the engine's profile applier expects. */
function detailEvidence(url, html, requestedFields, imageProfile) {
  return { kind: "detail-extraction", url, html, requestedFields, imageProfile: imageProfile || null };
}

function extractOne(url, html, profile, requestedFields, imageProfile) {
  // An empty profile still works: `applyDetailExtractionProfile` falls back to
  // deterministic DOM extraction for every field its rules did not produce.
  const runtimeProfile = profile || { version: 1, kind: "detail-extraction" };
  const evidence = detailEvidence(url, html, requestedFields, imageProfile);
  const result = applyDetailExtractionProfile({
    profile: runtimeProfile,
    evidence,
    imageProfile: imageProfile || null,
  });
  const missing = missingDetailExtractionFields(result.record, requestedFields);
  const split = splitMissingDetailExtractionFieldsByPolicy(missing, profile);
  const validation = validateDetailExtractionProfile(runtimeProfile, result, evidence);
  return {
    record: result.record,
    missing,
    requiredMissing: split.requiredMissingFields,
    basicRecordPresent: validation.basicRecordPresent,
  };
}

/**
 * Fast path: load a batch of product pages in background tabs and extract.
 *
 * `browser.tabs.content` parallelises page loads, so this is where the bulk of
 * a catalog gets processed. It cannot interact, so anything behind an accordion
 * comes back missing and is handed to `upgradeProducts`.
 */
export async function extractProductsBatch(browser, urls, opts = {}) {
  const log = opts.log || (() => {});
  const requestedFields = opts.fields || DEFAULT_FIELDS;
  const profile = opts.profile || null;
  const imageProfile = opts.imageProfile || null;
  const size = opts.batchSize || BATCH_SIZE;

  const records = [];
  const needsUpgrade = [];
  const failed = [];
  let partialRecordsKept = 0;

  for (let start = 0; start < urls.length; start += size) {
    const chunk = urls.slice(start, start + size);
    let results;
    try {
      results = await browser.tabs.content({
        urls: chunk,
        contentType: "html",
        timeoutMs: opts.timeoutMs || BATCH_TIMEOUT_MS,
      });
    } catch (error) {
      log("batch_failed", { start, size: chunk.length, error: String(error) });
      needsUpgrade.push(...chunk);
      continue;
    }
    for (const [index, result] of results.entries()) {
      const url = result.url || chunk[index];
      if (!result.content) {
        failed.push({ url, reason: "empty_content" });
        needsUpgrade.push(url);
        continue;
      }
      const { record, requiredMissing, basicRecordPresent } = extractOne(
        url,
        result.content,
        profile,
        requestedFields,
        imageProfile,
      );
      if (record && basicRecordPresent) {
        records.push(record);
        if (requiredMissing.length > 0) partialRecordsKept += 1;
        if (requiredMissing.length > 0
            || recordNeedsRenderedImageUpgrade(record, requestedFields, opts)) {
          needsUpgrade.push(url);
        }
      } else {
        needsUpgrade.push(url);
      }
    }
    log("batch_done", {
      progress: `${Math.min(start + size, urls.length)}/${urls.length}`,
      ok: records.length,
      upgrade: needsUpgrade.length,
    });
    await opts.onProgress?.({
      phase: "detail_batch",
      processed: Math.min(start + size, urls.length),
      total: urls.length,
      records: [...records],
      needsUpgrade: dedupe(needsUpgrade),
      failed: [...failed],
    });
  }

  return {
    records,
    needsUpgrade: dedupe(needsUpgrade),
    failed,
    partialRecordsKept,
  };
}

/**
 * Compactly project product-gallery image attributes from the rendered DOM.
 *
 * This avoids returning a multi-hundred-kilobyte page snapshot merely to find
 * gallery images. The selector set describes common gallery structures rather
 * than any storefront or platform.
 */
export async function collectRenderedProductImageUrls(tab, baseUrl, opts = {}) {
  let rawUrls;
  try {
    rawUrls = await tab.playwright.evaluate(() => {
      const productImageRoots = [
        "[data-gallery-role]",
        "[data-role*='gallery']",
        "[data-product-gallery]",
        ".gallery-placeholder",
        ".fotorama",
        ".fotorama__stage",
        ".fotorama__nav",
        ".product.media",
        ".product-media",
        ".product__media",
        ".product-gallery",
        ".product__gallery",
        ".product__media-gallery",
        ".woocommerce-product-gallery",
        ".foto-grande",
        "[class*='foto-'][class*='grande']",
        "[class*='foto-'][class*='piccola']",
        "[class*='pdp'][class*='gallery']",
        "[class*='product'][class*='gallery']",
      ];
      const roots = [...new Set(productImageRoots.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
      ))];
      const galleryElements = new Set();
      for (const root of roots) {
        const linkedOriginal = root.closest("a[href]");
        if (linkedOriginal) galleryElements.add(linkedOriginal);
        if (root.matches("img, source, a[href]")) galleryElements.add(root);
        for (const element of root.querySelectorAll("img, source, a[href]")) {
          galleryElements.add(element);
        }
      }
      for (const element of document.querySelectorAll([
        "img[x-ref*='gallery']",
        "img[aria-describedby*='main-image']",
        "img[aria-describedby*='fullscreen']",
        "img[alt*='thumbnail']",
        "img[title*='thumbnail']",
        "img[data-zoom-src]",
        "img[data-zoom-image]",
        "img[data-large-image]",
        "img[data-large_image]",
      ].join(","))) galleryElements.add(element);
      const out = [];
      const seen = new Set();
      const add = (value) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
      };
      const addSrcset = (value) => {
        if (typeof value !== "string") return;
        for (const part of value.split(",")) add(part.trim().split(/\s+/, 1)[0]);
      };
      for (const element of galleryElements) {
        if (element.tagName === "A") add(element.getAttribute("href"));
        if (element.tagName === "IMG") add(element.currentSrc);
        for (const attribute of [
          "data-zoom-src",
          "data-zoom-image",
          "data-large_image",
          "data-large-image",
          "data-original",
          "data-master",
          "data-full",
          "data-src",
          "src",
        ]) add(element.getAttribute(attribute));
        addSrcset(element.getAttribute("srcset"));
        addSrcset(element.getAttribute("data-srcset"));
        const background = element.getAttribute("style")?.match(
          /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i,
        )?.[2];
        add(background);
      }
      for (const meta of document.querySelectorAll(
        "meta[property='og:image'], meta[property='og:image:secure_url'], meta[name='twitter:image']",
      )) add(meta.getAttribute("content"));
      return out.slice(0, 80);
    }, undefined, { timeoutMs: opts.timeoutMs || NAV_TIMEOUT_MS });
  } catch {
    return [];
  }
  if (!Array.isArray(rawUrls)) return [];

  const images = [];
  for (const rawUrl of rawUrls) {
    if (typeof rawUrl !== "string") continue;
    try {
      const normalized = normalizeImageUrl(rawUrl, baseUrl);
      if (!/^https?:/i.test(normalized)) continue;
      if (!isLikelyCrawlImageUrl(normalized, baseUrl)) continue;
      images.push(normalized);
    } catch {
      // Ignore malformed lazy-load placeholders.
    }
  }
  return dedupeImagesByIdentity(images, baseUrl);
}

/**
 * Read a compact, field-focused projection from the rendered DOM.
 *
 * Browser transports may cap `document.documentElement.outerHTML` at roughly
 * 200 KB. Price and facts nodes near the end of a large page would otherwise
 * disappear even though they are visible in the live DOM.
 */
export async function collectRenderedDetailEvidence(tab, opts = {}) {
  const customSelectors = Object.values(opts.profile?.fieldRules || {})
    .flatMap((rules) => Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.mode === "selector_text")
    .flatMap((rule) => Array.isArray(rule.selectors) ? rule.selectors : [])
    .filter((selector) => typeof selector === "string" && selector.trim())
    .slice(0, 32);
  try {
    const html = await tab.playwright.evaluate((input) => {
      const priceSelectors = [
        ".primary-price",
        "[class*='current-price']",
        "[class*='sale-price']",
        ".final-price",
        "meta[itemprop='price']",
        "[itemprop='price']",
        "[data-price-type='finalPrice']",
        "[data-price]",
        "[data-price-amount]",
        "[data-product-price]",
        "money",
        "[class*='price']",
        "[id*='price']",
      ];
      const selectors = [
        ...(input?.customSelectors || []),
        ...priceSelectors.map((selector) => `__PRIMARY__${selector}`),
        "meta[itemprop='price']",
        "[itemtype*='Product'] [itemprop='price']",
        "main [data-price-type='finalPrice']",
        "main .final-price",
        "main .primary-price",
        "main [class*='current-price']",
        "main [class*='sale-price']",
        "main [data-price]",
        "main [data-price-amount]",
        "main [data-product-price]",
        "main [class*='price']",
        "main [id*='price']",
        "[itemprop='price']",
        "[data-price]",
        "[data-price-amount]",
        "[data-product-price]",
        "money",
        "main h1",
        "h1",
        "meta[property='og:title']",
        "meta[name='description']",
        "main [itemprop='description']",
        "main [class*='description']",
        "main details",
        "main table",
      ];
      const snippets = [];
      const seen = new Set();
      const h1 = document.querySelector("main h1") || document.querySelector("h1");
      let primaryRoot = h1?.parentElement || null;
      while (primaryRoot && primaryRoot !== document.body) {
        const hasVisiblePrice = priceSelectors.some((selector) => {
          try {
            return [...primaryRoot.querySelectorAll(selector)]
              .some((element) => element.matches("meta") || element.getClientRects().length > 0);
          } catch {
            return false;
          }
        });
        if (hasVisiblePrice) break;
        primaryRoot = primaryRoot.parentElement;
      }
      const isVisibleOrMetadata = (element) => {
        if (element.matches("meta, title")) return true;
        return element.getClientRects().length > 0;
      };
      for (const rawSelector of selectors) {
        const primaryOnly = rawSelector.startsWith("__PRIMARY__");
        const selector = primaryOnly ? rawSelector.slice("__PRIMARY__".length) : rawSelector;
        let elements;
        try {
          const root = primaryOnly && primaryRoot ? primaryRoot : document;
          elements = [...root.querySelectorAll(selector)].slice(0, 10);
        } catch {
          continue;
        }
        for (const element of elements) {
          if (!isVisibleOrMetadata(element)) continue;
          const markup = (element.outerHTML || "").slice(0, 8000);
          if (!markup || seen.has(markup)) continue;
          seen.add(markup);
          snippets.push(markup);
          if (snippets.length >= 80) break;
        }
        if (snippets.length >= 80) break;
      }
      return `<spider-field-capture>${snippets.join("\n")}</spider-field-capture>`.slice(0, 80_000);
    }, { customSelectors }, { timeoutMs: opts.timeoutMs || NAV_TIMEOUT_MS });
    return typeof html === "string" ? html : "";
  } catch {
    return "";
  }
}

/**
 * Slow path: one product at a time, with the interactions a real user performs.
 *
 * The default never disables detail work. A caller may explicitly set
 * `disableAfter` as a cost guard, but every resulting skip is surfaced as a
 * model-review item rather than being treated as a successful partial record.
 */
export async function upgradeProducts(tab, urls, opts = {}) {
  const log = opts.log || (() => {});
  const requestedFields = opts.fields || DEFAULT_FIELDS;
  const profile = opts.profile || null;
  const imageProfile = opts.imageProfile || null;
  const disableAfter = opts.disableAfter ?? 0;
  const wantsImages = requestedFields.includes("images") || requestedFields.includes("image");
  const baselineRecords = mergeProductRecords(opts.baselineRecords || []);
  const baselineByUrl = new Map(baselineRecords.map((record) => [recordIdentity(record), record]));

  const records = [];
  const failed = [];
  const skipped = [];
  const fruitlessBySignature = new Map();
  let activeTab = tab;

  const upgradeSignature = (url) => {
    const baseline = baselineByUrl.get(url);
    if (!baseline) return null;
    const requiredMissing = splitMissingDetailExtractionFieldsByPolicy(
      missingDetailExtractionFields(baseline, requestedFields),
      profile,
    ).requiredMissingFields.sort();
    const imageUpgrade = recordNeedsRenderedImageUpgrade(baseline, requestedFields, opts);
    return `fields:${requiredMissing.join(",")}|images:${imageUpgrade ? "1" : "0"}`;
  };

  for (const [index, url] of urls.entries()) {
    const signature = upgradeSignature(url);
    if (signature && disableAfter > 0
        && (fruitlessBySignature.get(signature) || 0) >= disableAfter) {
      log("upgrade_disabled", {
        after: index,
        reason: "no_improvement_for_signature",
        signature,
      });
      skipped.push({
        url,
        reason: "upgrade_disabled",
        signature,
        requiresModelReview: true,
      });
      await opts.onProgress?.({
        phase: "detail_upgrade",
        processed: index + 1,
        total: urls.length,
        records: [...records],
        failed: [...failed],
        skipped: [...skipped],
      });
      continue;
    }
    try {
      const browserEvidence = shouldUseLearnedCdp(opts)
        ? await captureBrowserEvidence(activeTab, url, opts)
        : null;
      if (!browserEvidence) await openPage(activeTab, url);
      await dismissOverlays(activeTab, { log });
      if (profile) await expandDetailSections(activeTab, profile, { log });
      if (wantsImages) await lazyLoadScroll(activeTab);
      const renderedImages = wantsImages
        ? dedupeImagesByIdentity([
          ...(browserEvidence?.productImages || []),
          ...await collectRenderedProductImageUrls(activeTab, url, opts),
        ], url)
        : [];
      const renderedDetailEvidence = await collectRenderedDetailEvidence(activeTab, {
        ...opts,
        profile,
      });
      const body = await readPageBody(activeTab);
      const extracted = [
        renderedDetailEvidence
          ? extractOne(url, renderedDetailEvidence, profile, requestedFields, imageProfile).record
          : null,
        browserEvidence?.html
          ? extractOne(url, browserEvidence.html, profile, requestedFields, imageProfile).record
          : null,
        ...(browserEvidence?.network?.responseBodies || []).map((response) =>
          extractOne(url, response.body, profile, requestedFields, imageProfile).record
        ),
        body.text
          ? extractOne(url, body.text, profile, requestedFields, imageProfile).record
          : null,
      ].filter(Boolean);
      const record = mergeProductRecords(extracted)[0] || null;
      if (record) {
        if (renderedImages.length > 0) {
          const existingImages = recordImageUrls(record);
          record.fields.images = dedupeImagesByIdentity([...existingImages, ...renderedImages], url);
        }
        const baseline = baselineByUrl.get(recordIdentity(record));
        const baselineImageCount = baseline ? recordImageUrls(baseline).length : 0;
        const merged = baseline ? mergeProductRecords([baseline, record])[0] : record;
        records.push(merged);
        const finalMissing = missingDetailExtractionFields(merged, requestedFields);
        const requiredMissing = splitMissingDetailExtractionFieldsByPolicy(finalMissing, profile).requiredMissingFields;
        const baselineRequiredMissing = baseline
          ? splitMissingDetailExtractionFieldsByPolicy(
            missingDetailExtractionFields(baseline, requestedFields),
            profile,
          ).requiredMissingFields
          : requestedFields;
        const imageUpgradeWasNeeded = baseline
          ? recordNeedsRenderedImageUpgrade(baseline, requestedFields, opts)
          : false;
        const imageImproved = recordImageUrls(merged).length > baselineImageCount;
        const fieldImproved = requiredMissing.length < baselineRequiredMissing.length;
        if (signature) {
          const useful = fieldImproved || imageImproved
            || requiredMissing.length === 0
              && (!imageUpgradeWasNeeded || imageImproved);
          fruitlessBySignature.set(
            signature,
            useful ? 0 : (fruitlessBySignature.get(signature) || 0) + 1,
          );
        }
      } else {
        const entry = { url, reason: "no_record" };
        if (baselineByUrl.has(url)) skipped.push({ ...entry, requiresModelReview: true });
        else failed.push(entry);
        if (signature) {
          fruitlessBySignature.set(
            signature,
            (fruitlessBySignature.get(signature) || 0) + 1,
          );
        }
      }
    } catch (error) {
      if (opts.browser && shouldDiscardBrowserTab(error)) {
        try {
          const recovery = await replaceTaintedTab(opts.browser, activeTab, error);
          activeTab = recovery.tab;
          opts.onTabReplaced?.(activeTab, { url, error });
          const retry = await upgradeProducts(activeTab, [url], {
            ...opts,
            browser: undefined,
            onTabReplaced: undefined,
            disableAfter: 0,
          });
          records.push(...retry.records);
          failed.push(...retry.failed);
          skipped.push(...retry.skipped);
          continue;
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      const entry = { url, reason: String(error) };
      if (baselineByUrl.has(url)) skipped.push({ ...entry, requiresModelReview: true });
      else failed.push(entry);
      if (signature) {
        fruitlessBySignature.set(
          signature,
          (fruitlessBySignature.get(signature) || 0) + 1,
        );
      }
    }
    if ((index + 1) % 10 === 0) log("upgrade_progress", { done: index + 1, total: urls.length });
    await opts.onProgress?.({
      phase: "detail_upgrade",
      processed: index + 1,
      total: urls.length,
      records: [...records],
      failed: [...failed],
      skipped: [...skipped],
    });
  }

  return { records, failed, skipped, tab: activeTab };
}

// ---------------------------------------------------------------------------
// Original image resolution
// ---------------------------------------------------------------------------

/**
 * Open a proposed original-image URL and verify that the browser rendered a
 * real, sufficiently large image document.
 */
export async function probeOriginalImage(tab, url, opts = {}) {
  const minDimension = opts.minDimension ?? ORIGINAL_IMAGE_MIN_DIMENSION;
  let navigationError = null;
  try {
    try {
      await tab.goto(url);
    } catch (error) {
      // Some browser backends time out waiting for Page.navigate even though
      // the image document has already rendered. Inspect the resulting page
      // before treating the candidate as failed.
      navigationError = error;
    }
    try {
      await tab.playwright.waitForLoadState({
        state: "domcontentloaded",
        timeoutMs: opts.timeoutMs || NAV_TIMEOUT_MS,
      });
    } catch {
      // Image documents often finish before Chrome reports a stable HTML state.
    }
    const result = await tab.playwright.evaluate(() => {
      const image = document.images?.[0] ?? document.querySelector("img");
      return {
        contentType: document.contentType || "",
        width: image?.naturalWidth ?? 0,
        height: image?.naturalHeight ?? 0,
      };
    }, undefined, { timeoutMs: opts.timeoutMs || NAV_TIMEOUT_MS });
    const ok = result.contentType.toLowerCase().startsWith("image/")
      && Math.max(result.width, result.height) >= minDimension;
    return {
      ok,
      url,
      ...result,
      ...(!ok && navigationError ? { error: String(navigationError) } : {}),
    };
  } catch (error) {
    const errors = [navigationError, error].filter(Boolean).map(String);
    return { ok: false, url, contentType: "", width: 0, height: 0, error: errors.join("; ") };
  }
}

/**
 * Upgrade transformed/cache image URLs after product extraction.
 *
 * Candidates are grouped by platform/CDN transform family. A small sample from
 * each group is opened in the real browser; the group is rewritten only when
 * every sample is a valid high-resolution image. Rejected or untested groups
 * keep the exact source URLs extracted from the product pages.
 */
export async function upgradeProductImageUrls(tab, records, opts = {}) {
  const log = opts.log || (() => {});
  const sampleSize = Math.max(1, opts.originalImageSampleSize ?? ORIGINAL_IMAGE_SAMPLE_SIZE);
  const maxGroups = Math.max(1, opts.originalImageMaxGroups ?? ORIGINAL_IMAGE_MAX_GROUPS);
  const groups = new Map();
  const candidatesBySource = new Map();

  for (const record of records) {
    for (const fieldName of ["images", "image"]) {
      const value = record?.fields?.[fieldName];
      const images = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      for (const sourceUrl of images) {
        if (typeof sourceUrl !== "string" || candidatesBySource.has(sourceUrl)) continue;
        const candidate = deriveCrawlOriginalImageCandidate(sourceUrl, record.sourceUrl);
        if (!candidate) continue;
        candidatesBySource.set(sourceUrl, candidate);
        const group = groups.get(candidate.validationGroup) || {
          resolver: candidate.resolver,
          candidates: [],
        };
        group.candidates.push(candidate);
        groups.set(candidate.validationGroup, group);
      }
    }
  }

  const approvedGroups = new Set();
  const probes = [];
  for (const [groupKey, group] of [...groups.entries()].slice(0, maxGroups)) {
    const samples = uniqueImages(group.candidates.map((candidate) => candidate.originalUrl)).slice(0, sampleSize);
    const groupProbes = [];
    for (const originalUrl of samples) {
      groupProbes.push(await probeOriginalImage(tab, originalUrl, {
        minDimension: opts.originalImageMinDimension,
        timeoutMs: opts.originalImageTimeoutMs,
      }));
    }
    const approved = groupProbes.length > 0 && groupProbes.every((probe) => probe.ok);
    if (approved) approvedGroups.add(groupKey);
    probes.push(...groupProbes.map((probe) => ({
      resolver: group.resolver,
      validationGroup: groupKey,
      ...probe,
    })));
    log("original_image_group", {
      resolver: group.resolver,
      samples: groupProbes.length,
      approved,
    });
  }

  let imagesUpgraded = 0;
  const byResolver = {};
  for (const record of records) {
    for (const fieldName of ["images", "image"]) {
      const value = record?.fields?.[fieldName];
      const isArray = Array.isArray(value);
      const images = isArray ? value : typeof value === "string" ? [value] : [];
      if (images.length === 0) continue;
      const rewritten = images.map((sourceUrl) => {
        if (typeof sourceUrl !== "string") return sourceUrl;
        const candidate = candidatesBySource.get(sourceUrl);
        if (!candidate || !approvedGroups.has(candidate.validationGroup)) return sourceUrl;
        imagesUpgraded += 1;
        byResolver[candidate.resolver] = (byResolver[candidate.resolver] || 0) + 1;
        return candidate.originalUrl;
      });
      const deduped = uniqueImages(rewritten);
      record.fields[fieldName] = isArray ? deduped : (deduped[0] ?? value);
    }
  }

  return {
    candidateCount: candidatesBySource.size,
    groupsFound: groups.size,
    groupsValidated: Math.min(groups.size, maxGroups),
    groupsApproved: approvedGroups.size,
    groupsRejected: Math.min(groups.size, maxGroups) - approvedGroups.size,
    groupsSkipped: Math.max(0, groups.size - maxGroups),
    imagesUpgraded,
    byResolver,
    probes,
  };
}

// ---------------------------------------------------------------------------
// Learning support
// ---------------------------------------------------------------------------

/**
 * Open one representative product page fully expanded and report what
 * deterministic extraction already gets. The agent reads this — and only this,
 * not the whole catalog — to decide which fields still need profile rules.
 */
export async function captureLearningPage(tab, url, opts = {}) {
  const requestedFields = opts.fields || DEFAULT_FIELDS;
  const profile = opts.profile || null;
  const browserEvidence = shouldUseLearnedCdp(opts)
    ? await captureBrowserEvidence(tab, url, opts)
    : null;
  if (!browserEvidence) await openPage(tab, url);
  await dismissOverlays(tab, opts);
  if (profile) await expandDetailSections(tab, profile, opts);
  await lazyLoadScroll(tab);
  const wantsImages = requestedFields.includes("images") || requestedFields.includes("image");
  const renderedImages = wantsImages
    ? dedupeImagesByIdentity([
      ...(browserEvidence?.productImages || []),
      ...await collectRenderedProductImageUrls(tab, url, opts),
    ], url)
    : [];
  const renderedBody = await readPageBody(tab);
  const renderedDetailEvidence = await collectRenderedDetailEvidence(tab, {
    ...opts,
    profile,
  });
  const baseEvidenceHtml = browserEvidence?.html || renderedBody.text;
  const evidenceHtml = [renderedDetailEvidence, baseEvidenceHtml].filter(Boolean).join("\n");
  const extracted = [
    renderedDetailEvidence
      ? extractOne(url, renderedDetailEvidence, profile, requestedFields, null).record
      : null,
    evidenceHtml
      ? extractOne(url, evidenceHtml, profile, requestedFields, null).record
      : null,
    ...(browserEvidence?.network?.responseBodies || []).map((response) =>
      extractOne(url, response.body, profile, requestedFields, null).record
    ),
    renderedBody.text && renderedBody.text !== evidenceHtml
      ? extractOne(url, renderedBody.text, profile, requestedFields, null).record
      : null,
  ].filter(Boolean);
  const record = mergeProductRecords(extracted)[0] || null;
  if (record && renderedImages.length > 0) {
    record.fields.images = dedupeImagesByIdentity([
      ...recordImageUrls(record),
      ...renderedImages,
    ], url);
  }
  const missing = missingDetailExtractionFields(record, requestedFields);
  return {
    url,
    html: evidenceHtml,
    htmlBytes: evidenceHtml.length,
    templateFingerprint: computeTemplateFingerprint(evidenceHtml),
    baselineFields: record ? Object.keys(record.fields) : [],
    missingFields: missing,
    record,
    browserEvidence: browserEvidence ? {
      documentBodySource: browserEvidence.documentBodySource,
      capabilities: browserEvidence.capabilities,
      network: {
        eventCount: browserEvidence.network.eventCount,
        responseCount: browserEvidence.network.responseCount,
        truncated: browserEvidence.network.truncated,
        xhrFetchSamples: browserEvidence.network.responses
          .filter((response) => response.type === "XHR" || response.type === "Fetch")
          .slice(0, 20)
          .map((response) => ({
            url: response.url,
            type: response.type,
            mimeType: response.mimeType,
            status: response.status,
          })),
        capturedResponseBodies: browserEvidence.network.responseBodies.map((response) => ({
          name: response.name,
          url: response.url,
          type: response.type,
          mimeType: response.mimeType,
          status: response.status,
          bodyBytes: response.bodyBytes,
          truncated: response.truncated,
        })),
      },
      assets: browserEvidence.assets,
      imageEvidence: browserEvidence.imageEvidence,
      renderedFieldEvidenceBytes: renderedDetailEvidence.length,
      errors: browserEvidence.errors,
    } : {
      documentBodySource: "dom_fallback",
      capabilities: await inspectEvidenceCapabilities(tab),
    },
  };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

function discoveryFromMappedVisualRoute(startUrl, visualRoute, fields) {
  const route = normalizeVisualRoute(visualRoute);
  const validation = validateMappedVisualRoute(route, { fields });
  if (!validation.valid) {
    const missing = validation.missingFields.length > 0
      ? `:${validation.missingFields.join(",")}`
      : "";
    throw new Error(`visual_route_required_before_crawl${missing}`);
  }
  const listingSeeds = dedupe(route.steps
    .filter((step) => ["listing", "inline_catalog"].includes(step.pageRole))
    .map((step) => step.url)
    .concat(route.catalogCoverage?.listingSeeds || []));
  const productUrls = dedupe(route.steps
    .filter((step) => step.pageRole === "detail")
    .map((step) => step.url));
  if (listingSeeds.length === 0 && productUrls.length === 0) {
    throw new Error("visual_catalog_route_required");
  }
  const routeOrigins = dedupe(route.steps.map((step) => {
    try {
      return new URL(step.url).origin;
    } catch {
      return null;
    }
  }));
  return {
    productUrls,
    listingSeeds,
    storefrontOrigins: routeOrigins.length > 0
      ? routeOrigins
      : [new URL(startUrl).origin],
    source: "visual_route_replay",
  };
}

function listingProfileFromMappedVisualRoute(routeInput) {
  const route = normalizeVisualRoute(routeInput);
  if (!route) return null;
  const categoryLinkSelectors = [];
  const productLinkSelectors = [];
  const paginationActions = [];
  let hasRepeatedProductCards = false;
  for (let index = 0; index < route.steps.length - 1; index += 1) {
    const step = route.steps[index];
    const next = route.steps[index + 1];
    const selector = step.action?.generalSelector || step.action?.selector;
    if (!selector) continue;
    if (step.action?.actionKind === "pagination") {
      paginationActions.push({
        action: "click",
        selector: step.action.selector || selector,
        ...(step.action.text ? { text: step.action.text } : {}),
      });
    } else if (step.action?.actionKind === "catalog_entry"
        || (["home", "portfolio", "listing"].includes(step.pageRole)
          && ["listing", "inline_catalog"].includes(next.pageRole))) {
      if (step.action?.generalSelector) categoryLinkSelectors.push(selector);
    } else if (step.pageRole === "listing" && next.pageRole === "detail") {
      productLinkSelectors.push(selector);
      hasRepeatedProductCards ||= Boolean(step.action?.generalSelector);
    }
  }
  return normalizeListingProfile({
    categoryLinkSelectors,
    productLinkSelectors,
    paginationActions,
    listingMode: hasRepeatedProductCards
      ? "repeated_cards"
      : productLinkSelectors.length > 0
        ? "single_product"
        : route.steps.some((step) => step.pageRole === "inline_catalog")
          ? "inline_catalog"
          : undefined,
    scrollListings: true,
  });
}

async function replayDiscoveryFromProfile(startUrl, siteProfile, fields) {
  const discovery = siteProfile?.discovery;
  if (!discovery) return null;
  const routeValidation = validateMappedVisualRoute(siteProfile.visualRoute, { fields });
  if (!routeValidation.valid) return null;
  const storefront = discovery.storefrontOrigins?.[0] || startUrl;
  const productUrls = discovery.sampleProductUrl ? [discovery.sampleProductUrl] : [];
  if (productUrls.length === 0 && discovery.listingSeeds?.length === 0) return null;
  return {
    productUrls,
    listingSeeds: discovery.listingSeeds || [],
    storefrontOrigins: discovery.storefrontOrigins || [new URL(storefront).origin],
    source: "profile_replay",
  };
}

function configuredSitePlan(opts, url) {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    // The downstream route validator will report an invalid URL.
  }
  return opts.sitePlans?.[url]
    || opts.sitePlans?.[origin]
    || {};
}

function normalizeCrawlTargetUrls(startUrls) {
  const values = Array.isArray(startUrls) ? startUrls : [startUrls];
  const urls = [];
  const seen = new Set();
  for (const value of values) {
    const raw = typeof value === "string"
      ? value
      : value?.startUrl || value?.url || value?.entryUrl;
    if (typeof raw !== "string" || !raw.trim()) continue;
    let url;
    try {
      url = new URL(raw.trim()).toString();
    } catch {
      url = raw.trim();
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function siteOptionFor(opts, startUrl) {
  const configured = opts.siteOptions || opts.targetOptions || {};
  const direct = configured[startUrl];
  if (direct) return direct;
  try {
    return configured[new URL(startUrl).origin] || {};
  } catch {
    return {};
  }
}

const UNVERIFIED_BROWSER_WORKER_KEY = "unverified-browser-lease";

function nonEmptyWorkerValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * Return the browser lease identity recorded by a worker preflight.
 *
 * A session name or tab ID is deliberately not a lease identity: both may
 * still point at the same Chrome extension or In-App Browser instance. When
 * no verifiable instance ID exists, every such task shares one conservative
 * key so the coordinator serializes them instead of pretending to have
 * independent browser capacity.
 */
export function browserWorkerKey(preflight = {}) {
  const browser = preflight?.browser && typeof preflight.browser === "object"
    ? preflight.browser
    : {};
  const explicitKey = nonEmptyWorkerValue(preflight?.workerKey, browser.workerKey);
  if (explicitKey) return explicitKey;

  const extensionInstanceId = nonEmptyWorkerValue(
    preflight?.extensionInstanceId,
    browser.extensionInstanceId,
  );
  if (extensionInstanceId) return `extension:${extensionInstanceId}`;

  const browserId = nonEmptyWorkerValue(preflight?.browserId, browser.browserId);
  if (browserId) return `iab:${browserId}`;

  const codexAppSessionId = nonEmptyWorkerValue(
    preflight?.codexAppSessionId,
    browser.codexAppSessionId,
  );
  if (codexAppSessionId) return `iab-session:${codexAppSessionId}`;

  return null;
}

function normalizeCrawlWorkerTasks(workerTasks) {
  const values = Array.isArray(workerTasks) ? workerTasks : [];
  return values.map((task, index) => {
    const source = task && typeof task === "object" ? task : {};
    const startUrl = nonEmptyWorkerValue(source.startUrl, source.url, source.entryUrl) || "";
    const verifiedWorkerKey = browserWorkerKey(source.preflight);
    return {
      ...source,
      index,
      taskId: nonEmptyWorkerValue(source.taskId, source.id) || `worker-${index + 1}`,
      startUrl,
      verifiedWorkerKey,
      workerKey: verifiedWorkerKey || UNVERIFIED_BROWSER_WORKER_KEY,
    };
  });
}

/**
 * Plan parallelism by real browser lease, never by task count or tab count.
 * Duplicate or missing keys are a sequencing decision, not a stop condition.
 */
export function planCrawlWorkerExecution(workerTasks) {
  const tasks = normalizeCrawlWorkerTasks(workerTasks);
  const grouped = new Map();
  for (const task of tasks) {
    if (!grouped.has(task.workerKey)) grouped.set(task.workerKey, []);
    grouped.get(task.workerKey).push(task);
  }
  const workerGroups = [...grouped.entries()].map(([workerKey, groupTasks]) => ({
    workerKey,
    verified: workerKey !== UNVERIFIED_BROWSER_WORKER_KEY,
    sequential: groupTasks.length > 1 || workerKey === UNVERIFIED_BROWSER_WORKER_KEY,
    taskIds: groupTasks.map((task) => task.taskId),
    startUrls: groupTasks.map((task) => task.startUrl),
  }));
  const duplicateWorkerKeys = workerGroups
    .filter((group) => group.taskIds.length > 1)
    .map((group) => group.workerKey);
  const unverifiedWorkers = tasks
    .filter((task) => !task.verifiedWorkerKey)
    .map((task) => task.taskId);

  return {
    mode: workerGroups.length > 1
      ? "parallel_by_browser_lease"
      : "sequential_single_lease",
    totalWorkers: tasks.length,
    parallelGroups: workerGroups.length,
    maxParallel: workerGroups.length,
    fallbackRequired: duplicateWorkerKeys.length > 0 || unverifiedWorkers.length > 0,
    duplicateWorkerKeys,
    unverifiedWorkers,
    workerGroups,
  };
}

function crawlWorkerFailureResult(task, reason, failureStage = "crawl_execution") {
  return {
    records: [],
    completion: {
      status: "incomplete",
      resumeRequired: true,
      reasons: [reason],
      remainingProductDetails: 0,
    },
    stats: {
      startUrl: task.startUrl,
      recordsExtracted: 0,
      failureStage,
    },
    failures: [{
      url: task.startUrl || null,
      reason,
      failureStage,
      notSiteUnavailableEvidence: true,
    }],
    exclusions: [],
    events: [],
  };
}

function normalizeCrawlWorkerResult(task, result) {
  if (!result || typeof result !== "object") {
    return crawlWorkerFailureResult(task, "crawl_target_returned_no_result");
  }
  if (result.completion && typeof result.completion === "object") return result;
  return {
    ...result,
    completion: {
      status: "incomplete",
      resumeRequired: true,
      reasons: ["crawl_result_missing_completion"],
    },
    failures: [
      ...(result.failures || []),
      {
        url: task.startUrl,
        reason: "crawl_result_missing_completion",
        failureStage: "crawl_execution",
        notSiteUnavailableEvidence: true,
      },
    ],
  };
}

function workerCompletionStatus(result) {
  if (result?.completion?.status === "complete") return "complete";
  if (result?.completion?.status === "terminal") return "terminal";
  return "incomplete";
}

function addWorkerCompletionReason(result, reason) {
  const reasons = [...new Set([...(result.completion?.reasons || []), reason])];
  return {
    ...result,
    completion: {
      ...(result.completion || {}),
      status: "incomplete",
      resumeRequired: true,
      reasons,
    },
    failures: [
      ...(result.failures || []),
      {
        reason,
        failureStage: "worker_result_persistence",
        notSiteUnavailableEvidence: true,
      },
    ],
  };
}

async function writeWorkerJson(outputDir, fileName, value) {
  await mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, fileName);
  const temporaryPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function persistCrawlWorkerArtifacts(task, result, lifecycle) {
  if (!task.outputDir) return {};
  const artifact = {
    taskId: task.taskId,
    startUrl: task.startUrl,
    workerKey: task.workerKey,
    lifecycle,
    result,
  };
  const crawlResultPath = await writeWorkerJson(task.outputDir, "crawl-result.json", artifact);
  const paths = { crawlResultPath };
  if (lifecycle.failureStage) {
    paths.retryDiagnosticPath = await writeWorkerJson(
      task.outputDir,
      "retry-diagnostic.json",
      {
        taskId: task.taskId,
        startUrl: task.startUrl,
        workerKey: task.workerKey,
        failureStage: lifecycle.failureStage,
        reason: lifecycle.failureReason,
        notSiteUnavailableEvidence: true,
        retryable: true,
        recordedAt: lifecycle.finishedAt,
      },
    );
  }
  return paths;
}

/**
 * Execute post-preflight crawl workers.
 *
 * Tasks sharing a browser lease run in order; independent lease groups run in
 * parallel. Every valid task enters `crawlTarget()` (or the injected
 * `runTarget`) even when its preflight key is duplicated or missing. By
 * default each task must provide `outputDir`, and the coordinator atomically
 * writes `crawl-result.json`; a thrown crawl also writes
 * `retry-diagnostic.json`. Set `persistResults:false` only for an explicitly
 * in-memory caller such as a unit test.
 */
export async function crawlWorkerTasks(workerTasks, opts = {}) {
  const tasks = normalizeCrawlWorkerTasks(workerTasks);
  const executionPlan = planCrawlWorkerExecution(tasks);
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.workerKey)) groups.set(task.workerKey, []);
    groups.get(task.workerKey).push(task);
  }
  const progressFailures = [];
  const persistResults = opts.persistResults !== false;

  const emitProgress = async (payload) => {
    if (typeof opts.onWorkerProgress !== "function") return;
    try {
      await opts.onWorkerProgress(payload);
    } catch (error) {
      progressFailures.push({
        taskId: payload.taskId,
        phase: payload.phase,
        reason: error?.message || String(error),
      });
    }
  };

  const runTask = async (task) => {
    const startedAt = new Date().toISOString();
    let crawlStarted = false;
    let executionError = null;
    await emitProgress({
      phase: "crawl_started",
      taskId: task.taskId,
      startUrl: task.startUrl,
      workerKey: task.workerKey,
      startedAt,
    });

    let result;
    if (!task.startUrl) {
      executionError = Object.assign(new Error("worker_start_url_missing"), {
        code: "worker_start_url_missing",
        failureStage: "worker_input_validation",
      });
      result = crawlWorkerFailureResult(
        task,
        executionError.code,
        executionError.failureStage,
      );
    } else {
      crawlStarted = true;
      const runTarget = typeof task.runTarget === "function"
        ? task.runTarget
        : typeof opts.runTarget === "function"
          ? opts.runTarget
          : crawlTarget;
      const crawlOptions = {
        ...(opts.crawlOptions || opts.sharedOptions || {}),
        ...(task.crawlOptions || task.options || {}),
      };
      try {
        result = normalizeCrawlWorkerResult(
          task,
          await runTarget(task.browser, task.tab, task.startUrl, crawlOptions),
        );
      } catch (error) {
        executionError = error;
        result = crawlWorkerFailureResult(
          task,
          error?.code || error?.message || String(error),
          error?.failureStage || "crawl_execution",
        );
      }
    }

    const finishedAt = new Date().toISOString();
    const lifecycle = {
      preflightRecorded: Boolean(task.preflight),
      crawlStarted,
      preflightOnly: !crawlStarted && Boolean(task.preflight),
      startedAt,
      finishedAt,
      ...(executionError ? {
        failureStage: executionError.failureStage || "crawl_execution",
        failureReason: executionError.code || executionError.message || String(executionError),
      } : {}),
    };

    let artifactPaths = {};
    let persistenceError = null;
    if (persistResults) {
      if (!task.outputDir) {
        persistenceError = new Error("worker_output_dir_missing");
      } else {
        try {
          artifactPaths = await persistCrawlWorkerArtifacts(task, result, lifecycle);
        } catch (error) {
          persistenceError = error;
        }
      }
    }
    if (persistenceError) {
      result = addWorkerCompletionReason(
        result,
        persistenceError.message === "worker_output_dir_missing"
          ? "worker_output_dir_missing"
          : `worker_result_persist_failed:${persistenceError.message || String(persistenceError)}`,
      );
    }

    if (typeof opts.persistWorkerResult === "function") {
      try {
        await opts.persistWorkerResult({ task, result, lifecycle, artifactPaths });
      } catch (error) {
        progressFailures.push({
          taskId: task.taskId,
          phase: "persist_worker_result",
          reason: error?.message || String(error),
        });
      }
    }

    const status = workerCompletionStatus(result);
    await emitProgress({
      phase: executionError ? "crawl_failed" : "crawl_finished",
      taskId: task.taskId,
      startUrl: task.startUrl,
      workerKey: task.workerKey,
      status,
      completion: result.completion,
      recordsExtracted: result.records?.length || 0,
      artifactPaths,
      finishedAt,
    });

    return {
      task,
      result,
      status,
      lifecycle,
      artifactPaths,
      persistenceError: persistenceError?.message || null,
    };
  };

  const groupRuns = [...groups.values()].map(async (groupTasks) => {
    const groupResults = [];
    for (const task of groupTasks) groupResults.push(await runTask(task));
    return groupResults;
  });
  const executions = (await Promise.all(groupRuns))
    .flat()
    .sort((left, right) => left.task.index - right.task.index);

  const records = [];
  const failures = [];
  const exclusions = [];
  const events = [];
  const workerResults = executions.map((execution) => {
    const { task, result, status, lifecycle, artifactPaths, persistenceError } = execution;
    records.push(...(result.records || []).map((record) => ({
      ...record,
      taskEntryUrl: task.startUrl,
      workerTaskId: task.taskId,
    })));
    failures.push(...(result.failures || []).map((failure) => ({
      ...failure,
      taskId: task.taskId,
      siteUrl: task.startUrl,
    })));
    exclusions.push(...(result.exclusions || []).map((exclusion) => ({
      ...exclusion,
      taskId: task.taskId,
      siteUrl: task.startUrl,
    })));
    events.push(...(result.events || []).slice(-20).map((event) => ({
      ...event,
      taskId: task.taskId,
      siteUrl: task.startUrl,
    })));
    return {
      taskId: task.taskId,
      startUrl: task.startUrl,
      workerKey: task.workerKey,
      workerKeyVerified: Boolean(task.verifiedWorkerKey),
      status,
      completion: result.completion,
      recordsExtracted: result.records?.length || 0,
      outputDir: task.outputDir || null,
      artifactPaths,
      lifecycle,
      persistenceError,
    };
  });

  const incomplete = workerResults.filter((worker) => worker.status === "incomplete");
  const preflightOnly = workerResults.filter((worker) => worker.lifecycle.preflightOnly);
  const completion = {
    status: workerResults.length > 0 && incomplete.length === 0 ? "complete" : "incomplete",
    resumeRequired: workerResults.length === 0 || incomplete.length > 0,
    reasons: workerResults.length === 0
      ? ["no_worker_tasks"]
      : incomplete.length > 0
        ? ["worker_tasks_incomplete"]
        : [],
    totalWorkers: workerResults.length,
    workersComplete: workerResults.filter((worker) => worker.status === "complete").length,
    workersTerminal: workerResults.filter((worker) => worker.status === "terminal").length,
    workersIncomplete: incomplete.length,
    workersFailedToStart: workerResults.filter((worker) => !worker.lifecycle.crawlStarted).length,
    preflightOnlyWorkers: preflightOnly.length,
    remainingWorkers: incomplete.map((worker) => worker.taskId),
    workerResults,
  };

  return {
    records,
    completion,
    stats: {
      totalWorkers: workerResults.length,
      workersAttempted: workerResults.filter((worker) => worker.lifecycle.crawlStarted).length,
      workersComplete: completion.workersComplete,
      workersTerminal: completion.workersTerminal,
      workersIncomplete: completion.workersIncomplete,
      workersFailedToStart: completion.workersFailedToStart,
      preflightOnlyWorkers: completion.preflightOnlyWorkers,
      recordsExtracted: records.length,
      failures: failures.length,
      exclusions: exclusions.length,
      progressCallbackFailures: progressFailures.length,
    },
    executionPlan,
    workerResults,
    failures: failures.slice(0, 200),
    exclusions: exclusions.slice(0, 200),
    events: events.slice(-300),
    progressFailures,
  };
}

/**
 * Crawl every user-supplied entry in one task.
 *
 * A successful site is only one completed entry in the task. The loop always
 * advances through every unique URL, records per-site checkpoints/failures,
 * and marks the batch complete only when every entry is resolved. This is the
 * guardrail that prevents a first successful site from ending a multi-site
 * request prematurely.
 */
export async function crawlTargets(browser, tab, startUrls, opts = {}) {
  const urls = normalizeCrawlTargetUrls(startUrls);
  const sharedOpts = { ...opts };
  delete sharedOpts.siteOptions;
  delete sharedOpts.targetOptions;
  delete sharedOpts.onProgress;
  delete sharedOpts.runTarget;
  delete sharedOpts.taskId;

  const runTarget = typeof opts.runTarget === "function"
    ? opts.runTarget
    : crawlTarget;
  const siteResults = [];
  const records = [];
  const failures = [];
  const exclusions = [];
  const events = [];
  let activeTab = tab;

  for (const [index, startUrl] of urls.entries()) {
    const siteOpts = {
      ...sharedOpts,
      ...siteOptionFor(opts, startUrl),
    };
    let result;
    try {
      result = await runTarget(browser, activeTab, startUrl, siteOpts);
    } catch (error) {
      const reason = error?.code || error?.message || String(error);
      result = {
        records: [],
        completion: {
          status: "incomplete",
          resumeRequired: true,
          reasons: [reason],
          remainingProductDetails: 0,
        },
        stats: { startUrl, recordsExtracted: 0 },
        failures: [{ url: startUrl, reason }],
        exclusions: [],
        events: [],
      };
      if (shouldDiscardBrowserTab(error)) {
        try {
          const recovery = await replaceTaintedTab(browser, activeTab, error);
          activeTab = recovery.tab;
        } catch (recoveryError) {
          failures.push({
            url: startUrl,
            reason: `tab_recovery_failed:${String(recoveryError)}`,
          });
        }
      }
    }

    const completionStatus = result.completion?.status === "complete"
      ? "complete"
      : result.completion?.status === "terminal"
        ? "terminal"
        : "incomplete";
    const siteFailureEntries = (result.failures || []).map((failure) => ({
      ...failure,
      siteUrl: startUrl,
    }));
    const siteExclusions = (result.exclusions || []).map((exclusion) => ({
      ...exclusion,
      siteUrl: startUrl,
    }));
    records.push(...(result.records || []).map((record) => ({
      ...record,
      taskEntryUrl: startUrl,
    })));
    failures.push(...siteFailureEntries);
    exclusions.push(...siteExclusions);
    siteResults.push({
      url: startUrl,
      index,
      status: completionStatus,
      completion: result.completion,
      stats: result.stats,
      recordsExtracted: result.records?.length || 0,
      failureCount: siteFailureEntries.length,
      exclusionCount: siteExclusions.length,
    });
    events.push(...(result.events || []).slice(-20).map((event) => ({
      ...event,
      siteUrl: startUrl,
    })));
    await opts.onProgress?.({
      phase: "site_complete",
      taskId: opts.taskId || null,
      index,
      total: urls.length,
      url: startUrl,
      status: completionStatus,
      completion: result.completion,
      recordsExtracted: result.records?.length || 0,
      completedSites: siteResults.filter((site) =>
        site.status === "complete" || site.status === "terminal").length,
      remainingSites: urls.slice(index + 1),
    });
  }

  const unresolved = siteResults.filter((site) => site.status === "incomplete");
  const resolved = siteResults.length - unresolved.length;
  const taskCompletion = {
    status: urls.length > 0 && unresolved.length === 0 ? "complete" : "incomplete",
    resumeRequired: unresolved.length > 0 || urls.length === 0,
    reasons: urls.length === 0
      ? ["no_start_urls"]
      : unresolved.length > 0
        ? ["site_entries_incomplete"]
        : [],
    totalSites: urls.length,
    sitesComplete: siteResults.filter((site) => site.status === "complete").length,
    sitesTerminal: siteResults.filter((site) => site.status === "terminal").length,
    sitesIncomplete: unresolved.length,
    remainingSites: unresolved.map((site) => site.url),
    siteResults,
  };

  return {
    records,
    completion: taskCompletion,
    stats: {
      taskId: opts.taskId || null,
      totalSites: urls.length,
      sitesAttempted: siteResults.length,
      sitesResolved: resolved,
      sitesComplete: taskCompletion.sitesComplete,
      sitesTerminal: taskCompletion.sitesTerminal,
      sitesIncomplete: taskCompletion.sitesIncomplete,
      recordsExtracted: records.length,
      failures: failures.length,
      exclusions: exclusions.length,
    },
    siteResults,
    failures: failures.slice(0, 200),
    exclusions: exclusions.slice(0, 200),
    events: events.slice(-300),
  };
}

/**
 * Top-level entry dispatcher for an unknown user-supplied site.
 *
 * The model first classifies the screenshot-visible role. This dispatcher
 * prevents an empty corporate parent from being mistaken for a terminal zero-
 * product site when direct official Brands still need one-level crawling.
 */
export async function crawlTarget(browser, tab, startUrl, opts = {}) {
  const fields = opts.fields || DEFAULT_FIELDS;
  let parentProfile = opts.siteProfile || null;
  if (!parentProfile && opts.profileDir && opts.reuseProfile !== false) {
    const loaded = await loadSiteProfile(opts.profileDir, startUrl, { fields });
    const fatal = loaded?.validation?.reasons?.some((reason) =>
      ["wrong_kind", "version_mismatch", "origin_mismatch", "invalid_start_url", "read_failed"]
        .includes(reason)
    );
    if (loaded?.profile && !fatal) parentProfile = loaded.profile;
  }
  const portfolioProfile = opts.portfolioProfile ?? parentProfile?.portfolio ?? null;
  const entryPlan = resolveEntryCrawlPlan(startUrl, {
    entryOutcome: opts.entryOutcome,
    verifiedSites: opts.verifiedSites,
    brandCandidates: opts.brandCandidates,
    portfolioProfile,
  });

  if (entryPlan.mode === "needs_visual_classification"
      || entryPlan.mode === "needs_brand_verification") {
    const error = new Error(entryPlan.reason);
    error.code = entryPlan.reason;
    error.entryPlan = entryPlan;
    throw error;
  }
  if (entryPlan.mode === "terminal") {
    return {
      records: [],
      completion: {
        status: "terminal",
        terminal: true,
        resumeRequired: false,
        reasons: [entryPlan.reason],
      },
      stats: {
        startUrl,
        entryPlan: {
          mode: entryPlan.mode,
          reason: entryPlan.reason,
          outcomeKind: entryPlan.outcome?.kind ?? null,
        },
        recordsExtracted: 0,
      },
      failures: [],
      reviewQueue: [],
      exclusions: [],
      events: [],
    };
  }

  let result;
  if (entryPlan.mode === "portfolio") {
    result = await crawlPortfolio(browser, tab, startUrl, {
      ...opts,
      siteProfile: parentProfile,
      portfolioProfile,
    });
  } else if (entryPlan.mode === "official_store_handoff") {
    const handoffPlan = configuredSitePlan(opts, entryPlan.startUrl);
    result = await crawlSite(browser, tab, entryPlan.startUrl, {
      ...opts,
      siteProfile: undefined,
      visualRoute: undefined,
      listingProfile: undefined,
      profile: undefined,
      imageProfile: undefined,
      cdpProfile: undefined,
      ...handoffPlan,
      portfolioDepth: 0,
    });
  } else {
    result = await crawlSite(browser, tab, startUrl, opts);
  }

  return {
    ...result,
    stats: {
      ...result.stats,
      entryPlan: {
        mode: entryPlan.mode,
        reason: entryPlan.reason,
        outcomeKind: entryPlan.outcome?.kind ?? null,
        ...(entryPlan.parentUrl ? { parentUrl: entryPlan.parentUrl } : {}),
      },
    },
  };
}

/**
 * Discovery -> listing -> detail, in one call.
 *
 * Returns records plus a stats block. Print the stats; write the records to a
 * file. Printing records is what blows up an agent's context.
 */
export async function crawlSite(browser, tab, startUrl, opts = {}) {
  const events = [];
  const log = (event, data) => {
    if (events.length >= (opts.maxEvents || 300)) events.shift();
    events.push({ event, ...data });
    if (opts.verbose) console.log(event, JSON.stringify(data));
  };
  const fields = opts.fields || DEFAULT_FIELDS;
  const maxItems = opts.maxItems || 200;
  const productScopePolicy = opts.productScope === "all_products"
    ? "all_products"
    : PRODUCT_SCOPE_POLICY;
  const nutritionSinglesOnly = productScopePolicy === PRODUCT_SCOPE_POLICY;
  const candidateMaxItems = nutritionSinglesOnly
    ? Math.max(maxItems + 20, Math.ceil(maxItems * 1.5))
    : maxItems;
  const startedAt = Date.now();

  let loadedProfile = null;
  if (opts.siteProfile) {
    loadedProfile = {
      profile: opts.siteProfile,
      validation: validateSiteProfile(opts.siteProfile, {
        startUrl,
        fields,
        templateFingerprint: opts.templateFingerprint,
      }),
      filePath: null,
    };
  } else if (opts.profileDir && opts.reuseProfile !== false) {
    loadedProfile = await loadSiteProfile(opts.profileDir, startUrl, {
      fields,
      templateFingerprint: opts.templateFingerprint,
    });
  }
  const invalidReasons = loadedProfile?.validation?.reasons || [];
  const legacyQualityRevalidation = invalidReasons
    .includes("legacy_profile_quality_revalidation_required");
  const structurallyInvalid = invalidReasons.some((reason) =>
    ["wrong_kind", "version_mismatch", "origin_mismatch", "invalid_start_url", "read_failed"]
      .includes(reason)
  );
  // Field additions or a changed detail template invalidate extraction rules,
  // but not the independently learned listing/storefront route.
  const discoveryProfile = loadedProfile?.profile && !structurallyInvalid
    ? loadedProfile.profile
    : null;
  const extractionProfile = loadedProfile?.profile
    && !structurallyInvalid
    && !legacyQualityRevalidation
    && !invalidReasons.includes("template_changed")
    ? loadedProfile.profile
    : null;
  if (opts.forceDiscovery === true) {
    throw new Error("automatic_discovery_removed");
  }
  const runtimeVisualRoute = normalizeVisualRoute(
    opts.visualRoute ?? discoveryProfile?.visualRoute,
  );
  if (Number(opts.portfolioDepth || 0) >= 1) {
    assertPortfolioRouteWithinDepth(runtimeVisualRoute, opts.portfolioDepth);
  }
  const routeValidation = validateMappedVisualRoute(runtimeVisualRoute, {
    fields,
    requireCatalogCompletion: true,
  });
  if (!routeValidation.valid) {
    const details = [...new Set([
      ...routeValidation.reasons,
      ...routeValidation.missingFields.map((field) => `field:${field}`),
    ])];
    throw new Error(
      `visual_route_required_before_crawl${details.length > 0 ? `:${details.join(",")}` : ""}`,
    );
  }
  const visualProfiles = extractionProfilesFromVisualRoute(runtimeVisualRoute);
  const runtimeProfile = opts.profile
    ?? extractionProfile?.detailProfile
    ?? visualProfiles.detailProfile
    ?? null;
  const runtimeImageProfile = opts.imageProfile
    ?? extractionProfile?.imageProfile
    ?? visualProfiles.imageProfile
    ?? null;
  const runtimeCdpProfile = opts.cdpProfile
    ?? extractionProfile?.cdpProfile
    ?? (legacyQualityRevalidation ? discoveryProfile?.cdpProfile : null)
    ?? null;
  const runtimeListingProfile = normalizeListingProfile(
    opts.listingProfile
      ?? discoveryProfile?.listingProfile
      ?? listingProfileFromMappedVisualRoute(runtimeVisualRoute),
  );
  const runtimeOpts = {
    ...opts,
    profile: runtimeProfile,
    imageProfile: runtimeImageProfile,
    cdpProfile: runtimeCdpProfile,
    categoryLinkSelectors: opts.categoryLinkSelectors
      ?? runtimeListingProfile?.categoryLinkSelectors,
    productLinkSelectors: opts.productLinkSelectors
      ?? runtimeListingProfile?.productLinkSelectors,
    scrollListings: opts.scrollListings
      ?? runtimeListingProfile?.scrollListings,
    listingScrollScreens: opts.listingScrollScreens
      ?? runtimeListingProfile?.listingScrollScreens,
    listingMode: opts.listingMode
      ?? runtimeListingProfile?.listingMode,
    paginationActions: opts.paginationActions
      ?? runtimeListingProfile?.paginationActions,
    followVerifiedExternalProductLinks: opts.followVerifiedExternalProductLinks
      ?? runtimeListingProfile?.followVerifiedExternalProductLinks,
    variantProfile: opts.variantProfile
      ?? runtimeVisualRoute.variantProfile
      ?? discoveryProfile?.visualRoute?.variantProfile
      ?? null,
  };

  const replayedDiscovery = await replayDiscoveryFromProfile(
    startUrl,
    discoveryProfile,
    fields,
  );
  const discovery = replayedDiscovery
    || discoveryFromMappedVisualRoute(startUrl, runtimeVisualRoute, fields);
  const hasMappedCatalogCoverage = (runtimeVisualRoute.catalogCoverage?.families || []).length > 0;
  if (!hasMappedCatalogCoverage
      && (runtimeListingProfile?.categoryLinkSelectors || []).length > 0) {
    const routeStartUrl = runtimeVisualRoute.steps[0]?.url || startUrl;
    try {
      await openPage(tab, routeStartUrl);
      const siblingCategories = await collectVerifiedCategoryUrls(tab, routeStartUrl, {
        ...runtimeOpts,
        verifiedListingSeeds: discovery.listingSeeds,
      });
      discovery.listingSeeds = dedupe([
        ...discovery.listingSeeds,
        ...siblingCategories,
      ]).slice(0, 50);
      log("mapped_category_replay", {
        selectors: runtimeListingProfile.categoryLinkSelectors.length,
        listingSeeds: discovery.listingSeeds.length,
      });
    } catch (error) {
      log("mapped_category_replay_failed", { error: String(error) });
    }
  }
  let productUrls = discovery.productUrls;
  let inlineRecords = discovery.inlineRecords || [];
  let storefrontOrigins = discovery.storefrontOrigins || [new URL(startUrl).origin];
  let externalProductUrlsFound = 0;
  let pagesVisited = 0;
  let collectionCoverage = runtimeVisualRoute.catalogCoverage?.closure?.basis
      === "single_product_catalog"
    ? {
      status: "complete",
      seedReports: [],
      incompleteSeeds: 0,
      endReason: "visually_verified_single_product_catalog",
    }
    : {
      status: "incomplete",
      seedReports: [],
      incompleteSeeds: discovery.listingSeeds.length,
      endReason: "listing_collection_not_started",
    };

  if (discovery.listingSeeds.length > 0) {
    const listing = await collectProductUrls(tab, discovery.listingSeeds, {
      ...runtimeOpts,
      log,
      maxItems: candidateMaxItems,
      known: productUrls,
      knownInlineRecords: inlineRecords,
      storefrontOrigins,
      listingCoverage: runtimeVisualRoute.catalogCoverage?.listings || [],
    });
    productUrls = listing.productUrls;
    inlineRecords = listing.inlineRecords;
    pagesVisited = listing.pagesVisited;
    storefrontOrigins = dedupe([...storefrontOrigins, ...(listing.storefrontOrigins || [])]);
    externalProductUrlsFound = listing.externalProductUrlsFound || 0;
    collectionCoverage = listing.coverage;
  }
  const productUrlsDiscovered = dedupe(productUrls);
  const inlineRecordsDiscovered = inlineRecords;
  const scopeExclusions = [];
  let productUrlCandidatesExcludedByScope = 0;
  let inlineRecordsExcludedByScope = 0;
  let extractedRecordsExcludedByScope = 0;
  if (nutritionSinglesOnly) {
    productUrls = productUrlsDiscovered.filter((url) => {
      const decision = classifyNutritionProductUrl(url);
      if (decision.included) return true;
      productUrlCandidatesExcludedByScope += 1;
      scopeExclusions.push({ ...decision, url });
      log("product_scope_candidate_excluded", { ...decision, url });
      return false;
    });
    const inlineScope = filterNutritionSingleProductRecords(inlineRecordsDiscovered);
    inlineRecords = inlineScope.records;
    inlineRecordsExcludedByScope = inlineScope.excluded.length;
    scopeExclusions.push(...inlineScope.excluded);
    for (const decision of inlineScope.excluded) {
      log("product_scope_record_excluded", decision);
    }
  } else {
    productUrls = productUrlsDiscovered;
  }
  const eligibleProductsDiscovered = productUrls.length + inlineRecords.length;
  const productsDeferredByMaxItems = Math.max(0, eligibleProductsDiscovered - maxItems);
  inlineRecords = inlineRecords.slice(0, maxItems);
  productUrls = productUrls.slice(0, Math.max(0, maxItems - inlineRecords.length));

  const batch = await extractProductsBatch(browser, productUrls, { ...runtimeOpts, fields, log });
  const upgrade = await upgradeProducts(tab, batch.needsUpgrade, {
    ...runtimeOpts,
    browser,
    fields,
    log,
    baselineRecords: batch.records,
  });
  let records = mergeProductRecords([...inlineRecords, ...batch.records, ...upgrade.records]);
  records = annotateRecordsFromVisualRoute(records, startUrl, runtimeVisualRoute);
  const recordsBeforeScopeFilter = records.length;
  if (nutritionSinglesOnly) {
    const recordScope = filterNutritionSingleProductRecords(records);
    records = recordScope.records;
    extractedRecordsExcludedByScope = recordScope.excluded.length;
    scopeExclusions.push(...recordScope.excluded);
    for (const decision of recordScope.excluded) {
      log("product_scope_record_excluded", decision);
    }
  }
  const originalImages = fields.some((field) => field === "images" || field === "image")
    && opts.resolveOriginalImages !== false
    ? await upgradeProductImageUrls(upgrade.tab ?? tab, records, { ...runtimeOpts, log })
    : null;
  records = annotateProductRecordCompletion(records, {
    fields,
    profile: runtimeProfile,
    requireGalleryReview: opts.requireGalleryReview !== false,
  });
  const reviewQueue = records
    .filter((record) => record?._meta?.completion?.status !== "complete")
    .map((record) => ({
      url: record?.fields?.product_url
        ?? record?.fields?.productUrl
        ?? record?.sourceUrl
        ?? null,
      title: record?.fields?.title ?? null,
      reasons: record?._meta?.completion?.reasons ?? [],
    }));
  const extractedUrls = new Set(records.map((record) => recordIdentity(record)).filter(Boolean));
  const unresolvedFailures = [...batch.failed, ...upgrade.failed]
    .filter((entry) => !extractedUrls.has(recordIdentity({ sourceUrl: entry.url })));
  const catalogComplete = collectionCoverage?.status === "complete";
  const profilePromotion = catalogComplete && productsDeferredByMaxItems === 0
    ? assessProfilePromotion(records, {
      fields,
      profile: runtimeProfile,
      minSamples: opts.profilePromotionMinSamples,
      singleProductCatalog:
        runtimeVisualRoute.catalogCoverage?.closure?.basis === "single_product_catalog"
        && productUrlsDiscovered.length + inlineRecordsDiscovered.length === 1,
    })
    : {
      ready: false,
      requiredSamples: opts.profilePromotionMinSamples ?? 2,
      validSamples: 0,
      reasons: [catalogComplete
        ? "product_limit_reached"
        : "catalog_collection_incomplete"],
    };
  const completionReasons = [];
  if (!catalogComplete) completionReasons.push("catalog_collection_incomplete");
  if (productsDeferredByMaxItems > 0) completionReasons.push("product_limit_reached");
  if (reviewQueue.length > 0) completionReasons.push("product_details_incomplete");
  if (unresolvedFailures.length > 0) completionReasons.push("product_failures_unresolved");
  const completion = {
    status: completionReasons.length === 0 ? "complete" : "incomplete",
    resumeRequired: completionReasons.length > 0,
    reasons: completionReasons,
    catalog: collectionCoverage,
    remainingProductDetails:
      reviewQueue.length + unresolvedFailures.length + productsDeferredByMaxItems,
  };

  let savedProfilePath = null;
  if (opts.profileDir && opts.saveProfile !== false && profilePromotion.ready) {
    const persisted = createSiteProfile({
      startUrl,
      fields,
      templateFingerprint: opts.templateFingerprint || extractionProfile?.templateFingerprint || null,
      discovery: {
        strategy: "visual_route",
        listingSeeds: discovery.listingSeeds,
        storefrontOrigins,
        sampleProductUrl: productUrls[0] || discoveryProfile?.discovery?.sampleProductUrl || null,
      },
      listingProfile: runtimeListingProfile,
      visualRoute: runtimeVisualRoute,
      detailProfile: runtimeProfile,
      imageProfile: runtimeImageProfile,
      cdpProfile: runtimeCdpProfile,
      portfolio: opts.portfolioProfile ?? discoveryProfile?.portfolio ?? null,
      learnedAt: discoveryProfile?.learnedAt,
      validation: discoveryProfile?.validation,
    });
    savedProfilePath = await saveSiteProfile(opts.profileDir, persisted);
  }

  return {
    records,
    completion,
    stats: {
      startUrl,
      productScopePolicy,
      discoverySource: discovery.source,
      listingSeeds: discovery.listingSeeds.length,
      listingPagesVisited: pagesVisited,
      catalogCoverageStatus: runtimeVisualRoute.catalogCoverage?.status ?? null,
      catalogFamiliesMapped: runtimeVisualRoute.catalogCoverage?.families?.length ?? 0,
      catalogListingSeedsMapped: runtimeVisualRoute.catalogCoverage?.listingSeeds?.length ?? 0,
      catalogCollectionStatus: collectionCoverage?.status ?? "incomplete",
      catalogListingSeedsComplete: collectionCoverage?.seedReports
        ?.filter((report) => report.status === "complete").length ?? 0,
      catalogListingSeedsIncomplete: collectionCoverage?.incompleteSeeds ?? 0,
      paginationActionsMapped: runtimeListingProfile?.paginationActions?.length ?? 0,
      productUrlsFound: productUrls.length,
      productUrlsDiscovered: productUrlsDiscovered.length,
      eligibleProductsDiscovered,
      productsDeferredByMaxItems,
      productUrlCandidatesExcludedByScope,
      inlineRecordsFound: inlineRecords.length,
      inlineRecordsDiscovered: inlineRecordsDiscovered.length,
      inlineRecordsExcludedByScope,
      externalProductUrlsFound,
      recordsExtracted: records.length,
      recordsComplete: records.length - reviewQueue.length,
      recordsPartial: reviewQueue.length,
      variantRecords: records.filter((record) => Boolean(variantIdentity(record))).length,
      recordsBeforeScopeFilter,
      extractedRecordsExcludedByScope,
      productsExcludedByScope: scopeExclusions.length,
      scopeExclusionReasons: countScopeExclusionReasons(scopeExclusions),
      viaBatch: batch.records.length,
      partialRecordsRetainedFromBatch: batch.partialRecordsKept,
      viaUpgrade: upgrade.records.length,
      imageUpgradesSkipped: upgrade.skipped.length,
      detailUpgradesSkipped: upgrade.skipped.length,
      failed: unresolvedFailures.length,
      fieldCoverage: fieldCoverage(records, fields),
      originalImages,
      profile: {
        loaded: Boolean(discoveryProfile),
        visualRouteReused: Boolean(discoveryProfile?.visualRoute),
        extractionRulesReused: Boolean(extractionProfile),
        replayed: discovery.source === "profile_replay",
        saved: Boolean(savedProfilePath),
        path: savedProfilePath || loadedProfile?.filePath || null,
        validation: loadedProfile?.validation || null,
        promotion: profilePromotion,
      },
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    },
    failures: unresolvedFailures.slice(0, 20),
    reviewQueue: reviewQueue.slice(0, 100),
    exclusions: scopeExclusions.slice(0, 50),
    events,
  };
}

/**
 * Crawl every verified storefront in a corporate brand portfolio.
 *
 * Portfolio discovery is persisted on the parent site profile; every child
 * origin gets an independent site profile so selectors and CDP response rules
 * never leak across brands.
 */
export async function crawlPortfolio(browser, tab, startUrl, opts = {}) {
  const events = [];
  const log = (event, data) => {
    if (events.length >= (opts.maxEvents || 300)) events.shift();
    events.push({ event, ...data });
    opts.log?.(event, data);
  };
  const fields = opts.fields || DEFAULT_FIELDS;
  let parentProfile = opts.siteProfile || null;
  if (!parentProfile && opts.profileDir && opts.reuseProfile !== false) {
    const loaded = await loadSiteProfile(opts.profileDir, startUrl, { fields });
    const fatal = loaded?.validation?.reasons?.some((reason) =>
      ["wrong_kind", "version_mismatch", "origin_mismatch", "invalid_start_url", "read_failed"]
        .includes(reason)
    );
    if (loaded?.profile && !fatal) parentProfile = loaded.profile;
  }

  const portfolioDiscovery = await discoverPortfolioSites(tab, startUrl, {
    ...opts,
    log,
    portfolioProfile: opts.portfolioProfile || parentProfile?.portfolio,
  });
  if (Number(opts.maxDepth ?? 1) !== 1) {
    log("portfolio_depth_clamped", {
      requested: Number(opts.maxDepth),
      applied: 1,
    });
  }
  for (const rejected of portfolioDiscovery.rejectedSites || []) {
    log("portfolio_site_rejected", rejected);
  }
  const maxItems = opts.maxItems || 200;
  const records = [];
  const siteResults = [];
  const failures = [];
  const scopeExclusions = [];

  for (const site of portfolioDiscovery.sites) {
    if (records.length >= maxItems) break;
    const remaining = maxItems - records.length;
    const crawlUrl = site.entryUrl || site.finalOrigin || site.origin;
    const crawlOrigin = (() => {
      try {
        return new URL(crawlUrl).origin;
      } catch {
        return site.finalOrigin || site.origin;
      }
    })();
    try {
      const sitePlan = opts.sitePlans?.[site.brandOrigin]
        || opts.sitePlans?.[site.brandUrl]
        || opts.sitePlans?.[site.origin]
        || opts.sitePlans?.[site.finalOrigin]
        || opts.sitePlans?.[site.entryUrl]
        || {};
      const result = await crawlSite(browser, tab, crawlUrl, {
        ...opts,
        maxItems: Math.min(remaining, opts.maxItemsPerSite || remaining),
        profileDir: opts.profileDir,
        siteProfile: undefined,
        listingProfile: undefined,
        visualRoute: undefined,
        profile: undefined,
        imageProfile: undefined,
        cdpProfile: undefined,
        templateFingerprint: undefined,
        ...sitePlan,
        // A direct brand may hand off to its own official store, but neither a
        // caller option nor a child profile may start another portfolio crawl.
        portfolioProfile: null,
        verifiedSites: undefined,
        sitePlans: undefined,
        portfolioDepth: 1,
        maxPortfolioDepth: 1,
        maxDepth: 1,
      });
      for (const record of result.records) {
        records.push({
          ...record,
          siteOrigin: crawlOrigin,
          brandOrigin: site.brandOrigin || site.origin,
          portfolioDepth: 1,
        });
      }
      siteResults.push({
        origin: crawlOrigin,
        brandOrigin: site.brandOrigin || site.origin,
        depth: 1,
        label: site.label,
        confidence: site.confidence,
        completion: result.completion,
        stats: result.stats,
      });
      failures.push(...result.failures.map((failure) => ({
        ...failure,
        siteOrigin: crawlOrigin,
        brandOrigin: site.brandOrigin || site.origin,
        portfolioDepth: 1,
      })));
      scopeExclusions.push(...(result.exclusions || []).map((exclusion) => ({
        ...exclusion,
        siteOrigin: crawlOrigin,
        brandOrigin: site.brandOrigin || site.origin,
        portfolioDepth: 1,
      })));
    } catch (error) {
      failures.push({
        siteOrigin: crawlOrigin,
        brandOrigin: site.brandOrigin || site.origin,
        portfolioDepth: 1,
        reason: String(error),
      });
    }
  }

  const portfolioScopeMode = opts.scopeMode || (
    portfolioDiscovery.sites.some((site) =>
      !isSameSite(startUrl, site.brandUrl || site.origin)
    )
      ? "verified_brand_sites"
      : "same_site"
  );
  const storefrontsDeferred = (portfolioDiscovery.rejectedSites || [])
    .filter((site) => site.reason === "portfolio_origin_limit").length;
  const portfolioProfile = createPortfolioProfile(startUrl, portfolioDiscovery.sites, {
    scopeMode: portfolioScopeMode,
    maxDepth: opts.maxDepth,
    learnedAt: parentProfile?.portfolio?.learnedAt,
  });
  const mergedRecords = mergeProductRecords(records);
  const allSitesComplete = failures.length === 0
    && storefrontsDeferred === 0
    && siteResults.length === portfolioDiscovery.sites.length
    && siteResults.every((site) => site.completion?.status === "complete");
  const profilePromotion = allSitesComplete
    ? assessProfilePromotion(mergedRecords, {
      fields,
      minSamples: opts.profilePromotionMinSamples,
      singleProductCatalog:
        portfolioDiscovery.sites.length === 1
        && siteResults.length === 1
        && siteResults[0].stats?.catalogCollectionStatus === "complete"
        && Number(siteResults[0].stats?.productUrlsDiscovered ?? 0)
          + Number(siteResults[0].stats?.inlineRecordsDiscovered ?? 0) === 1,
    })
    : {
      ready: false,
      requiredSamples: opts.profilePromotionMinSamples ?? 2,
      validSamples: 0,
      reasons: ["portfolio_collection_incomplete"],
    };
  let savedProfilePath = null;
  if (opts.profileDir && opts.saveProfile !== false && profilePromotion.ready) {
    const persisted = createSiteProfile({
      startUrl,
      fields,
      discovery: parentProfile?.discovery || {
        strategy: "portfolio",
        listingSeeds: [],
        storefrontOrigins: portfolioDiscovery.sites.map((site) =>
          site.finalOrigin || site.origin
        ),
      },
      listingProfile: parentProfile?.listingProfile || null,
      detailProfile: parentProfile?.detailProfile || null,
      imageProfile: parentProfile?.imageProfile || null,
      cdpProfile: parentProfile?.cdpProfile || null,
      portfolio: portfolioProfile,
      learnedAt: parentProfile?.learnedAt,
      validation: parentProfile?.validation,
    });
    savedProfilePath = await saveSiteProfile(opts.profileDir, persisted);
  }

  return {
    records: mergedRecords,
    completion: {
      status: allSitesComplete ? "complete" : "incomplete",
      resumeRequired: !allSitesComplete,
      reasons: allSitesComplete
        ? []
        : [
          ...(storefrontsDeferred > 0 ? ["portfolio_brand_limit_reached"] : []),
          ...(failures.length > 0
              || siteResults.length !== portfolioDiscovery.sites.length
              || siteResults.some((site) => site.completion?.status !== "complete")
            ? ["portfolio_collection_incomplete"]
            : []),
        ],
      storefrontsRemaining: Math.max(
        0,
        storefrontsDeferred + portfolioDiscovery.sites.length
          - siteResults.filter((site) => site.completion?.status === "complete").length,
      ),
    },
    stats: {
      startUrl,
      productScopePolicy: opts.productScope === "all_products"
        ? "all_products"
        : PRODUCT_SCOPE_POLICY,
      portfolioSource: portfolioDiscovery.source,
      portfolioScopeMode,
      portfolioCandidates: portfolioDiscovery.candidates.length,
      storefrontsVerified: portfolioDiscovery.sites.length,
      storefrontsCrawled: siteResults.length,
      storefrontsDeferred,
      maxPortfolioDepth: 1,
      nestedSitesRejected: (portfolioDiscovery.rejectedSites || []).length,
      recordsExtracted: records.length,
      productsExcludedByScope: siteResults.reduce(
        (sum, site) => sum + Number(site.stats?.productsExcludedByScope ?? 0),
        0,
      ),
      scopeExclusionReasons: siteResults.reduce((reasonCounts, site) => {
        for (const [reason, count] of Object.entries(
          site.stats?.scopeExclusionReasons ?? {},
        )) {
          reasonCounts[reason] = (reasonCounts[reason] ?? 0) + Number(count);
        }
        return reasonCounts;
      }, {}),
      fieldCoverage: fieldCoverage(records, fields),
      profile: {
        replayed: portfolioDiscovery.source === "portfolio_profile",
        saved: Boolean(savedProfilePath),
        path: savedProfilePath,
        promotion: profilePromotion,
      },
      sites: siteResults,
    },
    failures: failures.slice(0, 50),
    exclusions: scopeExclusions.slice(0, 50),
    events,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function countScopeExclusionReasons(exclusions) {
  const counts = {};
  for (const item of exclusions || []) {
    const reason = item?.reason || "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function recordIdentity(record) {
  const value = record?.fields?.product_url
    || record?.fields?.productUrl
    || record?.fields?.url
    || record?.productUrl
    || record?.product_url
    || record?.sourceUrl
    || "";
  try {
    const normalized = normalizeProductUrl(value);
    const explicitVariant = variantIdentity(record, { baseUrl: value });
    return explicitVariant ? `${normalized}::${explicitVariant}` : normalized;
  } catch {
    return value;
  }
}

function recordImageUrls(record) {
  const images = record?.fields?.images ?? record?.fields?.image;
  if (Array.isArray(images)) return images.filter((value) => typeof value === "string" && value);
  return typeof images === "string" && images ? [images] : [];
}

function expectedImageCount(opts = {}) {
  const configured = opts.imageProfile?.minExpectedCount ?? opts.minImagesBeforeGalleryUpgrade;
  return Math.max(1, configured ?? MIN_IMAGES_BEFORE_GALLERY_UPGRADE);
}

/** A single image is valid data, but too weak to prove a gallery is complete. */
export function recordNeedsRenderedImageUpgrade(record, requestedFields, opts = {}) {
  const wantsImages = requestedFields.includes("images") || requestedFields.includes("image");
  return wantsImages && recordImageUrls(record).length < expectedImageCount(opts);
}

function nextImageProxyTarget(image, baseUrl) {
  try {
    const parsed = new URL(image, baseUrl);
    if (!/\/_next\/image$/i.test(parsed.pathname)) return null;
    const target = parsed.searchParams.get("url");
    if (!target) return null;
    const resolved = new URL(target, parsed.origin);
    if (!/^https?:$/.test(resolved.protocol)) return null;
    if (!/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(resolved.toString())) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function crawlImageIdentity(image, baseUrl) {
  return nextImageProxyTarget(image, baseUrl) || imageIdentityKey(image, baseUrl);
}

function isLikelyCrawlImageUrl(image, baseUrl) {
  return isLikelyProductImageUrl(image) || Boolean(nextImageProxyTarget(image, baseUrl));
}

function deriveCrawlOriginalImageCandidate(image, baseUrl) {
  const builtIn = deriveOriginalImageCandidate(image, baseUrl);
  if (builtIn) return builtIn;
  const originalUrl = nextImageProxyTarget(image, baseUrl);
  if (!originalUrl) return null;
  const sourceUrl = new URL(image, baseUrl).toString();
  return {
    sourceUrl,
    originalUrl,
    resolver: "next_image_proxy",
    validationGroup: `next_image_proxy:${new URL(sourceUrl).origin}`,
  };
}

function dedupeImagesByIdentity(images, baseUrl) {
  const byIdentity = new Map();
  for (const image of images) {
    if (typeof image !== "string" || !image) continue;
    try {
      const resolved = normalizeImageUrl(image, baseUrl);
      if (!isLikelyCrawlImageUrl(resolved, baseUrl)) continue;
      const identity = crawlImageIdentity(resolved, baseUrl);
      const existing = byIdentity.get(identity);
      const width = Number(new URL(resolved).searchParams.get("w") || 0);
      const existingWidth = existing
        ? Number(new URL(existing).searchParams.get("w") || 0)
        : -1;
      if (!existing || width > existingWidth) byIdentity.set(identity, resolved);
    } catch {
      // Ignore malformed lazy-load placeholders.
    }
  }
  return uniqueImages([...byIdentity.values()]);
}

function recordSourceUrl(record) {
  return record?.sourceUrl || record?.fields?.url || "";
}

function safeRecordOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function sourceReference(record, context = {}) {
  const sourceUrl = recordSourceUrl(record);
  return {
    sourceUrl,
    sourceOrigin: safeRecordOrigin(sourceUrl),
    layer: String(record?._meta?.layer || context.layer || "unknown").slice(0, 120),
    ...(context.routeStartOrigin ? { routeStartOrigin: context.routeStartOrigin } : {}),
    ...(context.relationType ? { relationType: context.relationType } : {}),
  };
}

function uniqueSourceReferences(references = []) {
  const seen = new Set();
  const out = [];
  for (const reference of references) {
    if (!reference?.sourceUrl) continue;
    const key = [
      reference.sourceUrl,
      reference.sourceOrigin,
      reference.layer,
      reference.routeStartOrigin,
      reference.relationType,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reference);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Attach value-free field provenance to a product record. This keeps values
 * from a brand catalog, official store, or external detail page attributable
 * to the origin that actually supplied them.
 */
export function annotateProductRecordSources(record, context = {}) {
  if (!record || typeof record !== "object") return record;
  const reference = sourceReference(record, context);
  const existingFieldSources = record?._meta?.fieldSources || {};
  const fieldSources = {};
  for (const field of Object.keys(record.fields || {})) {
    const contextualizedExisting = (
      Array.isArray(existingFieldSources[field]) ? existingFieldSources[field] : []
    ).map((existing) => (
      existing?.sourceUrl === reference.sourceUrl
        && (!existing.layer || existing.layer === reference.layer)
        ? { ...existing, ...reference }
        : existing
    ));
    fieldSources[field] = uniqueSourceReferences([
      ...contextualizedExisting,
      reference,
    ]);
  }
  return {
    ...record,
    fields: {
      ...(record.fields || {}),
      ...(Array.isArray(record?.fields?.images) ? { images: [...record.fields.images] } : {}),
    },
    _meta: {
      ...(record._meta || {}),
      sourceOrigin: reference.sourceOrigin,
      ...(context.routeStartOrigin ? { routeStartOrigin: context.routeStartOrigin } : {}),
      ...(context.relationType ? { relationType: context.relationType } : {}),
      fieldSources,
      ...(record?._meta?.fieldConflicts
        ? { fieldConflicts: structuredClone(record._meta.fieldConflicts) }
        : {}),
    },
  };
}

export function annotateRecordsFromVisualRoute(records, startUrl, routeInput) {
  const route = normalizeVisualRoute(routeInput);
  const routeStartOrigin = safeRecordOrigin(startUrl);
  const relations = (route?.steps || []).flatMap((step, index) => {
    const relationType = step.action?.relationType;
    const targetUrl = step.action?.targetUrl || route?.steps?.[index + 1]?.url;
    const targetOrigin = safeRecordOrigin(targetUrl);
    return relationType && targetOrigin
      ? [{ relationType, targetOrigin }]
      : [];
  });
  return (records || []).map((record) => {
    const sourceOrigin = safeRecordOrigin(recordSourceUrl(record));
    const relationType = relations.find((relation) =>
      relation.targetOrigin === sourceOrigin
    )?.relationType;
    return annotateProductRecordSources(record, {
      routeStartOrigin,
      ...(relationType ? { relationType } : {}),
    });
  });
}

function mergeRecordSourceMetadata(existing, incoming) {
  existing._meta ||= {};
  const existingSources = existing._meta.fieldSources || {};
  const incomingSources = incoming?._meta?.fieldSources || {};
  const merged = {};
  for (const field of new Set([...Object.keys(existingSources), ...Object.keys(incomingSources)])) {
    merged[field] = uniqueSourceReferences([
      ...(existingSources[field] || []),
      ...(incomingSources[field] || []),
    ]);
  }
  existing._meta.fieldSources = merged;
}

function addScalarFieldConflict(existing, incoming, field, current, value) {
  if (!["price", "currency"].includes(field)) return;
  if (String(current).trim() === String(value).trim()) return;
  existing._meta ||= {};
  existing._meta.fieldConflicts ||= {};
  const observations = [
    ...(existing._meta.fieldConflicts[field] || []),
    ...((existing._meta.fieldSources?.[field] || []).map((source) => ({
      value: String(current).slice(0, 200),
      ...source,
    }))),
    ...((incoming?._meta?.fieldSources?.[field] || []).map((source) => ({
      value: String(value).slice(0, 200),
      ...source,
    }))),
  ];
  const seen = new Set();
  existing._meta.fieldConflicts[field] = observations.filter((observation) => {
    const key = `${observation.value}|${observation.sourceUrl}|${observation.layer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

/**
 * Merge batch and rendered-page variants without losing a valid fast-path
 * record. Scalar fields keep the first non-empty value; image arrays are
 * unioned by original-asset identity.
 */
export function mergeProductRecords(records) {
  const byUrl = new Map();
  for (const rawRecord of records) {
    const record = annotateProductRecordSources(rawRecord);
    const identity = recordIdentity(record);
    if (!record || !identity) continue;
    const existing = byUrl.get(identity);
    if (!existing) {
      byUrl.set(identity, record);
      continue;
    }
    const incomingFields = record.fields || {};
    for (const [field, value] of Object.entries(incomingFields)) {
      if (field === "images" || field === "image") continue;
      const current = existing.fields[field];
      const currentMissing = current == null
        || typeof current === "string" && current.trim() === ""
        || Array.isArray(current) && current.length === 0;
      if (currentMissing) existing.fields[field] = value;
      else addScalarFieldConflict(existing, record, field, current, value);
    }
    mergeRecordSourceMetadata(existing, record);
    const mergedImages = dedupeImagesByIdentity([
      ...recordImageUrls(existing),
      ...recordImageUrls(record),
    ], identity);
    if (mergedImages.length > 0) existing.fields.images = mergedImages;
  }
  return [...byUrl.values()];
}

function isRealProductDetailUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol)
      && !/^inline-product=/i.test(url.hash.slice(1));
  } catch {
    return false;
  }
}

/**
 * Classify inventory records without pretending that a title plus thumbnail is
 * a completed detail extraction. The model decides how to recover; this helper
 * only reports which evidence is still absent.
 */
export function assessProductRecordCompletion(record, options = {}) {
  const requiredFields = options.fields || DEFAULT_FIELDS;
  const profile = options.profile || null;
  const missing = splitMissingDetailExtractionFieldsByPolicy(
    missingDetailExtractionFields(record, requiredFields),
    profile,
  ).requiredMissingFields;
  const reasons = [...missing.map((field) => `field:${field}`)];
  const productUrl = record?.fields?.product_url
    ?? record?.fields?.productUrl
    ?? record?.fields?.url
    ?? record?.productUrl
    ?? record?.sourceUrl;
  if (!isRealProductDetailUrl(productUrl)) reasons.push("product_url:not_real_detail_url");

  if (requiredFields.some((field) => field === "images" || field === "image")
      && options.requireGalleryReview !== false) {
    const review = record?.fields?.gallery_review
      ?? record?.fields?.galleryReview
      ?? record?._meta?.galleryReview;
    const reviewedImageUrls = new Set(
      (review?.reviewed_image_urls ?? review?.reviewedImageUrls ?? [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    const images = recordImageUrls(record);
    if (review?.status !== "visual_complete"
        || images.some((image) => !reviewedImageUrls.has(image))) {
      reasons.push("gallery:visual_review_required");
    }
  }
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasons: [...new Set(reasons)],
  };
}

/**
 * A mapped route is only promoted to a reusable profile after real detail
 * records prove that its field and gallery rules work. Semantic API readiness
 * is a later gate; a completion-marked partial record still cannot promote a
 * route profile.
 */
export function assessProfilePromotion(records, options = {}) {
  const sourceRecords = Array.isArray(records) ? records : [];
  const requestedFields = options.fields || DEFAULT_FIELDS;
  const profile = options.profile || null;
  const validRecords = sourceRecords.filter((record) => {
    const completion = record?._meta?.completion;
    if (completion && completion.status !== "complete") return false;
    const productUrl = record?.fields?.product_url
      ?? record?.fields?.productUrl
      ?? record?.fields?.url
      ?? record?.productUrl
      ?? record?.sourceUrl;
    if (!isRealProductDetailUrl(productUrl)) return false;
    const missing = splitMissingDetailExtractionFieldsByPolicy(
      missingDetailExtractionFields(record, requestedFields),
      profile,
    ).requiredMissingFields;
    return missing.length === 0;
  });
  const requiredSamples = options.singleProductCatalog === true
    ? 1
    : Math.max(2, options.minSamples ?? 2);
  const ready = validRecords.length >= requiredSamples;
  return {
    ready,
    requiredSamples,
    validSamples: validRecords.length,
    reasons: ready
      ? []
      : sourceRecords.length === 0
        ? ["no_product_records"]
        : ["representative_detail_validation_incomplete"],
  };
}

export function annotateProductRecordCompletion(records, options = {}) {
  return (records || []).map((record) => ({
    ...record,
    _meta: {
      ...(record._meta || {}),
      completion: assessProductRecordCompletion(record, options),
    },
  }));
}

/** Per-field fill rate, the quickest signal that a profile needs another pass. */
export function fieldCoverage(records, fields) {
  const coverage = {};
  for (const field of fields) {
    const filled = records.filter((record) => {
      const value = record?.fields?.[field];
      if (Array.isArray(value)) return value.length > 0;
      return typeof value === "string" ? value.trim() !== "" : value != null;
    }).length;
    coverage[field] = records.length === 0 ? 0 : Math.round((filled / records.length) * 100) / 100;
  }
  return coverage;
}

/** Compact, context-safe summary. Print this instead of the records. */
export function summarize(result) {
  return JSON.stringify({
    completion: result.completion ?? null,
    stats: result.stats,
    failures: result.failures,
    exclusions: (result.exclusions || []).slice(0, 10),
    reviewQueue: (result.reviewQueue || []).slice(0, 10),
    recordSample: (result.records || []).slice(0, 3).map((record) => ({
      productUrl: record?.fields?.product_url
        ?? record?.fields?.productUrl
        ?? record?.sourceUrl
        ?? null,
      title: record?.fields?.title ?? null,
      images: record?.fields?.images?.length ?? 0,
      completion: record?._meta?.completion ?? null,
    })),
  }, null, 2);
}
