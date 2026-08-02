/**
 * Two-pass visual route learning.
 *
 * Pass 1 is deliberately agent-driven: screenshots and coordinate clicks reach
 * a representative listing/detail page without paying the DOM/CDP inspection
 * cost at every screen. Pass 2 calls replayVisualRoute() to retrace that known
 * path under DOM and Network observation, producing stable selectors and
 * bounded response metadata that can be turned into a value-free site profile.
 */

import {
  captureBrowserActionEvidence,
  captureBrowserEvidence,
} from "./browser-evidence.mjs";
import {
  computeTemplateFingerprint,
  normalizeListingProfile,
  normalizeVisualRoute,
  validateMappedVisualRoute,
} from "./profile-store.mjs";
import {
  normalizeDetailExtractionProfile,
  normalizeImageExtractionProfile,
} from "./engine.mjs";
import { createReplayOperationRunner } from "./operation-control.mjs";

const UNSAFE_ACTION_RE =
  /\b(?:add\s+to\s+(?:cart|basket)|checkout|place\s+order|buy\s+now|aggiungi\s+al\s+carrello|vai\s+alla\s+cassa)\b/i;
const GALLERY_BACKED_FACT_FIELDS = new Set(["supplement_facts"]);

function validFieldMapping(mapping) {
  return Boolean(mapping?.selector && mapping?.quality?.valid);
}

function mappingLooksImageBacked(mapping) {
  if (!validFieldMapping(mapping) || Number(mapping.quality.imageCount || 0) < 1) {
    return false;
  }
  return ["img", "picture", "source"].includes(mapping.quality.tagName)
    || Number(mapping.quality.textLength || 0) < 10;
}

function mappedGalleryField(fields) {
  const checkpoint = [...fields].reverse().find((item) =>
    ["images", "image"].includes(item?.field)
      && item?.targetSelector
      && item?.quality?.valid
      && Number(item.quality.imageCount || 0) > 0
  );
  return checkpoint ? {
    selector: checkpoint.targetSelector,
    selectorCount: checkpoint.quality.selectorCount,
    tagName: checkpoint.quality.tagName,
    usedScreenTarget: false,
    quality: checkpoint.quality,
  } : null;
}

function compactEvidence(evidence) {
  return {
    url: evidence?.url || null,
    htmlBytes: Number(evidence?.htmlBytes || 0),
    templateFingerprint: computeTemplateFingerprint(evidence?.html || ""),
    capabilities: evidence?.capabilities || { cdp: false, pageAssets: false },
    network: {
      eventCount: Number(evidence?.network?.eventCount || 0),
      responseCount: Number(evidence?.network?.responseCount || 0),
      truncated: Boolean(evidence?.network?.truncated),
    },
    imageEvidence: evidence?.imageEvidence || null,
    errors: evidence?.errors || {},
  };
}

