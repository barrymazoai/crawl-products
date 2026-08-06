const BUNDLE_TITLE_RE =
  /\b(?:bundle|kit|stack|collection|regimen|starter\s+set|gift\s+set|value\s+pack|variety\s+pack|family\s+pack|multi[-\s]?pack|pack|duo|trio)\b/i;
const BUNDLE_DESCRIPTION_RE =
  /\b(?:this|the)\s+(?:bundle|kit|stack|collection|regimen)\b|\b(?:bundle|kit|stack)\s+(?:includes|contains)\b/i;
const BUNDLE_FORM_RE =
  /\b(?:multi[-\s]?product|bundle|kit|multi[-\s]?pack|variety\s+pack|gift\s+set)\b/i;
const NON_NUTRITION_PRODUCT_RE =
  /\b(?:moisturizer|sunscreen|serum|mascara|lip\s+(?:oil|gloss|color)|cleanser|cleansing\s+bar|body\s+(?:butter|wash|lotion)|beard\s+wash|shampoo|conditioner|deodorant|exfoliant|toner|bb\s+cream|tanning|sculpting\s+wand|smoothing\s+wand|cosmetic|makeup|germicide|detergent|dish\s+wash|dryer\s+sheet|fabric\s+softener|cleaning\s+(?:cloth|concentrate)|measuring\s+(?:cup|spoon)|dispenser)\b/i;
const NON_NUTRITION_CONTEXT_RE =
  /\b(?:beauty|skin\s*care|hair\s*care|personal\s*care|cosmetics?|makeup|green\s+home|household|home\s+care|cleaning|laundry|dishwashing|pet|equine)\b/i;
const DECISIVE_NON_NUTRITION_CONTEXT_RE =
  /\b(?:green\s+home|household|home\s+care|cleaning|laundry|dishwashing|pet|equine)\b/i;
const TOPICAL_OR_NON_FOOD_FORM_RE =
  /\b(?:topical|cream|lotion|serum|cleanser|shampoo|conditioner|mascara|deodorant|cosmetic|skincare|device|accessory|cleaning|household|pet|equine)\b/i;
const ORAL_NUTRITION_FORM_RE =
  /\b(?:capsule|caplet|tablet|softgel|gummy|chewable|powder|drink\s+mix|shake|tea|nutrition\s+bar|supplement|oral|drops|liquid\s+supplement|sachet)\b/i;
const NUTRITION_CONTEXT_RE =
  /\b(?:nutrition|dietary\s+supplement|supplement|vitamins?|minerals?|protein|amino\s+acid|probiotic|prebiotic|omega[-\s]?3|herbal|botanical|sports\s+nutrition|healthy\s+weight|meal\s+replacement|electrolyte)\b/i;
const ORAL_DIRECTION_RE =
  /\b(?:take|swallow|chew|drink|consume|mix|blend|dissolve)\b.{0,80}\b(?:daily|capsules?|tablets?|softgels?|gummies?|scoops?|packets?|water|beverage|meal)\b/i;
const NON_NUTRITION_URL_PRODUCT_RE =
  /(?:^|[-_/])(?:moisturizer|sunscreen|serum|mascara|cleanser|body-wash|body-butter|body-lotion|beard-wash|shampoo|conditioner|deodorant|exfoliant|toner|bb-cream|tanning|sculpting-wand|smoothing-wand|germicide|detergent|dish-wash|dryer-sheet|fabric-softener|cleaning-cloth|measuring-cup|measuring-spoon|dispenser|equine|pet)(?:[-_/]|$)/i;
const DECISIVE_NON_NUTRITION_URL_CONTEXT_RE =
  /(?:^|\/)(?:green-home|household-cleaning|home-care|laundry|dishwashing)(?:\/|$)/i;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function textValues(value) {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === "object") {
    return [
      value.name,
      value.value,
      value.title,
      value.label,
      value.type,
      value.facts_type,
      value.visible_heading,
      value.evidence,
    ].map(cleanText).filter(Boolean);
  }
  const text = cleanText(value);
  return text ? [text] : [];
}

function recordFields(record) {
  return record?.fields && typeof record.fields === "object"
    ? record.fields
    : record ?? {};
}

function recordUrl(record, fields = recordFields(record)) {
  return cleanText(
    fields.productUrl
    ?? fields.product_url
    ?? fields.url
    ?? record?.productUrl
    ?? record?.product_url
    ?? record?.sourceUrl
    ?? record?.url,
  );
}

