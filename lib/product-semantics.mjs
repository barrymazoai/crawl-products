const FACTS_TYPES = new Set([
  "Supplement Facts",
  "Nutrition Facts",
  "Drug Facts",
  "Product Facts",
]);

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

const EXPLICIT_FACTS_PATTERNS = [
  ["Drug Facts", /\bdrug\s+facts?\b/i],
  ["Supplement Facts", /\bsupplement\s+facts?\b/i],
  ["Product Facts", /\bproduct\s+facts?\b/i],
  [
    "Nutrition Facts",
    /(?:\bnutrition(?:al)?\s+(?:facts?|information|label|table)\b|datos\s+nutricionales|informaci[oó]n\s+nutricional|n[aä]hrwert|valori\s+nutrizionali|valeurs?\s+nutritionnelles?|voedingswaard|t[aá]p[eé]rt[eé]k|v[yý][zž]ivov|영양\s*정보|栄養成分|营养成分)/i,
  ],
];

const AMBIGUOUS_FACTS_PATTERN =
  /(?:\bingredients?\b|\bcomposition\b|\bformula\b|\blabel\b|\bback\s+panel\b|\bfacts?\b|\bnutrition(?:al)?\b|\bsupplement\b|ingr[ée]dients?|zutaten|ingredienti|ingredientes|skład|složen|성분|原材料|配料)/i;

const UNSUPPORTED_MEDICAL_CLAIM_PATTERN =
  /\b(?:cure|cures|cured|curing|diagnose|diagnoses|diagnosed|diagnosing|prevent|prevents|prevented|preventing|treat|treats|treated|treating|heal|heals|healed|healing)\b/i;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanEvidence(evidence, fieldName) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`${fieldName} requires at least one evidence item`);
  }
  return evidence.map((item, index) => {
    const source = cleanText(item?.source);
    const excerpt = cleanText(item?.excerpt);
    if (!source || !excerpt) {
      throw new Error(`${fieldName} evidence[${index}] requires source and excerpt`);
    }
    return {
      source,
      excerpt: excerpt.slice(0, 320),
    };
  });
}

function cleanBasis(value) {
  return value === "explicit" ? "explicit" : "inferred";
}

function cleanConfidence(value, fieldName) {
  if (value !== "high" && value !== "medium") {
    throw new Error(`${fieldName} confidence must be high or medium`);
  }
  return value;
}

function normalizeInferenceItem(item, fieldName) {
  const value = cleanText(item?.value);
  if (!value) throw new Error(`${fieldName} requires a value`);
  if (UNSUPPORTED_MEDICAL_CLAIM_PATTERN.test(value)) {
    throw new Error(`${fieldName} contains an unsupported treatment or prevention claim`);
  }
  const basis = cleanBasis(item?.basis);
  const rationale = cleanText(item?.rationale);
  if (basis === "inferred" && !rationale) {
    throw new Error(`${fieldName} inferred values require a rationale`);
  }
  return {
    value,
    basis,
    confidence: cleanConfidence(item?.confidence, fieldName),
    evidence: cleanEvidence(item?.evidence, fieldName),
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeIngredientTaxonomy(item, fieldName) {
  const taxonomy = item?.taxonomy && typeof item.taxonomy === "object"
    ? item.taxonomy
    : item;
  const substance = cleanText(taxonomy?.substance);
  const form = cleanText(taxonomy?.form);
  const categoryValue = cleanText(taxonomy?.category);
  if (!substance && (form || categoryValue)) {
    throw new Error(`${fieldName} taxonomy form/category requires substance`);
  }
  const category = categoryValue
    ? INGREDIENT_CATEGORY_NAMES.get(categoryValue.toLocaleLowerCase())
    : "";
  if (categoryValue && !category) {
    throw new Error(`${fieldName} has an unsupported ingredient category`);
  }
  return {
    ...(substance ? { substance } : {}),
    ...(form ? { form } : {}),
    ...(category ? { category } : {}),
  };
}

function normalizeMainIngredientItem(item, fieldName) {
  const normalized = normalizeInferenceItem(item, fieldName);
  const taxonomy = normalizeIngredientTaxonomy(item, fieldName);
  return {
    ...normalized,
    ...(Object.keys(taxonomy).length > 0 ? { taxonomy } : {}),
  };
}

function uniqueInferenceItems(items) {
  const byValue = new Map();
  for (const item of items) {
    const key = item.value.toLocaleLowerCase();
    const current = byValue.get(key);
    if (!current || (!current.taxonomy && item.taxonomy)) {
      byValue.set(key, item);
    }
  }
  return [...byValue.values()];
}

function mainIngredientFieldValue(item) {
  return item.taxonomy
    ? { name: item.value, ...item.taxonomy }
    : item.value;
}

export function classifyFactsImageCandidate(image = {}) {
  const url = cleanText(image.url ?? image.image_url ?? image.src);
  const alt = cleanText(image.alt);
  const title = cleanText(image.title);
  const galleryIndex = Number.isInteger(image.galleryIndex)
    ? image.galleryIndex
    : Number.isInteger(image.index)
      ? image.index
      : null;
  const haystack = `${alt} ${title} ${url}`;

  for (const [factsType, pattern] of EXPLICIT_FACTS_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        decision: "classified",
        factsType,
        requiresVisualReview: false,
        reason: "explicit_metadata",
        image: { url, alt: alt || null, title: title || null, galleryIndex },
      };
    }
  }

  if (AMBIGUOUS_FACTS_PATTERN.test(haystack)) {
    return {
      decision: "visual_review",
      factsType: null,
      requiresVisualReview: true,
      reason: "ambiguous_label_or_asset_name",
      image: { url, alt: alt || null, title: title || null, galleryIndex },
    };
  }

  if (!alt && !title && galleryIndex !== null && galleryIndex > 0) {
    return {
      decision: "visual_review",
      factsType: null,
      requiresVisualReview: true,
      reason: "unlabeled_secondary_gallery_image",
      image: { url, alt: null, title: null, galleryIndex },
    };
  }

  return {
    decision: "ignore",
    factsType: null,
    requiresVisualReview: false,
    reason: "no_facts_signal",
    image: { url, alt: alt || null, title: title || null, galleryIndex },
  };
}

