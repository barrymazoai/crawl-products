import fs from "node:fs/promises";
import path from "node:path";

import { registrableDomain } from "./engine.mjs";
import {
  buildSemanticEvidenceBrief,
  semanticCompletion,
  semanticEvidenceGaps,
} from "./product-semantics.mjs";
import { normalizeHealthFunctions } from "./health-function-vocab.mjs";
import {
  normalizeVariantOptions,
  variantDisplayName,
  variantQualifiedProductName,
} from "./product-variants.mjs";

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values, { vocabularyCase = false } = {}) {
  const result = [];
  const seen = new Set();
  for (const rawValue of Array.isArray(values) ? values : []) {
    const value = cleanText(
      typeof rawValue === "string"
        ? rawValue
        : rawValue?.value ?? rawValue?.name,
    );
    if (!value) continue;
    const normalized = vocabularyCase ? canonicalVocabularyName(value) : value;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function canonicalVocabularyName(value) {
  const text = cleanText(value);
  if (!text || text !== text.toLocaleLowerCase()) return text;
  return text.replace(/(^|[\s/-])(\p{L})/gu, (_, prefix, letter) =>
    `${prefix}${letter.toLocaleUpperCase()}`);
}

const INGREDIENT_CATEGORY_NAMES = new Map([
  ["vitamins", "vitamins"],
  ["minerals", "minerals"],
  ["amino_acids_peptides", "amino_acids_peptides"],
  ["amino acids & peptides", "amino_acids_peptides"],
  ["herbs_botanicals", "herbs_botanicals"],
  ["herbs & botanicals", "herbs_botanicals"],
  ["mushrooms", "mushrooms"],
  ["fatty_acids_lipids", "fatty_acids_lipids"],
  ["fatty acids & lipids", "fatty_acids_lipids"],
  ["probiotics_prebiotics", "probiotics_prebiotics"],
  ["probiotics & prebiotics", "probiotics_prebiotics"],
  ["enzymes", "enzymes"],
  ["antioxidants_polyphenols", "antioxidants_polyphenols"],
  ["antioxidants & polyphenols", "antioxidants_polyphenols"],
  ["hormones_precursors", "hormones_precursors"],
  ["hormones & precursors", "hormones_precursors"],
  ["fibers_carbs", "fibers_carbs"],
  ["fibers & carbs", "fibers_carbs"],
  ["proprietary_blends_other", "proprietary_blends_other"],
  ["proprietary blends & other", "proprietary_blends_other"],
]);

function normalizeIngredientCategory(value, fieldName) {
  const text = cleanText(value);
  if (!text) return "";
  const category = INGREDIENT_CATEGORY_NAMES.get(text.toLocaleLowerCase());
  if (!category) throw new Error(`${fieldName} has an unsupported ingredient category`);
  return category;
}

function normalizeMainIngredients(values, { vocabularyCase = true } = {}) {
  const byName = new Map();
  for (const [index, rawValue] of (Array.isArray(values) ? values : []).entries()) {
    const raw = typeof rawValue === "string" ? { name: rawValue } : rawValue;
    const nameText = cleanText(raw?.name ?? raw?.value);
    if (!nameText) continue;
    const name = vocabularyCase ? canonicalVocabularyName(nameText) : nameText;
    const taxonomy = raw?.taxonomy && typeof raw.taxonomy === "object"
      ? raw.taxonomy
      : raw;
    const substanceText = cleanText(taxonomy?.substance);
    const formText = cleanText(taxonomy?.form);
    const category = normalizeIngredientCategory(
      taxonomy?.category,
      `mainIngredients[${index}]`,
    );
    if (!substanceText && (formText || category)) {
      throw new Error(`mainIngredients[${index}] form/category requires substance`);
    }
    const substance = vocabularyCase
      ? canonicalVocabularyName(substanceText)
      : substanceText;
    const form = vocabularyCase ? canonicalVocabularyName(formText) : formText;
    const item = substance
      ? {
          name,
          substance,
          ...(form ? { form } : {}),
          ...(category ? { category } : {}),
        }
      : name;
    const key = name.toLocaleLowerCase();
    const current = byName.get(key);
    if (
      current == null
      || (typeof current === "string" && typeof item === "object")
      || (
        typeof current === "object"
        && typeof item === "object"
        && Object.keys(item).length > Object.keys(current).length
      )
    ) {
      byName.set(key, item);
    }
  }
  return [...byName.values()];
}

function normalizeDomain(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeProductUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (/^inline-product=/i.test(url.hash.slice(1))) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function resolveProductUrl(record, fields) {
  const candidates = [
    fields.productUrl,
    fields.product_url,
    fields.url,
    record.productUrl,
    record.product_url,
    record.sourceUrl,
    record.url,
  ];
  for (const candidate of candidates) {
    const productUrl = normalizeProductUrl(candidate);
    if (productUrl) return productUrl;
  }
  return "";
}

function sourceDomain(record) {
  const titleSources = record?._meta?.fieldSources?.title;
  const candidates = [
    record?.domain,
    record?._meta?.companyDomain,
    ...(Array.isArray(titleSources)
      ? titleSources.flatMap((item) => [item?.sourceOrigin, item?.sourceUrl])
      : []),
    record?.sourceUrl,
    record?.fields?.product_url,
    record?.product_url,
    record?.url,
  ];
  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate);
    if (domain) return domain;
  }
  return "";
}

function resolveDomain(record, options = {}) {
  const observedDomain = sourceDomain(record);
  const mapped = options.domainByOrigin?.[observedDomain]
    ?? options.domainByOrigin?.[`https://${observedDomain}`];
  const explicit = normalizeDomain(options.domain ?? mapped);
  if (explicit) return explicit;
  return registrableDomain(observedDomain);
}

function normalizeImages(record, fields) {
  const imageValues = [
    ...(Array.isArray(fields.images) ? fields.images : []),
    ...(Array.isArray(record.images) ? record.images : []),
  ];
  const factsValues = [
    ...(Array.isArray(fields.facts_images) ? fields.facts_images : []),
    ...(Array.isArray(record.facts_images) ? record.facts_images : []),
  ];
  for (const item of factsValues) {
    imageValues.push(
      typeof item === "string"
        ? item
        : item?.image_url ?? item?.imageUrl ?? item?.url,
    );
  }
  return uniqueStrings(imageValues.map((item) =>
    typeof item === "string" ? item : item?.url ?? item?.image_url));
}

function assertFactsIngredientReview(record, fields, mainIngredients, options) {
  if (options.requireFactsIngredientReview === false) return;
  const factsImages = [
    ...(Array.isArray(fields.facts_images) ? fields.facts_images : []),
    ...(fields !== record && Array.isArray(record.facts_images) ? record.facts_images : []),
  ].filter((item) =>
    cleanText(typeof item === "string" ? item : item?.image_url ?? item?.imageUrl ?? item?.url));
  if (factsImages.length === 0) return;

  const singularReview = fields.factsIngredientReview
    ?? fields.facts_ingredient_review
    ?? record.factsIngredientReview
    ?? record.facts_ingredient_review
    ?? record?._meta?.factsIngredientReview;
  const reviews = [
    ...(Array.isArray(fields.factsIngredientReviews) ? fields.factsIngredientReviews : []),
    ...(Array.isArray(fields.facts_ingredient_reviews) ? fields.facts_ingredient_reviews : []),
    ...(Array.isArray(record.factsIngredientReviews) ? record.factsIngredientReviews : []),
    ...(Array.isArray(record.facts_ingredient_reviews) ? record.facts_ingredient_reviews : []),
    ...(Array.isArray(record?._meta?.factsIngredientReviews)
      ? record._meta.factsIngredientReviews
      : []),
    ...(singularReview ? [singularReview] : []),
  ];
  const reviewByUrl = new Map(reviews.map((review) => [
    cleanText(review?.image_url ?? review?.imageUrl).toLocaleLowerCase(),
    review,
  ]).filter(([url]) => url));
  const unreviewed = factsImages.filter((item) => {
    const url = cleanText(
      typeof item === "string" ? item : item?.image_url ?? item?.imageUrl ?? item?.url,
    ).toLocaleLowerCase();
    const review = reviewByUrl.get(url);
    return review?.status !== "visual_complete"
      || !["ingredients_read", "no_main_ingredients_visible"].includes(review?.result);
  });
  if (unreviewed.length > 0) {
    throw new Error(
      "every confirmed Facts image requires a visual_complete main ingredient review",
    );
  }
  if (reviews.some((review) => review.result === "ingredients_read")
      && mainIngredients.length === 0) {
    throw new Error(
      "Facts ingredient review says ingredients_read but mainIngredients is empty",
    );
  }
}

function optionalTimestamp(value, fieldName) {
  const text = cleanText(value);
  if (!text) return null;
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return new Date(text).toISOString();
}

function recordVariants(record, fields) {
  const variants = Array.isArray(record.variants)
    ? record.variants
    : Array.isArray(fields.variants)
      ? fields.variants
      : [];
  return variants.filter((v) => v && typeof v === "object");
}

/** Health functions aligned to the controlled vocabulary. The Supply Smart
 *  enrich contract accepts names, not the crawler's internal {id,name} rows. */
function resolveHealthFunctions(record, fields) {
  const raw = fields.healthFunctions ?? fields.health_function
    ?? record.healthFunctions ?? record.health_function;
  const { matched, unmatched } = normalizeHealthFunctions(raw);
  return {
    healthFunctions: matched.map((item) => item.name),
    unmatchedHealthFunctions: unmatched,
  };
}

function resolveChannel(record, fields, options) {
  const channel = cleanText(
    options.channel ?? fields.channel ?? record.channel ?? "dtc",
  ).toLocaleLowerCase();
  if (!channel || ["database", "unknown"].includes(channel)) {
    throw new Error("channel must be a real sales channel");
  }
  return channel;
}

function resolveCrawlScope(record, fields, options) {
  const explicit = cleanText(
    options.crawlScope ?? fields.crawlScope ?? fields.crawl_scope
      ?? record.crawlScope ?? record.crawl_scope,
  );
  const capped = options.productLimit?.accepted === true
    || options.runCompletion?.productLimit?.accepted === true;
  if (capped && explicit === "full") {
    throw new Error("crawlScope full conflicts with an accepted product limit");
  }
  const scope = explicit
    || (options.runCompletion?.status === "complete" && !capped ? "full" : "partial");
  if (!["full", "partial"].includes(scope)) {
    throw new Error("crawlScope must be full or partial");
  }
  return scope;
}

function variantOptionObject(value) {
  return Object.fromEntries(normalizeVariantOptions(value).map((option) => [
    option.name || "Option",
    option.value || option.name,
  ]));
}

function optionDisplayName(options) {
  const label = Object.entries(options)
    .map(([name, value]) => name && value ? `${name}: ${value}` : value || name)
    .filter(Boolean)
    .join(" / ");
  return /^default(?: title)?$/i.test(label) || /^title: default title$/i.test(label)
    ? ""
    : label;
}

function optionPack(options, explicitPack) {
  const direct = cleanText(explicitPack);
  if (direct) return direct;
  const match = Object.entries(options).find(([name]) =>
    /(?:size|count|quantity|quantit[eé]|pack|unit|servings?|weight|volume)/i.test(name));
  return cleanText(match?.[1]);
}

function buildVariantAttrs({ label, options, sku, pack }) {
  const attrs = {
    ...(cleanText(label) ? { label: cleanText(label) } : {}),
    ...(optionPack(options, pack) ? { pack: optionPack(options, pack) } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(cleanText(sku) ? { sku: cleanText(sku) } : {}),
  };
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function currentVariantData(record, fields) {
  const metaVariant = record?._meta?.variant && typeof record._meta.variant === "object"
    ? record._meta.variant
    : {};
  const options = variantOptionObject(
    metaVariant.optionSelections ?? metaVariant.options
      ?? fields.variant_options ?? fields.variantOptions,
  );
  const label = cleanText(
    variantDisplayName(record) || optionDisplayName(options),
  );
  const sku = cleanText(
    metaVariant.sku ?? fields.variant_sku ?? fields.sku ?? record.sku,
  );
  const variantId = cleanText(
    metaVariant.variantId ?? metaVariant.id
      ?? fields.variant_id ?? fields.variantId ?? record.variantId,
  );
  return {
    label,
    options,
    sku,
    variantId,
    attrs: buildVariantAttrs({ label, options, sku, pack: metaVariant.pack }),
  };
}

function qualifyProductName(title, label) {
  if (!title || !label || title.toLocaleLowerCase().includes(label.toLocaleLowerCase())) {
    return title;
  }
  return `${title} — ${label}`.slice(0, 360);
}

function optionalNumber(record, fields, names, predicate = () => true) {
  for (const name of names) {
    const value = fields[name] ?? record[name];
    if (value == null || value === "") continue;
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number) && predicate(number)) return number;
  }
  return undefined;
}

/** Expand one crawl record into one Supply Smart enrich input per sellable
 *  variant. Variant identity lives in channel/externalId/sourceUrl and its raw
 *  attributes live in variantAttrs; unsupported legacy top-level keys are not
 *  emitted. A variant-qualified productName keeps first-time sibling variants
 *  from collapsing through the API's name+company fallback matcher. */
export function toEnrichProductInputs(record, options = {}) {
  const base = toEnrichProductInput(record, options);
  const fields = record.fields && typeof record.fields === "object" ? record.fields : record;
  const variants = recordVariants(record, fields);

  if (variants.length === 0) return [base];

  return variants.map((variant) => {
    const sku = cleanText(variant.sku);
    const externalId = cleanText(variant.variantId ?? variant.id) || sku;
    const price = cleanText(variant.price) || base.price;
    const variantUrl = normalizeProductUrl(variant.url) || base.productUrl;
    const variantImage = cleanText(variant.imageUrl);
    const images = variantImage
      ? [variantImage, ...base.images.filter((image) => image !== variantImage)]
      : base.images;
    const variantOptions = variantOptionObject(
      variant.options ?? variant.optionSelections,
    );
    const label = cleanText(
      variant.displayName ?? variant.name ?? optionDisplayName(variantOptions),
    );
    const variantAttrs = buildVariantAttrs({
      label,
      options: variantOptions,
      sku,
      pack: variant.pack,
    });
    const {
      externalId: _baseExternalId,
      variantAttrs: _baseVariantAttrs,
      ...shared
    } = base;
    return {
      ...shared,
      productName: qualifyProductName(base.titleRaw || base.productName, label),
      ...(variantUrl ? { productUrl: variantUrl, sourceUrl: variantUrl } : {}),
      ...(externalId ? { externalId } : {}),
      ...(price ? { price } : {}),
      ...(variantAttrs ? { variantAttrs } : {}),
      images,
    };
  });
}

export function toEnrichProductInput(record, options = {}) {
  if (!record || typeof record !== "object") {
    throw new TypeError("product record must be an object");
  }
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  const domain = resolveDomain(record, options);
  const titleRaw = cleanText(fields.productName ?? fields.title ?? record.productName);
  const productName = variantQualifiedProductName(record) || titleRaw;
  const productUrl = resolveProductUrl(record, fields);
  if (!domain) throw new Error("domain is required and could not be derived from the product source");
  if (!productName) throw new Error("productName is required");

  const { healthFunctions, unmatchedHealthFunctions } = resolveHealthFunctions(record, fields);
  const mainIngredients = normalizeMainIngredients(
    fields.mainIngredients ?? fields.main_ingredients
      ?? record.mainIngredients ?? record.main_ingredients,
    { vocabularyCase: options.canonicalVocabularyCase !== false },
  );
  assertFactsIngredientReview(record, fields, mainIngredients, options);
  const productForm = uniqueStrings([
    fields.productForm ?? fields.form ?? record.productForm ?? record.form,
  ], {
    vocabularyCase: options.canonicalVocabularyCase !== false,
  })[0] ?? "";
  const capturedAt = optionalTimestamp(
    options.capturedAt ?? fields.capturedAt ?? fields.captured_at
      ?? record.capturedAt ?? record.captured_at
      ?? options.processedAt ?? fields.processedAt ?? record.processedAt
      ?? new Date().toISOString(),
    "capturedAt",
  );
  const channel = resolveChannel(record, fields, options);
  const crawlScope = resolveCrawlScope(record, fields, options);
  const source = cleanText(options.source ?? fields.source ?? record.source ?? "crawl-products");
  if (!source) throw new Error("source is required");
  const currentVariant = currentVariantData(record, fields);
  const explicitExternalId = cleanText(
    options.externalId ?? fields.externalId ?? fields.external_id
      ?? record.externalId ?? record.external_id,
  );
  const externalId = explicitExternalId || currentVariant.variantId || currentVariant.sku;
  const error = cleanText(fields.error ?? record.error);
  const updateExisting =
    options.updateExisting
    ?? fields.updateExisting
    ?? record.updateExisting
    ?? false;
  if (typeof updateExisting !== "boolean") {
    throw new Error("updateExisting must be a boolean");
  }

  const price = resolvePrice(record, fields);
  const currency = cleanText(fields.currency ?? record.currency);
  const listPrice = cleanText(
    fields.listPrice ?? fields.list_price ?? fields.compare_at_price
      ?? record.listPrice ?? record.list_price,
  );
  const rating = optionalNumber(record, fields, ["rating"], (value) => value >= 0 && value <= 5);
  const reviewCount = optionalNumber(
    record, fields, ["reviewCount", "review_count"], Number.isInteger,
  );
  const salesRank = optionalNumber(
    record, fields, ["salesRank", "sales_rank"], (value) => Number.isInteger(value) && value > 0,
  );
  const inStockValue = fields.inStock ?? fields.in_stock ?? record.inStock ?? record.in_stock;
  const inStock = typeof inStockValue === "boolean" ? inStockValue : undefined;
  const unitsSold = optionalNumber(
    record, fields, ["unitsSold", "units_sold"], (value) => Number.isInteger(value) && value >= 0,
  );
  const unitsSoldPeriodValue = cleanText(
    fields.unitsSoldPeriod ?? fields.units_sold_period
      ?? record.unitsSoldPeriod ?? record.units_sold_period,
  );
  const unitsSoldPeriod = ["trailing_30d", "monthly", "lifetime", "unknown"]
    .includes(unitsSoldPeriodValue)
    ? unitsSoldPeriodValue
    : undefined;

  const input = {
    domain,
    productName,
    ...(productUrl ? { productUrl } : {}),
    channel,
    ...(externalId ? { externalId } : {}),
    ...(productUrl ? { sourceUrl: productUrl } : {}),
    capturedAt,
    crawlScope,
    source,
    ...(price ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(listPrice ? { listPrice } : {}),
    ...(rating != null ? { rating } : {}),
    ...(reviewCount != null && reviewCount >= 0 ? { reviewCount } : {}),
    ...(salesRank != null ? { salesRank } : {}),
    ...(inStock != null ? { inStock } : {}),
    ...(unitsSold != null && unitsSoldPeriod ? { unitsSold, unitsSoldPeriod } : {}),
    images: normalizeImages(record, fields),
    healthFunctions,
    mainIngredients,
    updateExisting,
    ...(productForm ? { productForm } : {}),
    ...(currentVariant.attrs ? { variantAttrs: currentVariant.attrs } : {}),
    ...(titleRaw ? { titleRaw } : {}),
    ...(error ? { error } : {}),
  };
  if (unmatchedHealthFunctions.length > 0) {
    // Not sent to the API; carried so the export builder can flag the record
    // for review and record which phrases fell outside the vocabulary.
    Object.defineProperty(input, "_unmatchedHealthFunctions", {
      value: unmatchedHealthFunctions, enumerable: false,
    });
  }

  if (options.includeNonPersistedFields === true) {
    const supplementFactsOCR =
      fields.supplementFactsOCR
      ?? fields.supplement_facts_ocr
      ?? record.supplementFactsOCR
      ?? record.supplement_facts_ocr;
    if (supplementFactsOCR != null) input.supplementFactsOCR = supplementFactsOCR;
  }
  return input;
}

/**
 * Price is a required output field. Prefer the page-level display price
 * (keeps the shown currency/format), then fall back to the default sellable
 * variant's price captured by the platform probe. The raw string is kept
 * as-is (multi-currency, multi-locale) — the enrich endpoint normalizes it.
 */
function resolvePrice(record, fields) {
  const direct = cleanText(
    fields.price ?? fields.retail_price ?? record.price ?? record.retail_price,
  );
  if (direct) return direct;
  const variants = Array.isArray(record.variants)
    ? record.variants
    : Array.isArray(fields.variants)
      ? fields.variants
      : [];
  const preferred = variants.find((v) => v && v.available !== false) ?? variants[0];
  return preferred ? cleanText(preferred.price) : "";
}

function galleryReview(record, fields) {
  return fields.galleryReview
    ?? fields.gallery_review
    ?? record.galleryReview
    ?? record.gallery_review
    ?? record?._meta?.galleryReview
    ?? null;
}

const OUTPUT_MODES = new Set(["api_ready", "inventory_partial"]);

function outputMode(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "allowPartial")) {
    throw new Error("allowPartial_removed_use_outputMode_inventory_partial");
  }
  const mode = options.outputMode ?? "api_ready";
  if (!OUTPUT_MODES.has(mode)) {
    throw new Error(`invalid_output_mode:${mode}`);
  }
  return mode;
}