function routeNetworkCandidates(checkpoints) {
  const seen = new Set();
  const out = [];
  for (const checkpoint of checkpoints) {
    for (const response of checkpoint.rawEvidence?.network?.responses || []) {
      if (!["XHR", "Fetch"].includes(response?.type) || !response?.url) continue;
      const key = `${response.type}:${response.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        stepIndex: checkpoint.stepIndex,
        pageRole: checkpoint.pageRole,
        url: response.url,
        type: response.type,
        status: response.status,
        mimeType: response.mimeType,
      });
      if (out.length >= 120) return out;
    }
  }
  return out;
}

function inferRouteActionKind(step, next) {
  if (step?.action?.actionKind) return step.action.actionKind;
  if (next?.pageRole === "detail") return "product_entry";
  if (["listing", "inline_catalog"].includes(next?.pageRole)
      && ["home", "portfolio", "listing"].includes(step?.pageRole)) {
    return "catalog_entry";
  }
  return null;
}

async function collectMappedCatalogUrls(tab, selector, baseUrl, opts = {}) {
  if (!selector) return [];
  return tab.playwright.evaluate(({ selector: pageSelector, baseUrl: pageBaseUrl, limit }) => {
    const urls = [];
    const seen = new Set();
    let base;
    try {
      base = new URL(pageBaseUrl, location.href);
    } catch {
      return [];
    }
    let elements;
    try {
      elements = [...document.querySelectorAll(pageSelector)];
    } catch {
      return [];
    }
    for (const element of elements) {
      const anchor = element.matches("a[href]") ? element : element.closest("a[href]");
      const raw = anchor?.href || anchor?.getAttribute("href") || "";
      if (!raw) continue;
      try {
        const url = new URL(raw, base);
        if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin) continue;
        if (/\/(?:cart|checkout|account|login|search|blog|news|contact|privacy|terms)(?:\/|$)/i.test(url.pathname)) {
          continue;
        }
        url.hash = "";
        const normalized = url.toString();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        urls.push(normalized);
        if (urls.length >= limit) break;
      } catch {
        // Ignore malformed or non-navigation hrefs.
      }
    }
    return urls;
  }, {
    selector,
    baseUrl,
    limit: Math.min(200, Math.max(1, opts.maxCatalogFamilyLinks || 100)),
  }, { timeoutMs: opts.timeoutMs ?? 12_000 });
}

/**
 * Resolve one action from the visual pass to stable DOM selectors.
 *
 * The exact selector replays this one route. generalSelector is emitted only
 * when the clicked element belongs to a repeated structure, making it a
 * candidate listing-card selector rather than a product-specific href.
 */
export async function mapVisualRouteAction(tab, action = {}, opts = {}) {
  const actionText = typeof action.text === "string" ? action.text.trim() : "";
  const targetUrl = typeof action.targetUrl === "string" ? action.targetUrl : "";
  return tab.playwright.evaluate(({ actionText, targetUrl }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const cssValue = (value) => JSON.stringify(String(value));
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    };
    const visible = (element) =>
      element instanceof Element && element.getClientRects().length > 0;
    const target = (() => {
      try {
        return targetUrl ? new URL(targetUrl, location.href) : null;
      } catch {
        return null;
      }
    })();

    const candidates = [...document.querySelectorAll(
      "a[href], button, [role='link'], [role='button']",
    )].filter(visible).map((element) => {
      const anchor = element.matches("a[href]") ? element : element.closest("a[href]");
      const href = anchor?.href || "";
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const ariaLabel = element.getAttribute("aria-label") || "";
      let score = 0;
      if (target && href) {
        try {
          const parsed = new URL(href, location.href);
          if (parsed.href === target.href) score += 240;
          else if (parsed.origin === target.origin && parsed.pathname === target.pathname) score += 180;
        } catch {
          // Ignore malformed hrefs.
        }
      }
      const wanted = normalize(actionText);
      if (wanted) {
        if (normalize(text) === wanted) score += 140;
        else if (normalize(text).includes(wanted) || wanted.includes(normalize(text))) score += 70;
        if (normalize(ariaLabel) === wanted) score += 120;
      }
      return { element, anchor, href, text, ariaLabel, score };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];
    if (!best) return null;
    const element = best.anchor || best.element;
    const tag = element.tagName.toLowerCase();
    const exactCandidates = [];
    const generalCandidates = [];
    if (element.id) exactCandidates.push(`#${CSS.escape(element.id)}`);
    for (const name of [
      "data-testid",
      "data-test-id",
      "data-test",
      "data-product-link",
      "data-product-id",
      "aria-label",
    ]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const selector = `${tag}[${name}=${cssValue(value)}]`;
      exactCandidates.push(selector);
      generalCandidates.push(selector);
    }
    const rawHref = element.getAttribute("href");
    if (rawHref) {
      const hrefSelector = `${tag}[href=${cssValue(rawHref)}]`;
      if (element.closest("header")) exactCandidates.push(`header ${hrefSelector}`);
      if (element.closest("nav")) exactCandidates.push(`nav ${hrefSelector}`);
      if (element.closest("[role='navigation']")) {
        exactCandidates.push(`[role='navigation'] ${hrefSelector}`);
      }
      exactCandidates.push(hrefSelector);
    }
    const classNames = [...element.classList]
      .filter((name) => name.length <= 80 && !/\d{4,}/.test(name))
      .slice(0, 4);
    for (const className of classNames) {
      const selector = `${tag}.${CSS.escape(className)}`;
      exactCandidates.push(selector);
      generalCandidates.push(selector);
    }
    if (classNames.length >= 2) {
      const selector = `${tag}.${classNames.slice(0, 2).map((name) => CSS.escape(name)).join(".")}`;
      exactCandidates.unshift(selector);
      generalCandidates.unshift(selector);
    }

    const stableElementSelectors = [...new Set([
      ...generalCandidates,
      element.matches("a[href]") ? "a[href]" : tag,
    ])];
    const repeatedAncestorCandidates = [];
    let ancestor = element.parentElement;
    for (let depth = 1;
      ancestor instanceof Element && ancestor !== document.body && depth <= 6;
      depth += 1, ancestor = ancestor.parentElement) {
      const ancestorTag = ancestor.tagName.toLowerCase();
      const ancestorSelectors = [];
      for (const name of [
        "data-product",
        "data-product-card",
        "data-product-id",
        "data-testid",
        "data-test-id",
      ]) {
        const value = ancestor.getAttribute(name);
        if (value) ancestorSelectors.push(`${ancestorTag}[${name}=${cssValue(value)}]`);
        if (ancestor.hasAttribute(name) && name !== "data-product-id") {
          ancestorSelectors.push(`${ancestorTag}[${name}]`);
        }
      }
      const ancestorClasses = [...ancestor.classList]
        .filter((name) => name.length <= 80 && !/\d{4,}/.test(name))
        .filter((name) => /product|card|tile|item|grid|result/i.test(name))
        .slice(0, 4);
      for (const className of ancestorClasses) {
        ancestorSelectors.push(`${ancestorTag}.${CSS.escape(className)}`);
      }
      if (["article", "li"].includes(ancestorTag)) ancestorSelectors.push(ancestorTag);

      for (const ancestorSelector of [...new Set(ancestorSelectors)]) {
        const ancestorCount = count(ancestorSelector);
        if (ancestorCount < 2 || ancestorCount > 500) continue;
        for (const descendantSelector of stableElementSelectors) {
          const combined = `${ancestorSelector} ${descendantSelector}`;
          let matches = [];
          try {
            matches = [...document.querySelectorAll(combined)]
              .filter(visible)
              .filter((candidate) => candidate.matches("a[href]") || candidate.closest("a[href]"));
          } catch {
            continue;
          }
          const hrefs = new Set(matches.map((candidate) =>
            (candidate.matches("a[href]") ? candidate : candidate.closest("a[href]"))?.href
          ).filter(Boolean));
          if (matches.length < 2 || matches.length > 500 || hrefs.size < 2) continue;
          if (!matches.some((candidate) => candidate === element || candidate.contains(element))) {
            continue;
          }
          repeatedAncestorCandidates.push({
            selector: combined,
            count: matches.length,
            uniqueHrefCount: hrefs.size,
            depth,
          });
        }
      }
    }

    const exact = exactCandidates
      .map((selector) => ({ selector, count: count(selector) }))
      .filter((entry) => entry.count >= 1 && entry.count <= 20)
      .sort((left, right) => left.count - right.count)[0] || null;
    const reusable = generalCandidates
      .map((selector) => ({ selector, count: count(selector) }))
      .filter((entry) => entry.count >= 2 && entry.count <= 500)
      .sort((left, right) => left.count - right.count)[0] || null;
    const repeated = repeatedAncestorCandidates
      .sort((left, right) => left.depth - right.depth
        || left.count - right.count
        || left.selector.length - right.selector.length)[0] || null;
    const repeatedSource = repeated
      && element.closest("header, nav, [role='navigation'], [role='menu']")
      ? "repeated_navigation"
      : repeated
        ? "repeated_ancestor"
        : null;
    return {
      selector: exact?.selector || null,
      selectorCount: exact?.count || 0,
      generalSelector: repeated?.selector || reusable?.selector || null,
      generalSelectorCount: repeated?.count || reusable?.count || 0,
      ...(repeated ? {
        generalSelectorSource: repeatedSource,
        generalSelectorUniqueHrefCount: repeated.uniqueHrefCount,
      } : {}),
      href: best.href || null,
      text: best.text || best.ariaLabel || null,
      tagName: tag,
      score: best.score,
    };
  }, { actionText, targetUrl }, { timeoutMs: opts.timeoutMs ?? 12_000 });
}