function decodedUrlText(value) {
  try {
    const parsed = new URL(value);
    // Query parameters often carry selected variant values (e.g. pack size or
    // flavor). They are not reliable evidence that the product is a bundle.
    return decodeURIComponent(parsed.pathname)
      .replace(/[-_+/]+/g, " ");
  } catch {
    return cleanText(value).replace(/[-_+/]+/g, " ");
  }
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return cleanText(value) !== "";
}

function factsMetadataMatches(values, pattern) {
  return values.some((value) => {
    if (Array.isArray(value)) return factsMetadataMatches(value, pattern);
    if (value && typeof value === "object") {
      return pattern.test(textValues(value).join(" "));
    }
    return pattern.test(cleanText(value));
  });
}

function hasSupportedNutritionFacts(record, fields) {
  const explicitFacts = [
    fields.supplement_facts,
    fields.supplementFacts,
    fields.nutrition_facts,
    fields.nutritionFacts,
    record?.supplement_facts,
    record?.supplementFacts,
    record?.nutrition_facts,
    record?.nutritionFacts,
  ];
  if (explicitFacts.some(hasValue)) return true;
  return factsMetadataMatches([
    fields.facts_images,
    fields.factsImages,
    record?.facts_images,
    record?.factsImages,
  ], /\b(?:supplement|nutrition)\s+facts?\b/i);
}

function hasDrugFacts(record, fields) {
  return hasValue(fields.drug_facts)
    || hasValue(fields.drugFacts)
    || hasValue(record?.drug_facts)
    || hasValue(record?.drugFacts)
    || factsMetadataMatches([
      fields.facts_images,
      fields.factsImages,
      record?.facts_images,
      record?.factsImages,
    ], /\bdrug\s+facts?\b/i);
}

function bundleEvidence(record, fields, title, urlText) {
  const form = cleanText(
    fields.productForm
    ?? fields.form
    ?? record?.productForm
    ?? record?.form,
  );
  const description = cleanText(fields.description ?? record?.description);
  const hasVariantState = Boolean(
    fields.variant_id
    || fields.variantId
    || fields.variant_sku
    || fields.variantSku
    || fields.variant_name
    || fields.variantName
    || fields.variant_options
    || fields.variantOptions
    || record?._meta?.variant,
  );
  if (BUNDLE_TITLE_RE.test(title) && !hasVariantState) return "title";
  if (BUNDLE_FORM_RE.test(form)) return "form";
  if (BUNDLE_DESCRIPTION_RE.test(description)) return "description";
  if (BUNDLE_TITLE_RE.test(urlText) && !hasVariantState) return "url";
  return "";
}

export const PRODUCT_SCOPE_POLICY = "nutrition_single_products";

export function classifyNutritionProductUrl(url) {
  const value = cleanText(url);
  const urlText = decodedUrlText(value);
  if (BUNDLE_TITLE_RE.test(urlText)) {
    return {
      included: false,
      reason: "bundle_or_pack",
      evidence: "url",
    };
  }
  if (NON_NUTRITION_URL_PRODUCT_RE.test(value)) {
    return {
      included: false,
      reason: "non_nutrition_product",
      evidence: "url",
    };
  }
  if (DECISIVE_NON_NUTRITION_URL_CONTEXT_RE.test(value)) {
    return {
      included: false,
      reason: "non_nutrition_product",
      evidence: "url",
    };
  }
  return {
    included: true,
    reason: "needs_detail_validation",
    evidence: null,
  };
}