function isHttpSourcedRecord(record, fields) {
  return (record?._meta?.evidenceSource ?? fields?.evidence_source ?? record?.evidenceSource)
    === "shopify_http";
}

function assertApiReadyInput(input, record, options = {}) {
  if (outputMode(options) === "inventory_partial") return;
  const fields = record.fields && typeof record.fields === "object" ? record.fields : record;
  // HTTP-sourced (Shopify products.json) records have no detail-page DOM or
  // Supplement Facts, so ingredients & visual review are best-effort: present
  // ones must still be well-formed, but their absence never blocks export.
  const httpSourced = isHttpSourcedRecord(record, fields);
  const missing = [];
  if (!input.productUrl) missing.push("productUrl");
  if (!input.channel) missing.push("channel");
  if (!input.sourceUrl) missing.push("sourceUrl");
  if (!input.capturedAt) missing.push("capturedAt");
  if (!input.crawlScope) missing.push("crawlScope");
  if (!input.source) missing.push("source");
  if (!input.price && options.requirePrice !== false) missing.push("price");
  if (input.images.length === 0) missing.push("images");
  if (!input.productForm) missing.push("productForm");
  if (input.healthFunctions.length === 0) missing.push("healthFunctions");
  if (input.mainIngredients.length === 0 && !httpSourced) missing.push("mainIngredients");
  if (options.requireIngredientTaxonomy !== false && input.mainIngredients.length > 0) {
    const unclassified = input.mainIngredients.filter((ingredient) =>
      typeof ingredient !== "object"
      || !cleanText(ingredient?.name)
      || !cleanText(ingredient?.substance)
      || !cleanText(ingredient?.category));
    if (unclassified.length > 0) missing.push("mainIngredientTaxonomy");
  }
  const semanticGaps = semanticEvidenceGaps(record, options);
  const blockingSemantic = httpSourced
    ? ["form_evidence", "health_function_evidence"]        // ingredients optional here
    : ["form_evidence", "health_function_evidence", "main_ingredient_evidence"];
  if (semanticGaps.some((gap) => blockingSemantic.includes(gap))) {
    missing.push("semanticEvidence");
  }
  if (!httpSourced) {
    if (semanticGaps.includes("facts_source_review")) missing.push("factsSourceReview");
    if (semanticGaps.includes("facts_ingredient_review")) missing.push("factsIngredientReview");
  }

  if (options.requireGalleryReview !== false && !httpSourced) {
    const review = galleryReview(record, fields);
    const reviewedImageUrls = new Set(
      (review?.reviewed_image_urls ?? review?.reviewedImageUrls ?? [])
        .map((value) => cleanText(value))
        .filter(Boolean),
    );
    const allImagesReviewed = input.images.every((image) => reviewedImageUrls.has(image));
    if (review?.status !== "visual_complete" || !allImagesReviewed) {
      missing.push("galleryReview");
    }
  }
  if (missing.length > 0) {
    throw new Error(`api_ready_fields_missing:${missing.join(",")}`);
  }
}

