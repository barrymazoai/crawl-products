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

function ingredientValueName(item) {
  return cleanText(typeof item === "string" ? item : item?.name ?? item?.value);
}

function mergeStringValues(current = [], incoming = []) {
  const values = new Map();
  for (const value of [...current, ...incoming]) {
    const text = cleanText(value);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (!values.has(key)) values.set(key, text);
  }
  return [...values.values()];
}

function mergeMainIngredientValues(current = [], incoming = []) {
  const values = new Map();
  for (const item of [...current, ...incoming]) {
    const name = ingredientValueName(item);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const existing = values.get(key);
    if (!existing
        || typeof existing === "string" && typeof item === "object"
        || typeof existing === "object" && typeof item === "object"
          && Object.keys(item).length >= Object.keys(existing).length) {
      values.set(key, typeof item === "object" ? { ...item } : item);
    }
  }
  return [...values.values()];
}

function mergeInferenceItems(current = [], incoming = []) {
  const values = new Map();
  for (const item of [...current, ...incoming]) {
    const value = cleanText(item?.value);
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const existing = values.get(key);
    const existingTaxonomy = existing?.taxonomy && typeof existing.taxonomy === "object";
    const incomingTaxonomy = item?.taxonomy && typeof item.taxonomy === "object";
    if (!existing || !existingTaxonomy && incomingTaxonomy) values.set(key, item);
  }
  return [...values.values()];
}

function factsIngredientReviewKey(review) {
  return cleanText(review?.image_url ?? review?.imageUrl).toLocaleLowerCase();
}

function mergeFactsIngredientReviews(current = [], incoming = []) {
  const reviews = new Map();
  for (const review of [...current, ...incoming]) {
    const key = factsIngredientReviewKey(review);
    if (key) reviews.set(key, review);
  }
  return [...reviews.values()];
}

function inferenceHasEvidence(item) {
  if (!item || typeof item !== "object") return false;
  if (!cleanText(item.value)) return false;
  if (!["explicit", "inferred"].includes(item.basis)) return false;
  if (!["high", "medium"].includes(item.confidence)) return false;
  if (item.basis === "inferred" && !cleanText(item.rationale)) return false;
  return Array.isArray(item.evidence) && item.evidence.length > 0
    && item.evidence.every((evidence) =>
      cleanText(evidence?.source) && cleanText(evidence?.excerpt));
}

function inferenceForValue(items, value) {
  const key = cleanText(value).toLocaleLowerCase();
  return (Array.isArray(items) ? items : []).find((item) =>
    cleanText(item?.value).toLocaleLowerCase() === key);
}