export function finalizeFactsImageReview(candidate, review = {}) {
  if (!candidate?.image?.url) throw new Error("facts image candidate requires an image URL");
  if (review.isFactsImage === false) return null;
  if (review.isFactsImage !== true) {
    throw new Error("visual review must explicitly set isFactsImage");
  }
  if (!FACTS_TYPES.has(review.factsType)) {
    throw new Error("visual review requires a supported factsType");
  }
  const visibleHeading = cleanText(review.visibleHeading);
  const evidence = cleanText(review.evidence);
  if (!visibleHeading && !evidence) {
    throw new Error("visual review requires a visible heading or visual evidence");
  }
  return {
    type: review.factsType,
    image_url: candidate.image.url,
    alt: candidate.image.alt,
    gallery_index: candidate.image.galleryIndex,
    classification_basis: "visual_content",
    evidence: visibleHeading || evidence,
  };
}

function galleryImageUrl(item) {
  return cleanText(typeof item === "string"
    ? item
    : item?.image_url ?? item?.imageUrl ?? item?.url ?? item?.src);
}

/**
 * Close the gallery only after every collected image was actually reviewed.
 * A single `status` flag is intentionally insufficient evidence.
 */
export function finalizeGalleryReview(galleryImages = [], reviews = []) {
  const imageUrls = [...new Set((Array.isArray(galleryImages) ? galleryImages : [])
    .map(galleryImageUrl)
    .filter(Boolean))];
  if (imageUrls.length === 0) throw new Error("gallery review requires at least one image");
  if (!Array.isArray(reviews)) throw new Error("gallery reviews must be an array");
  const reviewByUrl = new Map(reviews.map((review) => [galleryImageUrl(review), review]));
  const factsImages = [];
  for (const imageUrl of imageUrls) {
    const review = reviewByUrl.get(imageUrl);
    if (review?.reviewedVisually !== true) {
      throw new Error(`gallery image was not visually reviewed: ${imageUrl}`);
    }
    if (review.isFactsImage === true) {
      if (!FACTS_TYPES.has(review.factsType)) {
        throw new Error(`gallery Facts image requires a supported factsType: ${imageUrl}`);
      }
      if (!cleanText(review.visibleHeading ?? review.evidence)) {
        throw new Error(`gallery Facts image requires visible evidence: ${imageUrl}`);
      }
      factsImages.push(imageUrl);
    } else if (review.isFactsImage !== false) {
      throw new Error(`gallery review must decide isFactsImage for: ${imageUrl}`);
    }
  }
  const galleryReview = {
    status: "visual_complete",
    image_count: imageUrls.length,
    reviewed_image_urls: imageUrls,
    facts_status: factsImages.length > 0 ? "confirmed" : "not_present",
    facts_image_count: factsImages.length,
  };
  return {
    fields: { gallery_review: galleryReview },
    meta: { galleryReview },
  };
}