export function toEnrichProductEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("enrich product input must be an object");
  }
  return { json: input };
}

export function buildEnrichProductExport(records, options = {}) {
  const mode = outputMode(options);
  const effectiveOptions = {
    ...options,
    capturedAt: options.capturedAt ?? options.processedAt ?? new Date().toISOString(),
  };
  const inputs = [];
  const requests = [];
  const errors = [];
  const reviewQueue = [];
  const semanticReadyIndexes = new Set();
  let recordsMapped = 0;
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    try {
      // Resolve one shared capture timestamp per export call, then expand one
      // record to one input per sellable variant/listing.
      const variantInputs = toEnrichProductInputs(record, effectiveOptions);
      const representative = variantInputs[0];
      const semanticReview = semanticCompletion(record, options);
      const reviewMissing = [...semanticReview.missing];
      if (!representative.productUrl) reviewMissing.push("productUrl");
      if (representative.images.length === 0) reviewMissing.push("images");
      if (representative._unmatchedHealthFunctions?.length > 0
          && representative.healthFunctions.length === 0) {
        reviewMissing.push("healthFunctionVocabulary");
      }
      const uniqueReviewMissing = [...new Set(reviewMissing)];
      if (uniqueReviewMissing.length === 0) {
        semanticReadyIndexes.add(index);
      } else {
        const evidenceBrief = buildSemanticEvidenceBrief(record);
        reviewQueue.push({
          index,
          productName: cleanText(record?.fields?.productName
            ?? record?.fields?.title
            ?? record?.productName
            ?? record?.title) || null,
          sourceUrl: cleanText(record?.sourceUrl
            ?? record?.fields?.productUrl
            ?? record?.fields?.product_url
            ?? record?.fields?.url
            ?? record?.url) || null,
          status: "needs_model_review",
          missing: uniqueReviewMissing,
          reasons: uniqueReviewMissing.map((gap) =>
            ["productUrl", "images"].includes(gap)
              ? `required:${gap}`
              : `semantic:${gap}`),
          evidenceGaps: evidenceBrief.sourceGaps,
          nextActions: evidenceBrief.nextActions,
        });
      }
      // Every variant row must pass the strict gate on its own.
      for (const input of variantInputs) {
        assertApiReadyInput(input, record, options);
      }
      for (const input of variantInputs) {
        inputs.push(input);
        requests.push(toEnrichProductEnvelope(input));
      }
      recordsMapped += 1;
    } catch (error) {
      const fields = record?.fields ?? record ?? {};
      errors.push({
        index,
        productName: cleanText(fields.productName ?? fields.title) || null,
        sourceUrl: cleanText(record?.sourceUrl ?? fields.product_url ?? record?.product_url) || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const semanticCoverage = {
    form: inputs.filter((input) => Boolean(input.productForm)).length,
    healthFunctions: inputs.filter((input) => input.healthFunctions.length > 0).length,
    mainIngredients: inputs.filter((input) => input.mainIngredients.length > 0).length,
  };
  return {
    inputs,
    requests,
    errors,
    reviewQueue,
    summary: {
      outputMode: mode,
      completionStatus: mode === "api_ready"
          && inputs.length > 0
          && errors.length === 0
        ? "complete"
          : "incomplete",
      recordsReceived: Array.isArray(records) ? records.length : 0,
      recordsMapped,
      inputsReady: mode === "inventory_partial"
        ? [...semanticReadyIndexes].filter((index) =>
          (Array.isArray(records) ? records[index] : null) != null).length
        : inputs.length,
      errors: errors.length,
      reviewQueue: reviewQueue.length,
      semanticCoverage,
    },
  };
}

function csvCell(value) {
  const text = value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function inputsToCsv(inputs) {
  const headers = [
    "domain",
    "productName",
    "productUrl",
    "channel",
    "externalId",
    "sourceUrl",
    "capturedAt",
    "crawlScope",
    "source",
    "price",
    "currency",
    "listPrice",
    "rating",
    "reviewCount",
    "salesRank",
    "inStock",
    "unitsSold",
    "unitsSoldPeriod",
    "images",
    "healthFunctions",
    "mainIngredients",
    "productForm",
    "variantAttrs",
    "titleRaw",
    "updateExisting",
    "error",
  ];
  const rows = inputs.map((input) => headers.map((header) => input[header]));
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
}

async function writeAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

async function removeFormalArtifacts(outDir) {
  const names = [
    "products.json",
    "product-enrich-inputs.json",
    "product-enrich-requests.json",
    "product-enrich-requests.jsonl",
    "products.csv",
  ];
  await Promise.all(names.map((name) =>
    fs.rm(path.join(outDir, name), { force: true })
  ));
}

async function removeModeArtifacts(outDir, names) {
  await Promise.all(names.map((name) =>
    fs.rm(path.join(outDir, name), { force: true })
  ));
}

export async function writeEnrichProductExport(outDir, records, options = {}) {
  const output = buildEnrichProductExport(records, options);
  await fs.mkdir(outDir, { recursive: true });
  if (output.summary.outputMode === "inventory_partial") {
    await removeFormalArtifacts(outDir);
    await removeModeArtifacts(outDir, ["api-ready-candidates.json"]);
    const files = {
      inventory: path.join(outDir, "inventory-partial.json"),
      rawRecords: path.join(outDir, "crawl-records.json"),
      errors: path.join(outDir, "inventory-partial-errors.json"),
      semanticReviewQueue: path.join(outDir, "semantic-review-queue.json"),
      report: path.join(outDir, "inventory-partial-report.json"),
    };
    await Promise.all([
      writeAtomic(files.inventory, `${JSON.stringify(output.inputs, null, 2)}\n`),
      writeAtomic(files.rawRecords, `${JSON.stringify(records, null, 2)}\n`),
      writeAtomic(files.errors, `${JSON.stringify(output.errors, null, 2)}\n`),
      writeAtomic(files.semanticReviewQueue, `${JSON.stringify(output.reviewQueue, null, 2)}\n`),
      writeAtomic(files.report, `${JSON.stringify(output.summary, null, 2)}\n`),
    ]);
    return { ...output, files };
  }
  const runCompletionStatus = options.runCompletion?.status ?? "missing";
  const formalArtifactsReady = output.summary.completionStatus === "complete"
    && runCompletionStatus === "complete";
  if (!formalArtifactsReady) {
    await removeFormalArtifacts(outDir);
    await removeModeArtifacts(outDir, [
      "inventory-partial.json",
      "inventory-partial-errors.json",
      "inventory-partial-report.json",
    ]);
    const summary = {
      ...output.summary,
      completionStatus: "incomplete",
      runCompletionStatus,
      formalArtifactsWritten: false,
      blockingReasons: [
        ...(runCompletionStatus === "complete" ? [] : ["run_completion_not_proven"]),
        ...(output.errors.length === 0 ? [] : ["record_validation_errors"]),
        ...(output.inputs.length > 0 ? [] : ["no_api_ready_records"]),
      ],
    };
    const files = {
      candidates: path.join(outDir, "api-ready-candidates.json"),
      rawRecords: path.join(outDir, "crawl-records.json"),
      errors: path.join(outDir, "product-enrich-errors.json"),
      semanticReviewQueue: path.join(outDir, "semantic-review-queue.json"),
      report: path.join(outDir, "enrich-export-report.json"),
    };
    await Promise.all([
      writeAtomic(files.candidates, `${JSON.stringify(output.requests, null, 2)}\n`),
      writeAtomic(files.rawRecords, `${JSON.stringify(records, null, 2)}\n`),
      writeAtomic(files.errors, `${JSON.stringify(output.errors, null, 2)}\n`),
      writeAtomic(files.semanticReviewQueue, `${JSON.stringify(output.reviewQueue, null, 2)}\n`),
      writeAtomic(files.report, `${JSON.stringify(summary, null, 2)}\n`),
    ]);
    return { ...output, summary, files };
  }
  await removeModeArtifacts(outDir, [
    "api-ready-candidates.json",
    "semantic-review-queue.json",
    "inventory-partial.json",
    "inventory-partial-errors.json",
    "inventory-partial-report.json",
  ]);
  const files = {
    products: path.join(outDir, "products.json"),
    inputs: path.join(outDir, "product-enrich-inputs.json"),
    requests: path.join(outDir, "product-enrich-requests.json"),
    requestsJsonl: path.join(outDir, "product-enrich-requests.jsonl"),
    rawRecords: path.join(outDir, "crawl-records.json"),
    csv: path.join(outDir, "products.csv"),
    errors: path.join(outDir, "product-enrich-errors.json"),
    report: path.join(outDir, "enrich-export-report.json"),
  };
  const summary = {
    ...output.summary,
    runCompletionStatus,
    formalArtifactsWritten: true,
  };
  await Promise.all([
    writeAtomic(files.products, `${JSON.stringify(output.requests, null, 2)}\n`),
    writeAtomic(files.inputs, `${JSON.stringify(output.inputs, null, 2)}\n`),
    writeAtomic(files.requests, `${JSON.stringify(output.requests, null, 2)}\n`),
    writeAtomic(
      files.requestsJsonl,
      output.requests.map((request) => JSON.stringify(request)).join("\n")
        + (output.requests.length > 0 ? "\n" : ""),
    ),
    writeAtomic(files.rawRecords, `${JSON.stringify(records, null, 2)}\n`),
    writeAtomic(files.csv, inputsToCsv(output.inputs)),
    writeAtomic(files.errors, `${JSON.stringify(output.errors, null, 2)}\n`),
    writeAtomic(files.report, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  return { ...output, summary, files };
}
