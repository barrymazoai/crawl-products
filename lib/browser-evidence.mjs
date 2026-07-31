/**
 * Evidence collection for the Codex in-app Browser.
 *
 * The public Browser surface exposes two optional tab capabilities:
 * - pageAssets: inventory/bundle resources observed in the current page state
 * - cdp: raw Chrome DevTools Protocol commands plus buffered debugger events
 *
 * This module feature-detects both. Callers always receive a useful fallback
 * result when either capability is unavailable or the user declines full-CDP
 * access for an origin.
 */

import {
  imageIdentityKey,
  normalizeImageUrl,
  uniqueImages,
} from "./engine.mjs";
import { normalizeCdpProfile } from "./profile-store.mjs";
import { runWithHardTimeout } from "./operation-control.mjs";

const NETWORK_METHODS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
];

const IMAGE_VALUE_RE =
  /["'](thumb|thumbnail|small|img|image|src|full|large|zoom|original|master)["']\s*:\s*["']([^"']+)["']/gi;
const IMAGE_ATTRIBUTE_RE =
  /\b(data-(?:zoom-src|zoom-image|large-image|large_image|original|master|full|src)|src|href)=["']([^"']+)["']/gi;
const IMAGE_EXTENSION_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;
const DECORATIVE_IMAGE_RE =
  /(?:logo|favicon|icon|sprite|placeholder|payment|social|avatar|badge|rating|loader|spinner)/i;

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function decodeImageValue(value) {
  return String(value || "")
    .replaceAll("\\/", "/")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\u002f", "/")
    .replaceAll("&amp;", "&")
    .trim();
}

function imageTier(key) {
  if (/^(?:full|large|zoom|original|master)$/i.test(key)) return 3;
  if (/^(?:img|image|src)$/i.test(key)) return 2;
  return 1;
}

function normalizeCandidate(value, baseUrl) {
  try {
    const url = normalizeImageUrl(decodeImageValue(value), baseUrl);
    if (!/^https?:/i.test(url) || !IMAGE_EXTENSION_RE.test(url)) return "";
    if (DECORATIVE_IMAGE_RE.test(url)) return "";
    return url;
  } catch {
    return "";
  }
}

function imageBasenameKey(value) {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1)?.toLowerCase() || "";
  } catch {
    return "";
  }
}

export async function getOptionalTabCapability(tab, id) {
  try {
    if (!tab?.capabilities?.list || !tab?.capabilities?.get) return null;
    const listed = await tab.capabilities.list();
    if (!listed.some((entry) => entry?.id === id)) return null;
    return await tab.capabilities.get(id);
  } catch {
    return null;
  }
}

export async function inspectEvidenceCapabilities(tab) {
  const [cdp, pageAssets] = await Promise.all([
    getOptionalTabCapability(tab, "cdp"),
    getOptionalTabCapability(tab, "pageAssets"),
  ]);
  return {
    cdp: Boolean(cdp),
    pageAssets: Boolean(pageAssets),
  };
}

/**
 * Extract image candidates embedded in the page response, including storefront
 * gallery configs that expose separate thumb/img/full URLs.
 */