export function finalizeFactsIngredientReview(factsImage = {}, review = {}) {
  const imageUrl = cleanText(factsImage.image_url ?? factsImage.url);
  if (!imageUrl) throw new Error("facts ingredient review requires an image URL");
  if (review.reviewedVisually !== true) {
    throw new Error("facts ingredient review must be completed visually");
  }
  const factsType = cleanText(factsImage.type ?? review.factsType);
  if (!FACTS_TYPES.has(factsType)) {
    throw new Error("facts ingredient review requires a supported facts type");
  }
  const visibleHeading = cleanText(review.visibleHeading);
  if (!visibleHeading) {
    throw new Error("facts ingredient review requires the heading read from the image");
  }
  const ingredients = review.ingredients ?? [];
  if (!Array.isArray(ingredients)) {
    throw new Error("facts ingredient review ingredients must be an array");
  }
  if (ingredients.length === 0) {
    if (review.noMainIngredientsVisible !== true) {
      throw new Error("facts ingredient review requires visible ingredient rows");
    }
    return {
      fields: { main_ingredients: [] },
      meta: {
        semanticInferences: { main_ingredients: [] },
        factsIngredientReview: {
          status: "visual_complete",
          result: "no_main_ingredients_visible",
          image_url: imageUrl,
          facts_type: factsType,
          visible_heading: visibleHeading,
          ingredient_count: 0,
        },
      },
    };
  }

  const enrichment = normalizeProductSemanticEnrichment({
    mainIngredients: ingredients.map((item, index) => {
      const visibleText = cleanText(item?.visibleText);
      if (!visibleText) {
        throw new Error(`facts ingredient review ingredients[${index}] requires visibleText`);
      }
      return {
        value: item?.name ?? item?.value,
        basis: "explicit",
        confidence: item?.confidence ?? "high",
        evidence: [{ source: "facts_image", excerpt: visibleText }],
        ...(item?.substance ? { substance: item.substance } : {}),
        ...(item?.form ? { form: item.form } : {}),
        ...(item?.category ? { category: item.category } : {}),
      };
    }),
  });
  return {
    ...enrichment,
    meta: {
      ...enrichment.meta,
      factsIngredientReview: {
        status: "visual_complete",
        result: "ingredients_read",
        image_url: imageUrl,
        facts_type: factsType,
        visible_heading: visibleHeading,
        ingredient_count: enrichment.fields.main_ingredients.length,
      },
    },
  };
}

export function normalizeProductSemanticEnrichment(input = {}) {
  const form = input.form ? normalizeInferenceItem(input.form, "form") : null;
  const presentation = cleanText(input.form?.presentation);
  const healthFunctionInput = input.healthFunction ?? input.health_function ?? [];
  const mainIngredientsInput = input.mainIngredients ?? input.main_ingredients ?? [];
  if (!Array.isArray(healthFunctionInput)) {
    throw new Error("health_function must be an array");
  }
  if (!Array.isArray(mainIngredientsInput)) {
    throw new Error("main_ingredients must be an array");
  }
  const healthFunction = healthFunctionInput.map((item, index) =>
    normalizeInferenceItem(item, `health_function[${index}]`));
  const mainIngredients = uniqueInferenceItems(mainIngredientsInput.map((item, index) =>
    normalizeMainIngredientItem(item, `main_ingredients[${index}]`)));

  if (!form && healthFunction.length === 0 && mainIngredients.length === 0) {
    throw new Error("semantic enrichment requires form, health_function, or main_ingredients");
  }

  return {
    fields: {
      ...(form ? { form: form.value } : {}),
      ...(presentation ? { form_presentation: presentation } : {}),
      ...(healthFunction.length > 0
        ? { health_function: [...new Set(healthFunction.map((item) => item.value))] }
        : {}),
      ...(mainIngredients.length > 0
        ? { main_ingredients: mainIngredients.map(mainIngredientFieldValue) }
        : {}),
    },
    meta: {
      semanticInferences: {
        ...(form ? { form: { ...form, ...(presentation ? { presentation } : {}) } } : {}),
        ...(healthFunction.length > 0 ? { health_function: healthFunction } : {}),
        ...(mainIngredients.length > 0 ? { main_ingredients: mainIngredients } : {}),
      },
    },
  };
}