/**
 * Map the screen position visually identified in pass 1 to a stable field
 * selector in pass 2. Coordinates are transient input only; the returned
 * selector is what may enter a profile.
 */
export async function mapVisualFieldTarget(tab, checkpoint = {}, opts = {}) {
  const field = typeof checkpoint.field === "string" ? checkpoint.field : "";
  const target = checkpoint.target && typeof checkpoint.target === "object"
    ? checkpoint.target
    : checkpoint;
  const x = Number.isFinite(Number(target.x)) ? Number(target.x) : null;
  const y = Number.isFinite(Number(target.y)) ? Number(target.y) : null;
  const selectorHint = typeof checkpoint.targetSelector === "string"
    ? checkpoint.targetSelector
    : "";
  return tab.playwright.evaluate(({ field, x, y, selectorHint }) => {
    const visible = (element) =>
      element instanceof Element && element.getClientRects().length > 0;
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    };
    const cssValue = (value) => JSON.stringify(String(value));
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const candidatesForField = {
      title: ["main h1", "[itemprop='name']", "[data-product-title]"],
      name: ["main h1", "[itemprop='name']", "[data-product-title]"],
      price: [
        "[itemprop='price']",
        "meta[property='product:price:amount']",
        "[data-product-price]",
        "[data-price]",
        "main .price",
      ],
      description: [
        "[itemprop='description']",
        "[data-product-description]",
        "main [class*='description']",
      ],
      ingredients: [
        "[data-ingredients]",
        "main [class*='ingredient']",
      ],
      supplement_facts: [
        "[data-supplement-facts]",
        "main [class*='supplement-fact']",
        "main [class*='nutrition']",
        "main table",
      ],
      images: [
        "[data-product-gallery]",
        "[data-gallery]",
        "main [class*='product-gallery']",
        "main [class*='product-media']",
        "main picture",
        "main img",
      ],
      image: [
        "[data-product-gallery]",
        "[data-gallery]",
        "main [class*='product-gallery']",
        "main [class*='product-media']",
        "main picture",
        "main img",
      ],
    };
    const seedElements = [];
    const addSeed = (element) => {
      if (element instanceof Element && visible(element) && !seedElements.includes(element)) {
        seedElements.push(element);
      }
    };
    if (selectorHint) {
      try {
        for (const element of [...document.querySelectorAll(selectorHint)].filter(visible)) {
          addSeed(element);
        }
      } catch {
        // Continue to the transient screen target.
      }
    }
    if (x != null && y != null) {
      addSeed(document.elementFromPoint(x, y));
    }
    for (const selector of candidatesForField[field] || []) {
      try {
        for (const element of [...document.querySelectorAll(selector)].filter(visible).slice(0, 12)) {
          addSeed(element);
        }
      } catch {
        // Try the next bounded field-specific selector.
      }
    }
    if (seedElements.length === 0) return null;

    const selectorCandidates = [];
    for (const selector of candidatesForField[field] || []) {
      try {
        const matches = [...document.querySelectorAll(selector)].filter(visible);
        if (matches.length === 1) {
          selectorCandidates.push({
            selector,
            depth: 0,
            tag: matches[0].tagName.toLowerCase(),
            element: matches[0],
          });
        }
      } catch {
        // Field-specific fallbacks are best-effort selector candidates.
      }
    }
    const addSelectorCandidates = (seed) => {
      let start = seed;
      if (field === "images" || field === "image") {
        start = seed.closest(
          "[data-product-gallery],[data-gallery],"
            + "[class*='product-gallery'],[class*='product-media'],"
            + "[class*='product-image'],picture",
        ) || seed;
      }
      let selectorRoot = start;
      for (let depth = 0;
        selectorRoot instanceof Element && selectorRoot !== document.body && depth < 5;
        depth += 1, selectorRoot = selectorRoot.parentElement) {
      const tag = selectorRoot.tagName.toLowerCase();
      if (selectorRoot.id) {
          selectorCandidates.push({
            selector: `#${CSS.escape(selectorRoot.id)}`,
            depth,
            tag,
            element: selectorRoot,
          });
      }
      for (const name of [
        "data-testid",
        "data-test-id",
        "data-product-title",
        "data-product-price",
        "data-product-description",
        "data-ingredients",
        "data-supplement-facts",
        "data-product-gallery",
        "data-gallery",
        "itemprop",
        "aria-label",
      ]) {
        const value = selectorRoot.getAttribute(name);
        if (value) {
          selectorCandidates.push({
            selector: `${tag}[${name}=${cssValue(value)}]`,
            depth,
            tag,
              element: selectorRoot,
          });
        }
      }
      const classNames = [...selectorRoot.classList]
        .filter((name) => name.length <= 80 && !/\d{4,}/.test(name))
        .slice(0, 4);
      if (classNames.length >= 2) {
        selectorCandidates.push({
          selector: `${tag}.${classNames.slice(0, 2)
            .map((name) => CSS.escape(name)).join(".")}`,
          depth,
          tag,
            element: selectorRoot,
        });
      }
      for (const className of classNames) {
        selectorCandidates.push({
          selector: `${tag}.${CSS.escape(className)}`,
          depth,
          tag,
            element: selectorRoot,
        });
      }
      if (/^h[1-3]$/.test(tag)) {
        selectorCandidates.push(
            { selector: `main ${tag}`, depth, tag, element: selectorRoot },
            { selector: tag, depth, tag, element: selectorRoot },
        );
      }
        if (depth > 0 && seed !== selectorRoot) {
          const seedTag = seed.tagName.toLowerCase();
          const seedClasses = [...seed.classList]
            .filter((name) => name.length <= 80 && !/\d{4,}/.test(name))
            .slice(0, 2);
          const descendant = seedClasses.length > 0
            ? `${seedTag}.${seedClasses.map((name) => CSS.escape(name)).join(".")}`
            : seedTag;
          if (selectorRoot.id) {
            selectorCandidates.push({
              selector: `#${CSS.escape(selectorRoot.id)} ${descendant}`,
              depth: depth - 0.5,
              tag: seedTag,
              element: seed,
            });
          }
        }
      }
    };
    for (const seed of seedElements) addSelectorCandidates(seed);

    const qualityFor = (element, selectorCount) => {
      const tagName = element.tagName.toLowerCase();
      const text = normalize(element.innerText || element.textContent || element.getAttribute("content"));
      const signature = normalize([
        element.id,
        element.className,
        ...[...element.attributes].map((attribute) => `${attribute.name} ${attribute.value}`),
      ].join(" ")).toLowerCase();
      const imageCount = (element.matches("img,picture,source") ? 1 : 0)
        + element.querySelectorAll("img,picture source").length
        + (/url\(/i.test(getComputedStyle(element).backgroundImage || "") ? 1 : 0);
      const videoCount = (element.matches("video") ? 1 : 0)
        + element.querySelectorAll("video").length;
      const semanticSignals = [];
      const reasons = [];
      let score = selectorCount === 1 ? 2 : -10;
      let valid = false;
      const signal = (name, points) => {
        semanticSignals.push(name);
        score += points;
      };
      const hasMarker = (pattern, name, points = 4) => {
        if (pattern.test(signature)) signal(name, points);
      };

      if (field === "title" || field === "name") {
        if (/^h[1-3]$/.test(tagName)) signal("heading", 5);
        hasMarker(/\b(?:product[-_\s]?)?(?:title|name)\b/, "title_marker", 5);
        if (text.length >= 2 && text.length <= 240) signal("title_length", 3);
        if (text.length > 500) reasons.push("title_container_too_broad");
        valid = score >= 7 && text.length >= 2 && text.length <= 500;
      } else if (field === "price") {
        hasMarker(/\b(?:price|amount|sale|cost)\b/, "price_marker", 5);
        if (/[$€£¥₹₩₽]|(?:usd|eur|gbp|cad|aud|krw|jpy)\b/i.test(text)) {
          signal("currency_text", 4);
        }
        if (element.hasAttribute("content") || element.hasAttribute("data-price")) {
          signal("machine_price", 4);
        }
        valid = score >= 7;
      } else if (field === "description") {
        hasMarker(/\b(?:description|details|overview|about)\b/, "description_marker", 5);
        if (["p", "section", "article"].includes(tagName)) signal("description_block", 3);
        if (text.length >= 40 && text.length <= 8_000) signal("description_length", 3);
        if (text.length > 12_000 || element.children.length > 40) {
          reasons.push("description_container_too_broad");
          score -= 8;
        }
        valid = score >= 7 && text.length >= 20 && text.length <= 12_000;
      } else if (field === "ingredients") {
        hasMarker(/\b(?:ingredient|ingredients|composition|inci)\b/, "ingredients_marker", 6);
        if (text.length >= 10 && text.length <= 12_000) signal("ingredients_length", 2);
        valid = score >= 7;
      } else if (field === "supplement_facts") {
        hasMarker(
          /\b(?:supplement[-_\s]?facts?|nutrition|nutritional|serving|daily[-_\s]?value)\b/,
          "nutrition_marker",
          6,
        );
        if (tagName === "table" || element.querySelector("table")) signal("facts_table", 4);
        if (text.length >= 10 && text.length <= 20_000) signal("facts_length", 2);
        valid = score >= 7;
      } else if (field === "images" || field === "image") {
        hasMarker(/\b(?:product[-_\s]?)?(?:gallery|media|image|photo)\b/, "gallery_marker", 5);
        if (imageCount > 0) signal("real_image_descendant", 7);
        if (videoCount > 0 && imageCount === 0) reasons.push("video_only_container");
        valid = score >= 7 && imageCount > 0;
      } else if (field === "__reveal_control__") {
        if (["button", "summary", "a"].includes(tagName)
            || ["button", "link"].includes(element.getAttribute("role"))) {
          signal("interactive_control", 7);
        }
        valid = score >= 7;
      } else {
        valid = selectorCount === 1;
      }
      if (!valid && reasons.length === 0) reasons.push("semantic_score_too_low");
      return {
        valid,
        score,
        tagName,
        selectorCount,
        textLength: text.length,
        imageCount,
        videoCount,
        semanticSignals,
        reasons,
      };
    };

    const deduped = new Map();
    for (const entry of selectorCandidates) {
      if (!deduped.has(entry.selector)) deduped.set(entry.selector, entry);
    }
    const mapped = [...deduped.values()]
      .map((entry) => {
        const selectorCount = count(entry.selector);
        return {
          ...entry,
          count: selectorCount,
          quality: qualityFor(entry.element, selectorCount),
        };
      })
      .filter((entry) => entry.count === 1 && entry.quality.valid)
      .sort((left, right) => right.quality.score - left.quality.score
        || left.depth - right.depth
        || left.selector.length - right.selector.length)[0] || null;
    if (!mapped) return null;
    return {
      selector: mapped.selector,
      selectorCount: mapped.count,
      tagName: mapped.tag,
      usedScreenTarget: x != null && y != null,
      quality: mapped.quality,
    };
  }, { field, x, y, selectorHint }, { timeoutMs: opts.timeoutMs ?? 12_000 });
}