function factsImages(record, fields) {
  return [
    ...(Array.isArray(fields?.facts_images) ? fields.facts_images : []),
    ...(fields !== record && Array.isArray(record?.facts_images) ? record.facts_images : []),
  ].map((item) => cleanText(
    typeof item === "string" ? item : item?.image_url ?? item?.imageUrl ?? item?.url,
  )).filter(Boolean);
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
        decision: "visual_review",
        factsType,
        requiresVisualReview: true,
        reason: "explicit_metadata_candidate",
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
  if (review.reviewedVisually !== true) {
    throw new Error("facts image review must be completed visually");
  }
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

/**
 * Prove that both possible Facts sources were inspected for this product.
 * A gallery-only review is insufficient: some sites expose a DOM table or an
 * accordion even when the gallery also contains a label image.
 */
export function finalizeFactsSourceReview(input = {}) {
  const pageElements = input.pageElements ?? input.page_elements ?? input.page ?? {};
  if (pageElements.checked !== true) {
    throw new Error("facts source review must check page elements");
  }
  const pageResult = cleanText(pageElements.result);
  if (!["found", "not_present"].includes(pageResult)) {
    throw new Error("facts page element result must be found or not_present");
  }
  const pageEvidence = Array.isArray(pageElements.evidence)
    ? pageElements.evidence.map((item, index) => {
      const source = cleanText(item?.source);
      const excerpt = cleanText(item?.excerpt);
      if (!source || !excerpt) {
        throw new Error(`facts page element evidence[${index}] requires source and excerpt`);
      }
      return { source, excerpt: excerpt.slice(0, 320) };
    })
    : [];
  if (pageResult === "found" && pageEvidence.length === 0) {
    throw new Error("found facts page elements require evidence");
  }

  const galleryReview = input.galleryReview?.fields?.gallery_review
    ?? input.galleryReview?.fields?.galleryReview
    ?? input.galleryReview?.meta?.galleryReview
    ?? input.galleryReview
    ?? input.gallery_review;
  if (galleryReview?.status !== "visual_complete") {
    throw new Error("facts source review requires a completed gallery review");
  }
  if (!["confirmed", "not_present"].includes(galleryReview.facts_status)) {
    throw new Error("gallery review must decide whether Facts images are present");
  }
  const review = {
    status: "complete",
    page_elements: {
      checked: true,
      result: pageResult,
      evidence: pageEvidence,
    },
    gallery: {
      checked: true,
      result: galleryReview.facts_status,
      reviewed_image_urls: [...new Set(
        (galleryReview.reviewed_image_urls ?? []).map(galleryImageUrl).filter(Boolean),
      )],
    },
  };
  return {
    fields: { facts_source_review: review },
    meta: { factsSourceReview: review },
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
        factsIngredientReviews: [{
          status: "visual_complete",
          result: "no_main_ingredients_visible",
          image_url: imageUrl,
          facts_type: factsType,
          visible_heading: visibleHeading,
          ingredient_count: 0,
        }],
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
  const completedReview = {
    status: "visual_complete",
    result: "ingredients_read",
    image_url: imageUrl,
    facts_type: factsType,
    visible_heading: visibleHeading,
    ingredient_count: enrichment.fields.main_ingredients.length,
  };
  return {
    ...enrichment,
    meta: {
      ...enrichment.meta,
      factsIngredientReview: completedReview,
      factsIngredientReviews: [completedReview],
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
  const currentFields = record.fields ?? {};
  const incomingFields = normalized.fields ?? {};
  const currentMeta = record._meta ?? {};
  const incomingMeta = normalized.meta ?? {};
  const currentInferences = currentMeta.semanticInferences ?? {};
  const incomingInferences = incomingMeta.semanticInferences ?? {};
  const currentFactsReviews = [
    ...(Array.isArray(currentMeta.factsIngredientReviews)
      ? currentMeta.factsIngredientReviews
      : []),
    ...(currentMeta.factsIngredientReview ? [currentMeta.factsIngredientReview] : []),
  ];
  const incomingFactsReviews = [
    ...(Array.isArray(incomingMeta.factsIngredientReviews)
      ? incomingMeta.factsIngredientReviews
      : []),
    ...(incomingMeta.factsIngredientReview ? [incomingMeta.factsIngredientReview] : []),
  ];
  const factsIngredientReviews = mergeFactsIngredientReviews(
    currentFactsReviews,
    incomingFactsReviews,
  );
  return {
    ...record,
    fields: {
      ...currentFields,
      ...incomingFields,
      ...((currentFields.health_function || incomingFields.health_function) ? {
        health_function: mergeStringValues(
          currentFields.health_function,
          incomingFields.health_function,
        ),
      } : {}),
      ...((currentFields.main_ingredients || incomingFields.main_ingredients) ? {
        main_ingredients: mergeMainIngredientValues(
          currentFields.main_ingredients,
          incomingFields.main_ingredients,
        ),
      } : {}),
    },
    _meta: {
      ...currentMeta,
      ...incomingMeta,
      semanticInferences: {
        ...currentInferences,
        ...incomingInferences,
        ...((currentInferences.health_function || incomingInferences.health_function) ? {
          health_function: mergeInferenceItems(
            currentInferences.health_function,
            incomingInferences.health_function,
          ),
        } : {}),
        ...((currentInferences.main_ingredients || incomingInferences.main_ingredients) ? {
          main_ingredients: mergeInferenceItems(
            currentInferences.main_ingredients,
            incomingInferences.main_ingredients,
          ),
        } : {}),
      },
      ...(factsIngredientReviews.length > 0 ? {
        factsIngredientReview: factsIngredientReviews.at(-1),
        factsIngredientReviews,
      } : {}),
    },
  };
}

function compactEvidenceValue(value, maxLength) {
  if (Array.isArray(value)) return value.slice(0, 40);
  if (value && typeof value === "object") return value;
  const text = cleanText(value);
  return text ? text.slice(0, maxLength) : null;
}

// Detail extractors can capture the label of an accordion/tab instead of the
// content revealed underneath it.  A heading is not ingredient evidence.  We
// keep this deliberately narrow: real prose such as "Ingredients: water,
// vitamin C" must remain available to the model.
const SEMANTIC_HEADING_ONLY_RE = /^(?:ingredients?|ingredient\s+list|view\s+ingredients?|show\s+ingredients?|supplement\s+facts?|nutrition(?:al)?\s+facts?|nutrition(?:al)?\s+information|drug\s+facts?|product\s+facts?|facts?)\s*[:\-–—]?$/i;

function isHeadingOnlySemanticValue(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return true;
  return values.every((item) => {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object"
        ? item.text ?? item.value ?? item.content ?? ""
        : "";
    const text = cleanText(String(raw).replace(/<[^>]*>/g, " "));
    return Boolean(text) && SEMANTIC_HEADING_ONLY_RE.test(text);
  });
}

function semanticSourceValue(value, fieldName, maxLength) {
  if (isHeadingOnlySemanticValue(value)
      && ["ingredients", "supplementFacts", "supplement_facts", "nutritionFacts", "nutrition_facts", "facts"].includes(fieldName)) {
    return null;
  }
  return compactEvidenceValue(value, maxLength);
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
  const source = (...names) => {
    for (const name of names) {
      const value = semanticSourceValue(fields[name] ?? record[name], name, maxTextLength);
      if (value != null) return value;
    }
    return null;
  };
  const factsImages = Array.isArray(fields.facts_images)
    ? fields.facts_images.slice(0, 20)
    : Array.isArray(record.facts_images)
      ? record.facts_images.slice(0, 20)
      : [];
  const galleryImages = Array.isArray(fields.images)
    ? fields.images.slice(0, 40)
    : Array.isArray(record.images)
      ? record.images.slice(0, 40)
      : [];
  const factsImageCandidates = galleryImages
    .map((image, index) => classifyFactsImageCandidate({
      ...(typeof image === "object" ? image : { url: image }),
      galleryIndex: Number.isInteger(image?.galleryIndex)
        ? image.galleryIndex
        : index,
    }))
    .filter((candidate) => candidate.requiresVisualReview && candidate.image.url);
  const ingredients = source("ingredients", "ingredient_list", "key_ingredients");
  const supplementFacts = source(
    "supplement_facts",
    "supplementFacts",
    "nutrition_facts",
    "nutritionFacts",
    "drug_facts",
    "product_facts",
  );
  const existing = {
    form: source("form", "productForm"),
    healthFunction: source("health_function", "healthFunctions"),
    mainIngredients: source("main_ingredients", "mainIngredients"),
  };
  const sourceGaps = [];
  if (!ingredients) sourceGaps.push("ingredients_content");
  if (!supplementFacts && factsImages.length === 0 && factsImageCandidates.length === 0) {
    sourceGaps.push("facts_content");
  }
  if (!existing.form) sourceGaps.push("form");
  if (!existing.healthFunction) sourceGaps.push("health_function");
  if (!existing.mainIngredients) sourceGaps.push("main_ingredients");
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
    ingredients,
    supplementFacts,
    images: galleryImages,
    factsImages,
    factsImageCandidates,
    existing,
    sourceGaps,
    nextActions: [
      ...(ingredients ? [] : ["open_ingredients_accordion_or_read_back_label"]),
      ...(factsImages.length > 0 || factsImageCandidates.length > 0
        ? ["read_each_facts_or_label_image_for_ingredient_rows"]
        : []),
      ...(supplementFacts ? [] : ["check_rendered_facts_table_and_all_gallery_assets"]),
      ...(existing.form ? [] : ["infer_form_from_title_description_directions_facts_or_packaging"]),
      ...(existing.healthFunction ? [] : ["infer_health_function_from_description_category_benefit_copy"]),
      ...(existing.mainIngredients ? [] : ["derive_main_ingredients_from_readable_ingredients_or_facts_evidence"]),
    ],
  };
}

/** Return the evidence/review gates that still block an API-ready record. */
export function semanticEvidenceGaps(record, options = {}) {
  const fields = record?.fields && typeof record.fields === "object"
    ? record.fields
    : record ?? {};
  const meta = record?._meta ?? {};
  const inferences = meta.semanticInferences ?? {};
  const gaps = [];

  const form = cleanText(fields.form ?? fields.productForm ?? record?.productForm);
  if (form) {
    const inference = inferences.form;
    if (!inferenceHasEvidence(inference)
        || cleanText(inference.value).toLocaleLowerCase() !== form.toLocaleLowerCase()) {
      gaps.push("form_evidence");
    }
  }

  const healthFunctions = fields.health_function ?? fields.healthFunctions
    ?? record?.health_function ?? record?.healthFunctions;
  if (Array.isArray(healthFunctions) && healthFunctions.length > 0) {
    if (healthFunctions.some((value) =>
      !inferenceHasEvidence(inferenceForValue(inferences.health_function, value)))) {
      gaps.push("health_function_evidence");
    }
  }

  const mainIngredients = fields.main_ingredients ?? fields.mainIngredients
    ?? record?.main_ingredients ?? record?.mainIngredients;
  if (Array.isArray(mainIngredients) && mainIngredients.length > 0) {
    const incomplete = mainIngredients.some((ingredient) => {
      const name = ingredientValueName(ingredient);
      const inference = inferenceForValue(inferences.main_ingredients, name);
      if (!inferenceHasEvidence(inference)) return true;
      if (options.requireIngredientTaxonomy === false) return false;
      const taxonomy = inference?.taxonomy && typeof inference.taxonomy === "object"
        ? inference.taxonomy
        : inference;
      if (typeof ingredient !== "object") return true;
      const ingredientTaxonomy = ingredient.taxonomy && typeof ingredient.taxonomy === "object"
        ? ingredient.taxonomy
        : ingredient;
      return !cleanText(taxonomy?.substance)
        || !cleanText(taxonomy?.category)
        || cleanText(taxonomy.substance).toLocaleLowerCase()
          !== cleanText(ingredientTaxonomy.substance).toLocaleLowerCase()
        || cleanText(taxonomy.category).toLocaleLowerCase()
          !== cleanText(ingredientTaxonomy.category).toLocaleLowerCase()
        || cleanText(ingredientTaxonomy.form)
          && cleanText(taxonomy.form).toLocaleLowerCase()
            !== cleanText(ingredientTaxonomy.form).toLocaleLowerCase();
    });
    if (incomplete) gaps.push("main_ingredient_evidence");
  }

  if (options.requireFactsSourceReview !== false) {
    const sourceReview = fields.facts_source_review
      ?? fields.factsSourceReview
      ?? meta.factsSourceReview;
    if (sourceReview?.status !== "complete"
        || sourceReview?.page_elements?.checked !== true
        || !["found", "not_present"].includes(sourceReview?.page_elements?.result)
        || sourceReview?.gallery?.checked !== true
        || !["confirmed", "not_present"].includes(sourceReview?.gallery?.result)) {
      gaps.push("facts_source_review");
    }
  }

  const factsImageUrls = factsImages(record, fields);
  if (factsImageUrls.length > 0 && options.requireFactsIngredientReview !== false) {
    const singularReview = fields.factsIngredientReview
      ?? fields.facts_ingredient_review
      ?? record?.factsIngredientReview
      ?? record?.facts_ingredient_review
      ?? meta.factsIngredientReview;
    const reviews = mergeFactsIngredientReviews(
      [
        ...(Array.isArray(fields.factsIngredientReviews) ? fields.factsIngredientReviews : []),
        ...(Array.isArray(fields.facts_ingredient_reviews) ? fields.facts_ingredient_reviews : []),
        ...(Array.isArray(record?.factsIngredientReviews) ? record.factsIngredientReviews : []),
        ...(Array.isArray(record?.facts_ingredient_reviews)
          ? record.facts_ingredient_reviews
          : []),
        ...(Array.isArray(meta.factsIngredientReviews) ? meta.factsIngredientReviews : []),
      ],
      singularReview ? [singularReview] : [],
    );
    const reviewedUrls = new Set(reviews
      .filter((review) => review?.status === "visual_complete"
        && ["ingredients_read", "no_main_ingredients_visible"].includes(review?.result))
      .map(factsIngredientReviewKey));
    if (factsImageUrls.some((url) => !reviewedUrls.has(url.toLocaleLowerCase()))) {
      gaps.push("facts_ingredient_review");
    }
  }

  return [...new Set(gaps)];
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
  } else if (options.requireIngredientTaxonomy !== false) {
    const unclassified = mainIngredients.some((ingredient) => {
      const taxonomy = ingredient?.taxonomy && typeof ingredient.taxonomy === "object"
        ? ingredient.taxonomy
        : ingredient;
      return typeof ingredient !== "object"
        || !cleanText(ingredient?.name ?? ingredient?.value)
        || !cleanText(taxonomy?.substance)
        || !cleanText(taxonomy?.category);
    });
    if (unclassified) missing.push("main_ingredient_taxonomy");
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
  missing.push(...semanticEvidenceGaps(record, options));
  return {
    status: missing.length === 0 ? "complete" : "needs_model_review",
    missing,
  };
}

export const productSemanticConstants = Object.freeze({
  factsTypes: [...FACTS_TYPES],
  ingredientCategories: [...new Set(INGREDIENT_CATEGORY_NAMES.values())],
});