export function mergeProductSemanticEnrichment(record, enrichment) {
  if (!record || typeof record !== "object") throw new Error("record is required");
  const normalized = enrichment?.fields && enrichment?.meta
    ? enrichment
    : normalizeProductSemanticEnrichment(enrichment);
  return {
    ...record,
    fields: {
      ...(record.fields ?? {}),
      ...normalized.fields,
    },
    _meta: {
      ...(record._meta ?? {}),
      ...normalized.meta,
    },
  };
}

function compactEvidenceValue(value, maxLength) {
  if (Array.isArray(value)) return value.slice(0, 40);
  if (value && typeof value === "object") return value;
  const text = cleanText(value);
  return text ? text.slice(0, maxLength) : null;
}

/**
 * Build a bounded evidence packet for the model. This helper deliberately does
 * not infer values: the model reasons over the evidence, then the normalizer
 * above validates its evidence, confidence, and medical-claim safety.
 */
export function buildSemanticEvidenceBrief(record, options = {}) {
  if (!record || typeof record !== "object") throw new Error("record is required");
  const fields = record.fields && typeof record.fields === "object"
    ? record.fields
    : record;
  const maxTextLength = Math.max(200, options.maxTextLength ?? 2_000);
  const source = (name) => compactEvidenceValue(fields[name] ?? record[name], maxTextLength);
  return {
    productUrl: cleanText(
      fields.productUrl
      ?? fields.product_url
      ?? fields.url
      ?? record.productUrl
      ?? record.product_url
      ?? record.sourceUrl,
    ) || null,
    title: source("title") ?? source("productName"),
    category: source("category") ?? source("breadcrumbs"),
    description: source("description"),
    directions: source("directions") ?? source("usage"),
    ingredients: source("ingredients"),
    supplementFacts: source("supplement_facts") ?? source("supplementFacts"),
    images: Array.isArray(fields.images) ? fields.images.slice(0, 40) : [],
    factsImages: Array.isArray(fields.facts_images)
      ? fields.facts_images.slice(0, 20)
      : [],
    existing: {
      form: source("form"),
      healthFunction: source("health_function") ?? source("healthFunctions"),
      mainIngredients: source("main_ingredients") ?? source("mainIngredients"),
    },
  };
}

/** Report what still needs model attention; never fills a field by guesswork. */
export function semanticCompletion(record, options = {}) {
  const fields = record?.fields && typeof record.fields === "object"
    ? record.fields
    : record ?? {};
  const missing = [];
  if (!cleanText(fields.form ?? fields.productForm ?? record?.productForm)) missing.push("form");
  const healthFunctions = fields.health_function ?? fields.healthFunctions
    ?? record?.health_function ?? record?.healthFunctions;
  if (!Array.isArray(healthFunctions) || healthFunctions.length === 0) {
    missing.push("health_function");
  }
  const mainIngredients = fields.main_ingredients ?? fields.mainIngredients
    ?? record?.main_ingredients ?? record?.mainIngredients;
  if (!Array.isArray(mainIngredients) || mainIngredients.length === 0) {
    missing.push("main_ingredients");
  }
  const review = fields.gallery_review ?? fields.galleryReview
    ?? record?.gallery_review ?? record?.galleryReview
    ?? record?._meta?.galleryReview;
  if (options.requireGalleryReview !== false) {
    const images = (Array.isArray(fields.images) ? fields.images : [])
      .map(galleryImageUrl)
      .filter(Boolean);
    const reviewed = new Set(
      (review?.reviewed_image_urls ?? review?.reviewedImageUrls ?? [])
        .map(galleryImageUrl)
        .filter(Boolean),
    );
    if (review?.status !== "visual_complete"
        || images.some((imageUrl) => !reviewed.has(imageUrl))) {
      missing.push("gallery_review");
    }
  }
  return {
    status: missing.length === 0 ? "complete" : "needs_model_review",
    missing,
  };
}

export const productSemanticConstants = Object.freeze({
  factsTypes: [...FACTS_TYPES],
  ingredientCategories: [...new Set(INGREDIENT_CATEGORY_NAMES.values())],
});