async function clickMappedAction(tab, action, mapping, opts = {}) {
  if (UNSAFE_ACTION_RE.test(action?.text || "") && !action?.targetUrl) {
    throw new Error("unsafe_visual_route_action");
  }
  let locator = null;
  if (mapping?.selector) locator = tab.playwright.locator(mapping.selector);
  else if (action?.text) locator = tab.playwright.getByText(action.text, { exact: true });
  if (!locator) throw new Error("visual_route_action_not_mapped");
  const count = await locator.count();
  if (count === 1) {
    await locator.click({ timeoutMs: opts.actionTimeoutMs ?? 12_000 });
    return;
  }
  const visible = [];
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const candidate = locator.nth(index);
    try {
      if (await candidate.isVisible()) visible.push(candidate);
    } catch {
      // Keep checking the remaining semantic duplicates.
    }
  }
  if (visible.length !== 1) {
    throw new Error(`visual_route_visible_action_count_${visible.length}`);
  }
  await visible[0].click({ timeoutMs: opts.actionTimeoutMs ?? 12_000 });
}

async function scrollForField(tab, checkpoint, opts = {}) {
  const screens = Math.min(12, Math.max(1,
    Number(checkpoint?.revealAction?.screens || checkpoint?.screens || 1)));
  const body = tab.playwright.locator("body");
  for (let index = 0; index < screens; index += 1) {
    await body.press("PageDown", { timeoutMs: opts.actionTimeoutMs ?? 8_000 });
    await tab.playwright.waitForTimeout(250);
  }
}

