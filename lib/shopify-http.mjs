/**
 * Shopify HTTP catalog channel (references/harvest-architecture.md, §browser-avoidance).
 *
 * Roughly 60% of the recrawl list is Shopify, whose entire catalog — products,
 * variants, SKUs, prices, image URLs, descriptions — is available over plain
 * HTTP at /products.json. Those sites never need a browser, so IAB never gets
 * loaded for them. This module returns a hook set for runHarvest that sources
 * everything from that endpoint; the engine's downstream logic (evidence
 * packages, image download, variant expansion, scope, checkpoint, verify,
 * export) is reused unchanged — it cannot tell the data came from HTTP.
 */

import { htmlToText } from "./engine.mjs";

const DEFAULT_PAGE_SIZE = 250;   // Shopify hard max per page
const DEFAULT_MAX_PAGES = 40;    // 40 * 250 = 10k products safety ceiling
const PROBE_TIMEOUT_MS = 12_000;
export const SHOPIFY_HTTP_EVIDENCE_SOURCE = "shopify_http";

function origin(input) {
  try {
    const url = new URL(String(input).includes("://") ? input : `https://${input}`);
    return url.origin;
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; crawl-products)",
        accept: "application/json",
      },
    });
    if (!res.ok) return null;
    if (!/json/i.test(res.headers.get("content-type") || "")) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vendor concentration over a product sample. A brand's own store has one
 * dominant vendor (itself); a multi-brand retailer spreads across many
 * unrelated vendors with none dominating.
 */
export function vendorDiversity(products) {
  const counts = new Map();
  let withVendor = 0;
  for (const p of (Array.isArray(products) ? products : [])) {
    const v = String(p?.vendor || "").trim();
    if (!v) continue;
    withVendor += 1;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const topShare = withVendor > 0 ? Math.max(...[...counts.values()]) / withVendor : 1;
  return { distinct: counts.size, topShare, withVendor };
}

/**
 * A multi-brand retailer (out of scope: the third-party brands it resells are
 * not the site's own products). Requires BOTH many distinct vendors AND no
 * dominant one, so a large brand with a few sub-lines is not misflagged. Needs
 * a minimum sample to judge.
 */
export function isMultiBrandRetailer(products, opts = {}) {
  const d = vendorDiversity(products);
  const minSample = opts.minSample ?? 8;
  const minVendors = opts.minVendors ?? 6;
  const maxTopShare = opts.maxTopShare ?? 0.6;
  if (d.withVendor < minSample) return false;
  return d.distinct >= minVendors && d.topShare < maxTopShare;
}

/**
 * Confirm a site exposes the Shopify products endpoint. Returns { origin,
 * available, vendors, multiBrandRetailer } on success (positive signal only)
 * or null. Samples up to 250 products so the retailer check has enough vendor
 * data — the caller routes to the HTTP channel, excludes a retailer, or falls
 * back to the browser.
 */
export async function probeShopifyCatalog(input, opts = {}) {
  const base = origin(input);
  if (!base) return null;
  const body = await fetchJson(`${base}/products.json?limit=250`, opts.timeoutMs);
  if (!body || !Array.isArray(body.products)) return null;
  return {
    origin: base,
    available: true,
    sampleCount: body.products.length,
    vendors: vendorDiversity(body.products),
    multiBrandRetailer: isMultiBrandRetailer(body.products, opts),
  };
}

/**
 * Page through /products.json until exhausted. Returns the full product array
 * plus a `truncated` flag if the page ceiling was hit (so the run stays
 * incomplete rather than falsely claiming a complete catalog).
 */
export async function fetchAllShopifyProducts(input, opts = {}) {
  const base = origin(input);
  if (!base) throw new Error("shopify_http: invalid origin");
  const fetchImpl = opts.fetchJson || fetchJson;
  const pageSize = opts.pageSize || DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
  const products = [];
  let page = 1;
  let truncated = false;
  for (; page <= maxPages; page += 1) {
    const body = await fetchImpl(`${base}/products.json?limit=${pageSize}&page=${page}`, opts.timeoutMs);
    const batch = body && Array.isArray(body.products) ? body.products : [];
    if (batch.length === 0) break;
    products.push(...batch);
    if (batch.length < pageSize) break;
    if (page === maxPages) truncated = true;
  }
  return { origin: base, products, truncated };
}

function productDetailUrl(base, handle) {
  return `${base}/products/${handle}`;
}

/**
 * Map one Shopify product object to the engine's record shape. Variants stay
 * on the record so buildEvidencePackage's platform-variant path (and SKU/price
 * backfill) picks them up exactly as it does for the browser channel.
 */
export function shopifyProductToRecord(product, base) {
  const handle = String(product?.handle || "").trim();
  const url = productDetailUrl(base, handle);
  const images = (Array.isArray(product?.images) ? product.images : [])
    .map((img) => (typeof img === "string" ? img : img?.src))
    .filter(Boolean);
  const category = [product?.product_type, ...(Array.isArray(product?.tags) ? product.tags : [])]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return {
    sourceUrl: url,
    fields: {
      title: String(product?.title || "").trim(),
      description: htmlToText(product?.body_html || "").trim(),
      images,
      ...(category.length > 0 ? { category } : {}),
      // Marks this as HTTP-sourced: Supplement Facts / structured ingredients
      // live on the detail page, not in products.json, so the strict export
      // gate treats ingredients & visual-review as best-effort for these
      // records instead of blocking export (see SHOPIFY_HTTP_EVIDENCE_SOURCE).
      evidence_source: SHOPIFY_HTTP_EVIDENCE_SOURCE,
    },
    _meta: { evidenceSource: SHOPIFY_HTTP_EVIDENCE_SOURCE },
  };
}

/**
 * Build the hook set for runHarvest. Pass as opts.hooks. The catalog is
 * fetched once up front and cached; enumerate returns every detail URL,
 * extract maps cached products to records, and fetchProductData serves the
 * cached raw product so variant expansion needs zero extra requests.
 * fetchImage is left to the engine default (already plain HTTP).
 */
export async function createShopifyHarvestHooks(input, opts = {}) {
  const { origin: base, products, truncated } = await fetchAllShopifyProducts(input, opts);
  const byUrl = new Map();
  const rawByUrl = new Map();   // kept separate so records stay export-clean
  const urls = [];
  for (const product of products) {
    const record = shopifyProductToRecord(product, base);
    if (!record.sourceUrl || !record.fields.title) continue;
    byUrl.set(record.sourceUrl, record);
    rawByUrl.set(record.sourceUrl, product);
    urls.push(record.sourceUrl);
  }

  return {
    origin: base,
    productCount: urls.length,
    truncated,
    hooks: {
      enumerate: async () => ({
        productUrls: urls,
        coverage: {
          status: truncated ? "incomplete" : "complete",
          seedReports: [{
            seedUrl: `${base}/products.json`,
            status: truncated ? "incomplete" : "complete",
            endReason: truncated ? "shopify_page_ceiling_reached" : "shopify_products_json_exhausted",
          }],
        },
      }),
      extract: async (chunk) => ({
        records: chunk.map((url) => byUrl.get(url)).filter(Boolean),
        needsUpgrade: [],
        failed: [],
      }),
      fetchProductData: async (url) => rawByUrl.get(url) ?? null,
    },
  };
}