export function extractResponseImageCandidates(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const add = (key, value, source) => {
    const url = normalizeCandidate(value, baseUrl);
    if (!url) return;
    const dedupeKey = `${key}:${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({
      url,
      key: String(key || "").toLowerCase(),
      tier: imageTier(key),
      source,
    });
  };

  for (const match of String(html || "").matchAll(IMAGE_VALUE_RE)) {
    add(match[1], match[2], "response_config");
  }
  for (const match of String(html || "").matchAll(IMAGE_ATTRIBUTE_RE)) {
    add(match[1], match[2], "response_attribute");
  }
  return out;
}

/**
 * Bind full-size response candidates to the rendered gallery. This prevents a
 * page that embeds several variants or recommendation carousels from leaking
 * unrelated images into the selected product record.
 */
export function selectProductImagesFromEvidence({
  baseUrl,
  renderedImages = [],
  responseCandidates = [],
  assetImages = [],
}) {
  const anchors = uniqueImages(
    renderedImages.map((value) => normalizeCandidate(value, baseUrl)).filter(Boolean),
  );
  if (anchors.length === 0) return [];

  const candidates = [
    ...responseCandidates,
    ...assetImages.map((url) => ({
      url: normalizeCandidate(url, baseUrl),
      key: "asset",
      tier: 2,
      source: "page_assets",
    })),
  ].filter((candidate) => candidate.url);

  const byIdentity = new Map();
  for (const candidate of candidates) {
    const identity = imageIdentityKey(candidate.url, baseUrl);
    const keys = [identity, imageBasenameKey(candidate.url)].filter(Boolean);
    for (const key of keys) {
      const current = byIdentity.get(key);
      if (!current || candidate.tier > current.tier) byIdentity.set(key, candidate);
    }
  }

  const selected = anchors.map((anchor) => {
    const identity = imageIdentityKey(anchor, baseUrl);
    const basename = imageBasenameKey(anchor);
    const direct = byIdentity.get(identity);
    const byName = byIdentity.get(basename);
    const best = !direct ? byName : !byName ? direct
      : byName.tier > direct.tier ? byName : direct;
    return best?.url || anchor;
  });
  return uniqueImages(selected);
}

async function collectRenderedGalleryProjection(tab) {
  try {
    return await tab.playwright.evaluate(() => {
      const rootSelectors = [
        "#gallery",
        "#product-image-desktop",
        "#product-image-mobile",
        "[data-gallery-role]",
        "[data-role*='gallery']",
        "[data-product-gallery]",
        ".gallery-placeholder",
        ".fotorama",
        ".product.media",
        ".product-media",
        ".product__media",
        ".product-gallery",
        ".product__gallery",
        ".product__media-gallery",
        ".woocommerce-product-gallery",
        "[class*='pdp'][class*='gallery']",
        "[class*='product'][class*='gallery']",
      ];
      const roots = [...new Set(rootSelectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
      ))];
      const elements = new Set(roots.flatMap((root) =>
        [...root.querySelectorAll("img, source, a[href]")]
      ));
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
      for (const element of elements) {
        if (element.tagName === "A") add(element.getAttribute("href"));
        if (element.tagName === "IMG") add(element.currentSrc);
        for (const name of [
          "data-zoom-src",
          "data-zoom-image",
          "data-large_image",
          "data-large-image",
          "data-original",
          "data-master",
          "data-full",
          "data-src",
          "src",
        ]) add(element.getAttribute(name));
        addSrcset(element.getAttribute("srcset"));
        addSrcset(element.getAttribute("data-srcset"));
      }
      return out.slice(0, 120);
    });
  } catch {
    return [];
  }
}

async function readEventsFully(cdp, cursor, opts = {}) {
  const events = [];
  let afterSequence = cursor;
  let truncated = false;
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  for (let page = 0; page < maxPages; page += 1) {
    const result = await cdp.readEvents({
      afterSequence,
      methods: NETWORK_METHODS,
      limit: 1000,
      timeoutMs: page === 0 ? (opts.timeoutMs ?? 12_000) : 0,
    });
    events.push(...result.events);
    truncated ||= result.truncated;
    afterSequence = result.cursor;
    if (!result.hasMore) break;
  }
  return { events, cursor: afterSequence, truncated };
}

function compactNetworkResponses(events) {
  return events
    .filter((event) => event.method === "Network.responseReceived" && event.params?.response)
    .map((event) => ({
      requestId: event.params.requestId,
      url: event.params.response.url,
      status: event.params.response.status,
      mimeType: event.params.response.mimeType,
      type: event.params.type,
      fromDiskCache: Boolean(event.params.response.fromDiskCache),
      fromServiceWorker: Boolean(event.params.response.fromServiceWorker),
    }));
}

function responseRuleMatches(rule, response) {
  if (!rule || !response?.url) return false;
  const types = Array.isArray(rule.resourceTypes) ? rule.resourceTypes : ["XHR", "Fetch"];
  if (types.length > 0 && !types.includes(response.type)) return false;
  if (typeof rule.urlIncludes === "string" && rule.urlIncludes) {
    return response.url.includes(rule.urlIncludes);
  }
  if (typeof rule.urlPattern === "string" && rule.urlPattern.length <= 500) {
    try {
      return new RegExp(rule.urlPattern, "i").test(response.url);
    } catch {
      return false;
    }
  }
  return false;
}

async function captureMatchedResponseBodies(cdp, responses, cdpProfile, opts = {}) {
  if (!cdp) return [];
  const rules = normalizeCdpProfile(cdpProfile)?.responseRules || [];
  if (rules.length === 0) return [];
  const maxBodies = Math.min(20, Math.max(1, opts.maxResponseBodies ?? 8));
  const maxBodyBytes = Math.min(
    5_000_000,
    Math.max(1_000, opts.maxResponseBodyBytes ?? 2_000_000),
  );
  const captured = [];

  for (const response of responses) {
    if (captured.length >= maxBodies) break;
    const rule = rules.find((candidate) => responseRuleMatches(candidate, response));
    if (!rule || !response.requestId) continue;
    try {
      const body = await cdp.send("Network.getResponseBody", {
        requestId: response.requestId,
      });
      if (typeof body?.body !== "string" || body.base64Encoded) continue;
      captured.push({
        name: rule.name || null,
        url: response.url,
        type: response.type,
        mimeType: response.mimeType,
        status: response.status,
        body: body.body.slice(0, maxBodyBytes),
        bodyBytes: body.body.length,
        truncated: body.body.length > maxBodyBytes,
      });
    } catch {
      // A response body can be evicted from the debugger buffer; metadata is
      // still retained and the rendered Document remains the fallback.
    }
  }
  return captured;
}

async function pageAssetsInventory(tab, opts = {}) {
  if (opts.includePageAssets === false || opts.includeImageEvidence === false) {
    return { inventory: null, error: null };
  }
  const timeoutMs = Math.max(100, opts.pageAssetsTimeoutMs ?? 2_500);
  let timeoutId;
  try {
    const inventory = await Promise.race([
      (async () => {
        const capability = await getOptionalTabCapability(tab, "pageAssets");
        return capability?.list ? capability.list() : null;
      })(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(Symbol.for("page_assets_timeout")), timeoutMs);
      }),
    ]);
    if (inventory === Symbol.for("page_assets_timeout")) {
      return { inventory: null, error: "page_assets_timeout" };
    }
    return { inventory, error: null };
  } catch {
    return { inventory: null, error: "page_assets_failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function bundleObservedProductAssets(tab, evidence, opts = {}) {
  const inventoryId = evidence?.assets?.inventoryId;
  const assetIds = evidence?.assets?.productAssetIds || [];
  if (!inventoryId || assetIds.length === 0) {
    return {
      assets: [],
      failures: [],
      skipped: true,
      reason: "no_observed_product_assets",
    };
  }
  const capability = await getOptionalTabCapability(tab, "pageAssets");
  if (!capability?.bundle) {
    return {
      assets: [],
      failures: [],
      skipped: true,
      reason: "page_assets_unavailable",
    };
  }
  return capability.bundle({
    inventoryId,
    assetIds: assetIds.slice(0, Math.max(1, opts.maxAssets ?? 80)),
  });
}

/**
 * Navigate with CDP listening whenever the current tab already shares the
 * target origin. On the first visit to a new origin, navigate once to establish
 * scope/permission, then reload under Network observation.
 */
async function captureBrowserEvidenceInternal(tab, url, opts = {}) {
  const targetOrigin = safeOrigin(url);
  const beforeUrl = await tab.url().catch(() => "");
  const sameOrigin = targetOrigin && targetOrigin === safeOrigin(beforeUrl);
  let cdp = opts.useCdp === false
    ? null
    : sameOrigin ? await getOptionalTabCapability(tab, "cdp") : null;
  let cursor = null;
  let cdpError = null;
  let navigationError = null;

  if (cdp) {
    try {
      await cdp.send("Network.enable");
      cursor = (await cdp.readEvents({ methods: NETWORK_METHODS, limit: 1 })).cursor;
    } catch (error) {
      cdpError = String(error);
      cdp = null;
      cursor = null;
    }
  }

  try {
    await tab.goto(url);
  } catch (error) {
    navigationError = String(error);
  }

  if (!cdp && opts.useCdp !== false) {
    cdp = await getOptionalTabCapability(tab, "cdp");
    if (cdp) {
      try {
        await cdp.send("Network.enable");
        cursor = (await cdp.readEvents({ methods: NETWORK_METHODS, limit: 1 })).cursor;
        try {
          await tab.reload();
        } catch (error) {
          navigationError ||= String(error);
        }
      } catch (error) {
        cdpError = String(error);
        cdp = null;
        cursor = null;
      }
    }
  }

  let network = { events: [], cursor, truncated: false };
  if (cdp && cursor != null) {
    try {
      network = await readEventsFully(cdp, cursor, opts);
    } catch (error) {
      cdpError = String(error);
    }
  }
  const responses = compactNetworkResponses(network.events);
  const resolvedUrl = (await tab.url().catch(() => "")) || url;
  const documentResponse = [...responses].reverse().find((response) =>
    response.type === "Document"
      && (response.url === resolvedUrl || safeOrigin(response.url) === safeOrigin(resolvedUrl))
  );

  let html = "";
  let documentBodySource = "dom_fallback";
  if (cdp && documentResponse?.requestId) {
    try {
      const body = await cdp.send("Network.getResponseBody", {
        requestId: documentResponse.requestId,
      });
      if (typeof body?.body === "string" && !body.base64Encoded) {
        html = body.body;
        documentBodySource = "cdp_response";
      }
    } catch (error) {
      cdpError ||= String(error);
    }
  }
  if (!html) {
    try {
      const domHtml = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
      html = typeof domHtml === "string" ? domHtml : "";
    } catch {
      html = "";
    }
  }
  const responseBodies = await captureMatchedResponseBodies(
    cdp,
    responses,
    opts.cdpProfile,
    opts,
  );

  const includeImageEvidence = opts.includeImageEvidence !== false;
  const [renderedProjection, inventoryResult] = includeImageEvidence
    ? await Promise.all([
      collectRenderedGalleryProjection(tab),
      pageAssetsInventory(tab, opts),
    ])
    : [[], { inventory: null, error: null }];
  const inventory = inventoryResult.inventory;
  const renderedImages = Array.isArray(renderedProjection) ? renderedProjection : [];
  const assetImages = inventory?.assets
    ?.filter((asset) => asset.kind === "image")
    .map((asset) => asset.url) || [];
  const responseCandidates = includeImageEvidence
    ? extractResponseImageCandidates(html, resolvedUrl)
    : [];
  const productImages = selectProductImagesFromEvidence({
    baseUrl: resolvedUrl,
    renderedImages,
    responseCandidates,
    assetImages,
  });
  const selectedKeys = new Set(productImages.flatMap((image) => [
    imageIdentityKey(image, resolvedUrl),
    imageBasenameKey(image),
  ]).filter(Boolean));
  const productAssetIds = inventory?.assets
    ?.filter((asset) => asset.kind === "image")
    .filter((asset) => {
      const identity = imageIdentityKey(asset.url, resolvedUrl);
      return selectedKeys.has(identity) || selectedKeys.has(imageBasenameKey(asset.url));
    })
    .map((asset) => asset.id) || [];

  return {
    url: resolvedUrl,
    html,
    htmlBytes: html.length,
    documentBodySource,
    productImages,
    capabilities: {
      cdp: Boolean(cdp),
      pageAssets: Boolean(inventory),
    },
    network: {
      eventCount: network.events.length,
      responseCount: responses.length,
      truncated: network.truncated,
      responses,
      responseBodies,
    },
    assets: inventory ? {
      inventoryId: inventory.id,
      summary: inventory.summary,
      imageCount: assetImages.length,
      productAssetIds,
    } : null,
    imageEvidence: {
      renderedCount: renderedImages.length,
      responseCandidateCount: responseCandidates.length,
      fullCandidateCount: responseCandidates.filter((candidate) => candidate.tier === 3).length,
      selectedCount: productImages.length,
    },
    errors: {
      ...(navigationError ? { navigation: navigationError } : {}),
      ...(cdpError ? { cdp: cdpError } : {}),
      ...(inventoryResult.error ? { pageAssets: inventoryResult.error } : {}),
    },
  };
}

export async function captureBrowserEvidence(tab, url, opts = {}) {
  return runWithHardTimeout(
    () => captureBrowserEvidenceInternal(tab, url, opts),
    {
      label: "capture_browser_evidence",
      timeoutMs: opts.evidenceTimeoutMs ?? opts.operationTimeoutMs ?? 20_000,
      discardTab: true,
    },
  );
}

/**
 * Observe one already-known visual action under CDP.
 *
 * The visual pass reaches the target without inspecting DOM/network state.
 * During the second pass this helper enables Network first, performs the
 * mapped click, then captures the resulting requests and rendered page. This
 * is intentionally separate from captureBrowserEvidence(), which navigates to
 * a URL and therefore cannot observe XHR/modal actions triggered by a click.
 */
async function captureBrowserActionEvidenceInternal(tab, action, opts = {}) {
  if (typeof action !== "function") {
    throw new TypeError("captureBrowserActionEvidence requires an action function");
  }

  let cdp = opts.useCdp === false ? null : await getOptionalTabCapability(tab, "cdp");
  let cursor = null;
  let cdpError = null;
  let actionError = null;
  const beforeUrl = await tab.url().catch(() => "");

  if (cdp) {
    try {
      await cdp.send("Network.enable");
      cursor = (await cdp.readEvents({ methods: NETWORK_METHODS, limit: 1 })).cursor;
    } catch (error) {
      cdpError = String(error);
      cdp = null;
      cursor = null;
    }
  }

  try {
    await action();
  } catch (error) {
    actionError = String(error);
  }

  const expectedUrl = opts.fallbackUrl || "";
  const expectNavigation = Boolean(expectedUrl) || opts.expectNavigation === true;
  if (expectNavigation) {
    const actionDeadline = Date.now() + Math.max(500, opts.actionNavigationWaitMs ?? 5_000);
    while (Date.now() < actionDeadline) {
      const currentUrl = await tab.url().catch(() => "");
      let reachedExpected = false;
      try {
        const current = new URL(currentUrl);
        const expected = expectedUrl ? new URL(expectedUrl) : null;
        reachedExpected = Boolean(expected)
          && current.origin === expected.origin
          && current.pathname === expected.pathname;
      } catch {
        // A non-URL SPA state can still be handled by the settle delay below.
      }
      if (reachedExpected || currentUrl && currentUrl !== beforeUrl) break;
      try {
        await tab.playwright.waitForTimeout(100);
      } catch {
        break;
      }
    }

    try {
      await tab.playwright.waitForLoadState({
        state: "domcontentloaded",
        timeoutMs: opts.navigationTimeoutMs ?? 12_000,
      });
    } catch {
      // SPA route changes may not emit a document load.
    }
  }
  try {
    await tab.playwright.waitForTimeout(
      opts.actionSettleMs ?? (expectNavigation ? 500 : 100),
    );
  } catch {
    // A settled DOM is useful but not required for the evidence fallback.
  }

  let network = { events: [], cursor, truncated: false };
  if (cdp && cursor != null) {
    try {
      network = await readEventsFully(cdp, cursor, {
        ...opts,
        timeoutMs: opts.networkEventTimeoutMs ?? 5_000,
      });
    } catch (error) {
      cdpError = String(error);
    }
  }
  const responses = compactNetworkResponses(network.events);
  const resolvedUrl = (await tab.url().catch(() => "")) || opts.fallbackUrl || "";
  const documentResponse = [...responses].reverse().find((response) =>
    response.type === "Document"
      && (response.url === resolvedUrl || safeOrigin(response.url) === safeOrigin(resolvedUrl))
  );

  let html = "";
  let documentBodySource = "dom_fallback";
  if (cdp && documentResponse?.requestId) {
    try {
      const body = await cdp.send("Network.getResponseBody", {
        requestId: documentResponse.requestId,
      });
      if (typeof body?.body === "string" && !body.base64Encoded) {
        html = body.body;
        documentBodySource = "cdp_response";
      }
    } catch (error) {
      cdpError ||= String(error);
    }
  }
  if (!html) {
    for (let attempt = 0; attempt < 3 && !html; attempt += 1) {
      try {
        const domHtml = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
        html = typeof domHtml === "string" ? domHtml : "";
      } catch {
        try {
          await tab.playwright.waitForTimeout(250);
        } catch {
          break;
        }
      }
    }
  }

  const responseBodies = await captureMatchedResponseBodies(
    cdp,
    responses,
    opts.cdpProfile,
    opts,
  );
  const includeImageEvidence = opts.includeImageEvidence !== false;
  const [renderedProjection, inventoryResult] = includeImageEvidence
    ? await Promise.all([
      collectRenderedGalleryProjection(tab),
      pageAssetsInventory(tab, opts),
    ])
    : [[], { inventory: null, error: null }];
  const inventory = inventoryResult.inventory;
  const renderedImages = Array.isArray(renderedProjection) ? renderedProjection : [];
  const assetImages = inventory?.assets
    ?.filter((asset) => asset.kind === "image")
    .map((asset) => asset.url) || [];
  const responseCandidates = includeImageEvidence
    ? extractResponseImageCandidates(html, resolvedUrl)
    : [];
  const productImages = selectProductImagesFromEvidence({
    baseUrl: resolvedUrl,
    renderedImages,
    responseCandidates,
    assetImages,
  });
  const selectedKeys = new Set(productImages.flatMap((image) => [
    imageIdentityKey(image, resolvedUrl),
    imageBasenameKey(image),
  ]).filter(Boolean));
  const productAssetIds = inventory?.assets
    ?.filter((asset) => asset.kind === "image")
    .filter((asset) => {
      const identity = imageIdentityKey(asset.url, resolvedUrl);
      return selectedKeys.has(identity) || selectedKeys.has(imageBasenameKey(asset.url));
    })
    .map((asset) => asset.id) || [];

  return {
    url: resolvedUrl,
    html,
    htmlBytes: html.length,
    documentBodySource,
    productImages,
    capabilities: {
      cdp: Boolean(cdp),
      pageAssets: Boolean(inventory),
    },
    network: {
      eventCount: network.events.length,
      responseCount: responses.length,
      truncated: network.truncated,
      responses,
      responseBodies,
    },
    assets: inventory ? {
      inventoryId: inventory.id,
      summary: inventory.summary,
      imageCount: assetImages.length,
      productAssetIds,
    } : null,
    imageEvidence: {
      renderedCount: renderedImages.length,
      responseCandidateCount: responseCandidates.length,
      fullCandidateCount: responseCandidates.filter((candidate) => candidate.tier === 3).length,
      selectedCount: productImages.length,
    },
    errors: {
      ...(actionError ? { action: actionError } : {}),
      ...(cdpError ? { cdp: cdpError } : {}),
      ...(inventoryResult.error ? { pageAssets: inventoryResult.error } : {}),
    },
  };
}

export async function captureBrowserActionEvidence(tab, action, opts = {}) {
  return runWithHardTimeout(
    () => captureBrowserActionEvidenceInternal(tab, action, opts),
    {
      label: "capture_browser_action_evidence",
      timeoutMs: opts.evidenceTimeoutMs ?? opts.operationTimeoutMs ?? 20_000,
      discardTab: true,
    },
  );
}