/**
 * Derive executable, value-free detail/image profiles from a mapped visual
 * field journey. These are hints from the proven route, not a fresh search.
 */
export function extractionProfilesFromVisualRoute(routeInput) {
  const route = normalizeVisualRoute(routeInput);
  if (!route?.fieldJourney) return { detailProfile: null, imageProfile: null };
  const fieldRules = {};
  const fieldPolicy = {};
  const interactionHints = [];
  const galleryContainerHints = [];

  for (const checkpoint of route.fieldJourney.fields) {
    const {
      field,
      availability,
      sourceKind,
      targetSelector,
      revealAction,
    } = checkpoint;
    if (availability === "not_present") {
      fieldPolicy[field] = {
        availability: "not_present",
        missingBehavior: "allow_missing",
      };
      continue;
    }
    const galleryBacked = sourceKind === "gallery_image";
    const interactionHint = !galleryBacked && revealAction ? {
      field,
      action: revealAction.action,
      ...(revealAction.text ? { labelPattern: revealAction.text } : {}),
      ...(revealAction.selectorHint ? { selectorHint: revealAction.selectorHint } : {}),
    } : null;
    fieldPolicy[field] = {
      availability,
      missingBehavior: galleryBacked ? "allow_missing" : "require_fallback",
      ...(interactionHint ? { interactionHints: [interactionHint] } : {}),
    };
    if (interactionHint) interactionHints.push(interactionHint);
    if (field === "images" || field === "image" || galleryBacked) {
      if (targetSelector) galleryContainerHints.push(targetSelector);
    } else if (targetSelector) {
      fieldRules[field] = [{
        mode: "selector_text",
        selectors: [targetSelector],
      }];
    }
  }

  const detailProfile = normalizeDetailExtractionProfile({
    version: 1,
    kind: "detail-extraction",
    fieldRules,
    fieldPolicy,
    interactionHints,
  });
  const imageProfile = normalizeImageExtractionProfile({
    version: 1,
    galleryContainerHints: [...new Set(galleryContainerHints)],
  });
  return {
    detailProfile,
    imageProfile: galleryContainerHints.length > 0 ? imageProfile : null,
  };
}

/**
 * Replay a visually verified route from its start while observing DOM/network.
 *
 * Do not call this to discover a path. The input must come from a completed
 * screenshot-first pass. The returned visualRoute contains only replayable
 * rules; network samples remain transient and are not part of the profile.
 */
