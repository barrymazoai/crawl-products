import fs from "node:fs/promises";
import path from "node:path";

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
  return normalizeDomain(options.domain ?? mapped ?? observedDomain);
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

  const review =
    fields.factsIngredientReview
    ?? fields.facts_ingredient_review
    ?? record.factsIngredientReview
    ?? record.facts_ingredient_review
    ?? record?._meta?.factsIngredientReview;
  if (review?.status !== "visual_complete") {
    throw new Error(
      "confirmed Facts images require a visual_complete main ingredient review",
    );
  }
  if (review.result === "ingredients_read" && mainIngredients.length === 0) {
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
  return text;
}

export function toEnrichProductInput(record, options = {}) {
  if (!record || typeof record !== "object") {
    throw new TypeError("product record must be an object");
  }
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  const domain = resolveDomain(record, options);
  const productName = cleanText(fields.productName ?? fields.title ?? record.productName);
  if (!domain) throw new Error("domain is required and could not be derived from the product source");
  if (!productName) throw new Error("productName is required");

  const healthFunctions = uniqueStrings(
    fields.healthFunctions ?? fields.health_function ?? record.healthFunctions ?? record.health_function,
    { vocabularyCase: options.canonicalVocabularyCase !== false },
  );
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
  const processedAt = optionalTimestamp(
    options.processedAt ?? fields.processedAt ?? record.processedAt,
    "processedAt",
  );
  const error = cleanText(fields.error ?? record.error);
  const updateExisting =
    options.updateExisting
    ?? fields.updateExisting
    ?? record.updateExisting
    ?? false;
  if (typeof updateExisting !== "boolean") {
    throw new Error("updateExisting must be a boolean");
  }

  const input = {
    domain,
    productName,
    images: normalizeImages(record, fields),
    healthFunctions,
    mainIngredients,
    updateExisting,
    ...(productForm ? { productForm } : {}),
    ...(processedAt ? { processedAt } : {}),
    ...(error ? { error } : {}),
  };

  if (options.includeNonPersistedFields === true) {
    const price = cleanText(fields.price ?? fields.retail_price ?? record.price ?? record.retail_price);
    const supplementFactsOCR =
      fields.supplementFactsOCR
      ?? fields.supplement_facts_ocr
      ?? record.supplementFactsOCR
      ?? record.supplement_facts_ocr;
    if (price) input.price = price;
    if (supplementFactsOCR != null) input.supplementFactsOCR = supplementFactsOCR;
  }
  return input;
}

export function toEnrichProductEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("enrich product input must be an object");
  }
  return { json: input };
}

export function buildEnrichProductExport(records, options = {}) {
  const inputs = [];
  const requests = [];
  const errors = [];
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    try {
      const input = toEnrichProductInput(record, options);
      inputs.push(input);
      requests.push(toEnrichProductEnvelope(input));
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
  return {
    inputs,
    requests,
    errors,
    summary: {
      recordsReceived: Array.isArray(records) ? records.length : 0,
      inputsReady: inputs.length,
      errors: errors.length,
    },
  };
}

function csvCell(value) {
  const text = value == null
    ? ""
    : Array.isArray(value)
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function inputsToCsv(inputs) {
  const headers = [
    "domain",
    "productName",
    "images",
    "healthFunctions",
    "mainIngredients",
    "productForm",
    "updateExisting",
    "price",
    "processedAt",
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

export async function writeEnrichProductExport(outDir, records, options = {}) {
  const output = buildEnrichProductExport(records, options);
  await fs.mkdir(outDir, { recursive: true });
  const files = {
    products: path.join(outDir, "products.json"),
    requests: path.join(outDir, "product-enrich-requests.jsonl"),
    rawRecords: path.join(outDir, "crawl-records.json"),
    csv: path.join(outDir, "products.csv"),
    errors: path.join(outDir, "product-enrich-errors.json"),
    report: path.join(outDir, "enrich-export-report.json"),
  };
  await Promise.all([
    writeAtomic(files.products, `${JSON.stringify(output.inputs, null, 2)}\n`),
    writeAtomic(
      files.requests,
      output.requests.map((request) => JSON.stringify(request)).join("\n")
        + (output.requests.length > 0 ? "\n" : ""),
    ),
    writeAtomic(files.rawRecords, `${JSON.stringify(records, null, 2)}\n`),
    writeAtomic(files.csv, inputsToCsv(output.inputs)),
    writeAtomic(files.errors, `${JSON.stringify(output.errors, null, 2)}\n`),
    writeAtomic(files.report, `${JSON.stringify(output.summary, null, 2)}\n`),
  ]);
  return { ...output, files };
}