export function classifyNutritionSingleProduct(record) {
  const fields = recordFields(record);
  const title = cleanText(
    fields.productName
    ?? fields.title
    ?? fields.name
    ?? record?.productName
    ?? record?.title
    ?? record?.name,
  );
  const description = cleanText(fields.description ?? record?.description);
  const categories = textValues(
    fields.categories
    ?? fields.category
    ?? record?.categories
    ?? record?.category,
  ).join(" ");
  const form = cleanText(
    fields.productForm
    ?? fields.form
    ?? record?.productForm
    ?? record?.form,
  );
  const url = recordUrl(record, fields);
  const urlText = decodedUrlText(url);
  const bundleSource = bundleEvidence(record, fields, title, urlText);
  if (bundleSource) {
    return {
      included: false,
      reason: "bundle_or_pack",
      evidence: bundleSource,
      title: title || null,
      url: url || null,
    };
  }

  const factsEvidence = hasSupportedNutritionFacts(record, fields);
  const drugFactsEvidence = hasDrugFacts(record, fields);
  const oralForm = ORAL_NUTRITION_FORM_RE.test(form);
  const oralDirections = ORAL_DIRECTION_RE.test(description);
  const explicitNutritionContext = NUTRITION_CONTEXT_RE.test(
    `${categories} ${urlText} ${title} ${description}`,
  );
  const decisiveNonNutrition = drugFactsEvidence
    || TOPICAL_OR_NON_FOOD_FORM_RE.test(form)
    || NON_NUTRITION_PRODUCT_RE.test(title)
    || DECISIVE_NON_NUTRITION_CONTEXT_RE.test(
      `${title} ${categories} ${urlText} ${description}`,
    );
  if (decisiveNonNutrition) {
    return {
      included: false,
      reason: "non_nutrition_product",
      evidence: drugFactsEvidence
        ? "drug_facts"
        : TOPICAL_OR_NON_FOOD_FORM_RE.test(form)
          ? "form"
          : NON_NUTRITION_PRODUCT_RE.test(title)
            ? "title"
            : "category_or_url",
      title: title || null,
      url: url || null,
    };
  }

  const softNonNutrition = NON_NUTRITION_CONTEXT_RE.test(`${categories} ${urlText}`);
  const strongOralEvidence = factsEvidence
    || oralForm
    || oralDirections;

  if (softNonNutrition && !strongOralEvidence) {
    return {
      included: false,
      reason: "non_nutrition_product",
      evidence: "category_or_url",
      title: title || null,
      url: url || null,
    };
  }
  if (strongOralEvidence || explicitNutritionContext) {
    return {
      included: true,
      reason: "nutrition_product",
      evidence: factsEvidence
        ? "facts"
        : oralForm
          ? "form"
          : oralDirections
            ? "directions"
            : "category_or_text",
      title: title || null,
      url: url || null,
    };
  }
  return {
    included: false,
    reason: "nutrition_evidence_missing",
    evidence: "detail_record",
    title: title || null,
    url: url || null,
  };
}

/**
 * Harvest-stage scope filter: URL-level exclusion only (explicit bundle or
 * non-nutrition URL patterns). Nutrition-evidence judgment is deliberately
 * deferred — at harvest time the semantic evidence has not been read yet, so
 * requiring it here would wrongly exclude every record (see
 * references/harvest-architecture.md §4). The semantic phase applies the full
 * classifyNutritionSingleProduct() judgment once evidence is available.
 */
export function filterHarvestStageRecords(records) {
  const included = [];
  const excluded = [];
  for (const record of Array.isArray(records) ? records : []) {
    const fields = recordFields(record);
    const url = cleanText(
      fields.product_url ?? fields.productUrl ?? fields.url ?? record?.sourceUrl,
    );
    const decision = classifyNutritionProductUrl(url);
    if (decision.included) {
      included.push({
        ...record,
        _meta: {
          ...(record?._meta ?? {}),
          productScope: {
            policy: PRODUCT_SCOPE_POLICY,
            decision: "included",
            reason: "deferred_to_semantic_stage",
            evidence: "harvest_stage_url_check",
          },
        },
      });
    } else {
      excluded.push({
        ...record,
        _meta: {
          ...(record?._meta ?? {}),
          productScope: {
            policy: PRODUCT_SCOPE_POLICY,
            decision: "excluded",
            reason: decision.reason,
            evidence: decision.evidence,
          },
        },
      });
    }
  }
  return { included, excluded };
}

export function filterNutritionSingleProductRecords(records) {
  const included = [];
  const excluded = [];
  const reasonCounts = {};
  for (const record of Array.isArray(records) ? records : []) {
    const decision = classifyNutritionSingleProduct(record);
    if (decision.included) {
      included.push({
        ...record,
        _meta: {
          ...(record?._meta ?? {}),
          productScope: {
            policy: PRODUCT_SCOPE_POLICY,
            decision: "included",
            evidence: decision.evidence,
          },
        },
      });
      continue;
    }
    reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
    excluded.push(decision);
  }
  return {
    records: included,
    excluded,
    summary: {
      policy: PRODUCT_SCOPE_POLICY,
      received: Array.isArray(records) ? records.length : 0,
      included: included.length,
      excluded: excluded.length,
      reasonCounts,
    },
  };
}