export async function replayVisualRoute(tab, routeInput, opts = {}) {
  const route = normalizeVisualRoute(routeInput);
  if (!route || route.steps.length === 0) throw new Error("visual_route_required");
  if (!["visual_complete", "mapped"].includes(route.status)) {
    throw new Error("visual_route_not_complete");
  }
  if (!route.fieldJourney || route.fieldJourney.fields.length === 0) {
    throw new Error("visual_field_journey_required");
  }
  const captureNavigation = opts.captureNavigationEvidence || captureBrowserEvidence;
  const captureAction = opts.captureActionEvidence || captureBrowserActionEvidence;
  const mapAction = opts.mapAction || mapVisualRouteAction;
  const mapFieldTarget = opts.mapFieldTarget || mapVisualFieldTarget;
  const collectCatalogUrls = opts.collectCatalogUrls || collectMappedCatalogUrls;
  const checkpoints = [];
  const fieldCheckpoints = [];
  const catalogFamilies = [];
  const replayStartedAt = Date.now();
  const replayBudgetMs = Math.max(15_000, opts.replayBudgetMs ?? 90_000);
  const operationTimeoutMs = Math.max(250, opts.operationTimeoutMs ?? 15_000);
  const navigationOperationTimeoutMs = Math.max(
    250,
    opts.navigationOperationTimeoutMs ?? operationTimeoutMs,
  );
  const fieldOperationTimeoutMs = Math.max(
    250,
    opts.fieldOperationTimeoutMs ?? Math.min(operationTimeoutMs, 8_000),
  );
  const imageOperationTimeoutMs = Math.max(
    250,
    opts.imageOperationTimeoutMs ?? Math.min(operationTimeoutMs, 10_000),
  );
  const runOperation = createReplayOperationRunner({
    startedAt: replayStartedAt,
    replayBudgetMs,
    operationTimeoutMs,
  });
  const enrichedSteps = route.steps.map((step) => structuredClone(step));
  const rawFieldItems = new Map(
    (Array.isArray(routeInput?.fieldJourney?.fields) ? routeInput.fieldJourney.fields : [])
      .filter((item) => item?.field)
      .map((item) => [String(item.field).trim(), item]),
  );
  const evidenceOpts = {
    ...opts,
    useCdp: true,
    includeImageEvidence: false,
    includePageAssets: false,
    timeoutMs: opts.networkEventTimeoutMs ?? opts.timeoutMs ?? 5_000,
    maxPages: opts.networkMaxPages ?? opts.maxPages ?? 2,
  };

  let evidence = await runOperation(
    "initial_navigation",
    () => captureNavigation(tab, enrichedSteps[0].url, evidenceOpts),
    navigationOperationTimeoutMs,
  );
  checkpoints.push({
    stepIndex: 0,
    pageRole: enrichedSteps[0].pageRole,
    evidence: compactEvidence(evidence),
    rawEvidence: evidence,
  });
  enrichedSteps[0].templateFingerprint = computeTemplateFingerprint(evidence?.html || "");

  for (let index = 0; index < enrichedSteps.length - 1; index += 1) {
    const step = enrichedSteps[index];
    const next = enrichedSteps[index + 1];
    const action = {
      ...(step.action || {}),
      targetUrl: step.action?.targetUrl || next.url,
    };
    const actionKind = inferRouteActionKind(step, next);
    if (actionKind) action.actionKind = actionKind;
    const mapping = await runOperation(
      `route_step_${index}:map_action`,
      () => mapAction(tab, action, opts),
    );
    if (mapping) {
      const productEntry = actionKind === "product_entry" || next.pageRole === "detail";
      const reusableGeneralSelector = !productEntry
        || mapping.generalSelectorSource === "repeated_ancestor";
      step.action = {
        ...action,
        ...(mapping.selector ? { selector: mapping.selector } : {}),
        ...(reusableGeneralSelector && mapping.generalSelector
          ? { generalSelector: mapping.generalSelector }
          : {}),
        ...(reusableGeneralSelector && mapping.generalSelectorSource
          ? { generalSelectorSource: mapping.generalSelectorSource }
          : {}),
      };
    }

    if (actionKind === "catalog_entry") {
      const selector = mapping?.generalSelector || mapping?.selector || "";
      const siblingUrls = selector
        ? await runOperation(
          `route_step_${index}:collect_catalog_family`,
          () => collectCatalogUrls(tab, selector, step.url, opts),
          fieldOperationTimeoutMs,
        )
        : [];
      const listingUrls = [...new Set([
        ...siblingUrls,
        ...(["listing", "inline_catalog"].includes(next.pageRole) ? [next.url] : []),
      ].filter(Boolean))];
      if (selector && listingUrls.length > 0) {
        catalogFamilies.push({
          sourceUrl: step.url,
          sourcePageRole: step.pageRole,
          selector,
          coverage: action.catalogCoverage || "single",
          listingUrls,
        });
      }
      if (action.catalogCoverage === "siblings" && listingUrls.length < 2) {
        throw new Error(`visual_catalog_family_not_mapped:${index}`);
      }
    }

    let usedDirectNavigation = false;
    if (mapping) {
      evidence = await runOperation(
        `route_step_${index}:capture_action`,
        () => captureAction(
          tab,
          () => clickMappedAction(tab, action, mapping, opts),
          { ...evidenceOpts, fallbackUrl: next.url },
        ),
        navigationOperationTimeoutMs,
      );
    } else {
      usedDirectNavigation = true;
      evidence = await runOperation(
        `route_step_${index}:direct_navigation`,
        () => captureNavigation(tab, next.url, evidenceOpts),
        navigationOperationTimeoutMs,
      );
    }

    const resolvedUrl = evidence?.url || await runOperation(
      `route_step_${index}:resolve_url`,
      () => tab.url().catch(() => ""),
      fieldOperationTimeoutMs,
    );
    if (next.url && resolvedUrl && resolvedUrl !== next.url) {
      try {
        const expected = new URL(next.url);
        const actual = new URL(resolvedUrl);
        if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) {
          usedDirectNavigation = true;
          evidence = await runOperation(
            `route_step_${index}:corrective_navigation`,
            () => captureNavigation(tab, next.url, evidenceOpts),
            navigationOperationTimeoutMs,
          );
        }
      } catch {
        // Keep the action evidence when either URL is not parseable.
      }
    }
    next.templateFingerprint = computeTemplateFingerprint(evidence?.html || "");
    checkpoints.push({
      stepIndex: index + 1,
      pageRole: next.pageRole,
      actionFromPageRole: step.pageRole,
      ...(actionKind ? { actionKind } : {}),
      mapping,
      usedDirectNavigation,
      evidence: compactEvidence(evidence),
      rawEvidence: evidence,
    });
  }

  const enrichedFields = [];
  for (const fieldItem of route.fieldJourney.fields) {
    const rawItem = rawFieldItems.get(fieldItem.field) || fieldItem;
    const enriched = structuredClone(fieldItem);
    if (fieldItem.availability === "not_present") {
      enrichedFields.push(enriched);
      fieldCheckpoints.push({
        field: fieldItem.field,
        availability: fieldItem.availability,
        mapped: true,
      });
      continue;
    }

    let revealMapping = null;
    let revealMappingSkipped = false;
    if (fieldItem.availability === "present_hidden" && rawItem.revealAction) {
      const revealAction = {
        text: rawItem.revealAction.text || fieldItem.revealAction?.text || "",
      };
      if (rawItem.revealAction.action === "scroll") {
        evidence = await runOperation(
          `field_${fieldItem.field}:scroll_reveal`,
          () => captureAction(
            tab,
            () => scrollForField(tab, rawItem, opts),
            {
              ...evidenceOpts,
              timeoutMs: opts.fieldNetworkEventTimeoutMs ?? 500,
              networkEventTimeoutMs: opts.fieldNetworkEventTimeoutMs ?? 500,
              expectNavigation: false,
            },
          ),
          fieldOperationTimeoutMs,
        );
      } else {
        revealMapping = await runOperation(
          `field_${fieldItem.field}:map_reveal`,
          () => mapAction(tab, revealAction, opts),
          fieldOperationTimeoutMs,
        );
        if (!revealMapping && (rawItem.revealAction.x != null || rawItem.revealAction.y != null)) {
          revealMapping = await runOperation(
            `field_${fieldItem.field}:map_reveal_target`,
            () => mapFieldTarget(tab, {
              field: "__reveal_control__",
              target: rawItem.revealAction,
            }, opts),
            fieldOperationTimeoutMs,
          );
        }
        if (!revealMapping?.selector) {
          if (!GALLERY_BACKED_FACT_FIELDS.has(fieldItem.field)
              || fieldItem.sourceKind === "dom") {
            throw new Error(`visual_field_reveal_not_mapped:${fieldItem.field}`);
          }
          revealMappingSkipped = true;
        } else {
          evidence = await runOperation(
            `field_${fieldItem.field}:capture_reveal`,
            () => captureAction(
              tab,
              () => clickMappedAction(tab, revealAction, revealMapping, opts),
              {
                ...evidenceOpts,
                timeoutMs: opts.fieldNetworkEventTimeoutMs ?? 500,
                networkEventTimeoutMs: opts.fieldNetworkEventTimeoutMs ?? 500,
                expectNavigation: false,
              },
            ),
            fieldOperationTimeoutMs,
          );
          enriched.revealAction = {
            action: rawItem.revealAction.action === "open_details"
              ? "open_details"
              : "click",
            ...(revealAction.text ? { text: revealAction.text } : {}),
            selectorHint: revealMapping.selector,
          };
        }
      }
    }

    let targetMapping = await runOperation(
      `field_${fieldItem.field}:map_target`,
      () => mapFieldTarget(tab, {
        ...rawItem,
        targetSelector: fieldItem.targetSelector,
      }, opts),
      fieldOperationTimeoutMs,
    );
    let sourceKind = fieldItem.sourceKind || null;
    if (GALLERY_BACKED_FACT_FIELDS.has(fieldItem.field)) {
      const explicitDom = sourceKind === "dom";
      const targetIsImage = mappingLooksImageBacked(targetMapping);
      if (explicitDom && targetIsImage) targetMapping = null;
      const useGalleryFallback = !explicitDom
        && (!validFieldMapping(targetMapping) || targetIsImage || sourceKind === "gallery_image");
      if (useGalleryFallback) {
        let galleryMapping = mappedGalleryField(enrichedFields);
        if (!validFieldMapping(galleryMapping)) {
          galleryMapping = await runOperation(
            `field_${fieldItem.field}:map_gallery`,
            () => mapFieldTarget(tab, {
              ...rawItem,
              field: "images",
              targetSelector: null,
            }, opts),
            fieldOperationTimeoutMs,
          );
        }
        if (validFieldMapping(galleryMapping)) {
          targetMapping = galleryMapping;
          sourceKind = "gallery_image";
        }
      } else if (validFieldMapping(targetMapping)) {
        sourceKind = "dom";
      }
    }
    if (!validFieldMapping(targetMapping)) {
      throw new Error(`visual_field_target_not_mapped:${fieldItem.field}`);
    }
    if (sourceKind) enriched.sourceKind = sourceKind;
    if (sourceKind === "gallery_image") delete enriched.revealAction;
    enriched.targetSelector = targetMapping.selector;
    enriched.quality = targetMapping.quality;
    enrichedFields.push(enriched);
    fieldCheckpoints.push({
      field: fieldItem.field,
      availability: fieldItem.availability,
      ...(sourceKind ? { sourceKind } : {}),
      targetMapping,
      revealMapping,
      ...(revealMappingSkipped ? { revealMappingSkipped: true } : {}),
      evidence: compactEvidence(evidence),
      rawEvidence: evidence,
    });
  }

  const listingMappings = checkpoints
    .filter((checkpoint) => checkpoint.actionFromPageRole === "listing"
      && checkpoint.pageRole === "detail")
    .map((checkpoint) => checkpoint.mapping)
    .filter(Boolean);
  const repeatedListingSelectors = listingMappings
    .filter((mapping) => mapping.generalSelector
      && mapping.generalSelectorSource === "repeated_ancestor"
      && mapping.generalSelectorCount >= 2
      && mapping.generalSelectorUniqueHrefCount >= 2)
    .map((mapping) => mapping.generalSelector);
  const exactSingleProductSelectors = listingMappings
    .filter((mapping) => mapping?.generalSelectorSource !== "repeated_ancestor"
      && mapping?.selector
      && mapping.selectorCount === 1)
    .map((mapping) => mapping.selector);
  const listingSelectors = repeatedListingSelectors.length > 0
    ? repeatedListingSelectors
    : exactSingleProductSelectors;
  const categorySelectors = checkpoints
    .filter((checkpoint) => checkpoint.actionKind === "catalog_entry"
      || (["home", "portfolio", "listing"].includes(checkpoint.actionFromPageRole)
        && ["listing", "inline_catalog"].includes(checkpoint.pageRole)))
    .map((checkpoint) => checkpoint.mapping)
    .filter((mapping) => mapping?.generalSelector && mapping.generalSelectorCount >= 2)
    .map((mapping) => mapping.generalSelector);
  const paginationActions = checkpoints
    .filter((checkpoint) => checkpoint.actionKind === "pagination")
    .map((checkpoint) => ({
      action: "click",
      selector: checkpoint.mapping?.selector,
      text: enrichedSteps[checkpoint.stepIndex - 1]?.action?.text,
    }))
    .filter((item) => item.selector);

  const catalogListingSeeds = [...new Set([
    ...route.steps
      .filter((step) => ["listing", "inline_catalog"].includes(step.pageRole))
      .map((step) => step.url),
    ...catalogFamilies.flatMap((family) => family.listingUrls),
  ])];

  const visualRoute = normalizeVisualRoute({
    ...route,
    status: "mapped",
    steps: enrichedSteps,
    fieldJourney: {
      ...route.fieldJourney,
      status: "mapped",
      fields: enrichedFields,
    },
    ...(catalogListingSeeds.length > 0 || catalogFamilies.length > 0 ? {
      catalogCoverage: {
        status: "mapped",
        listingSeeds: catalogListingSeeds,
        families: catalogFamilies,
        ...(route.catalogCoverage?.listings?.length > 0
          ? { listings: route.catalogCoverage.listings }
          : {}),
        ...(route.catalogCoverage?.closure
          ? { closure: route.catalogCoverage.closure }
          : {}),
      },
    } : {}),
  });
  const routeValidation = validateMappedVisualRoute(visualRoute, {
    fields: route.requestedFields,
  });
  if (!routeValidation.valid) {
    throw new Error(
      `visual_route_mapping_incomplete:${routeValidation.reasons.join(",")}`
        + (routeValidation.missingFields.length > 0
          ? `:${routeValidation.missingFields.join(",")}`
          : ""),
    );
  }
  const profiles = extractionProfilesFromVisualRoute(visualRoute);
  const allCheckpoints = [
    ...checkpoints,
    ...fieldCheckpoints.filter((checkpoint) => checkpoint.rawEvidence),
  ];
  let detailImageEvidence = null;
  if (route.requestedFields.some((field) => field === "images" || field === "image")
      || enrichedFields.some((field) => field.sourceKind === "gallery_image")) {
    const imageEvidence = await runOperation(
      "detail_image_evidence",
      () => captureAction(
        tab,
        async () => {},
        {
          ...opts,
          useCdp: false,
          includeImageEvidence: true,
          includePageAssets: true,
          expectNavigation: false,
          actionSettleMs: 0,
          pageAssetsTimeoutMs: opts.pageAssetsTimeoutMs ?? 2_500,
        },
      ),
      imageOperationTimeoutMs,
    );
    detailImageEvidence = compactEvidence(imageEvidence);
  }

  return {
    visualRoute,
    listingProfile: listingSelectors.length > 0 || categorySelectors.length > 0
        || paginationActions.length > 0
      ? normalizeListingProfile({
        categoryLinkSelectors: categorySelectors,
        productLinkSelectors: listingSelectors,
        paginationActions,
        listingMode: repeatedListingSelectors.length > 0
          ? "repeated_cards"
          : exactSingleProductSelectors.length > 0
            ? "single_product"
            : route.steps.some((step) => step.pageRole === "inline_catalog")
              ? "inline_catalog"
              : undefined,
        scrollListings: true,
      })
      : null,
    detailProfile: profiles.detailProfile,
    imageProfile: profiles.imageProfile,
    checkpoints: checkpoints.map(({ rawEvidence, ...checkpoint }) => checkpoint),
    fieldCheckpoints: fieldCheckpoints.map(({ rawEvidence, ...checkpoint }) => checkpoint),
    ...(detailImageEvidence ? { detailImageEvidence } : {}),
    networkCandidates: routeNetworkCandidates(allCheckpoints),
    replayElapsedMs: Date.now() - replayStartedAt,
  };
}
