/**
 * Variant identity and selection metadata.
 *
 * A product detail URL is not always a complete product identity: many stores
 * keep the same path while changing a SKU, flavor, size, or package option in
 * place. These helpers keep that state value-free and deterministic so the
 * browser/model layer can attach the evidence it observed.
 */

const VARIANT_QUERY_KEY_RE = /^(?:variant|variant[_-]?id|variantid|selected[_-]?variant|option(?:s)?(?:[_-]?id)?|attribute(?:s)?|super[_-]?attribute|selected[_-]?(?:size|flavou?r|colo?r|pack(?:age)?(?:[_-]?size)?))$/i;
const NON_VARIANT_QUERY_KEY_RE = /^(?:categorycode|utm_[^=]+|fbclid|gclid|currency|lang|locale)$/i;

function cleanText(value, limit = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanKey(value) {
  return cleanText(value, 120).toLocaleLowerCase();
}

function normalizeOption(option) {
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  const name = cleanText(option.name ?? option.label ?? option.option ?? option.attribute);
  const value = cleanText(option.value ?? option.selected ?? option.text ?? option.labelValue);
  if (!name && !value) return null;
  return {
    ...(name ? { name } : {}),
    ...(value ? { value } : {}),
  };
}

export function normalizeVariantOptions(value) {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).map(([name, optionValue]) => ({ name, value: optionValue }))
      : [];
  const seen = new Set();
  return raw.map(normalizeOption).filter((option) => {
    if (!option) return false;
    const key = `${cleanKey(option.name)}=${cleanKey(option.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

/** Preserve explicit variant selectors while removing category/tracking noise. */
export function normalizeVariantUrl(value, baseUrl) {
  try {
    const parsed = new URL(String(value || ""), baseUrl);
    parsed.hash = "";
    const kept = [];
    for (const [key, rawValue] of parsed.searchParams.entries()) {
      if (NON_VARIANT_QUERY_KEY_RE.test(key)) continue;
      if (VARIANT_QUERY_KEY_RE.test(key)) kept.push([key, rawValue]);
    }
    parsed.search = "";
    for (const [key, rawValue] of kept.sort(([a], [b]) => a.localeCompare(b))) {
      parsed.searchParams.append(key, rawValue);
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function stateObject(record = {}) {
  const fields = record.fields && typeof record.fields === "object" ? record.fields : record;
  const meta = record._meta && typeof record._meta === "object" ? record._meta : {};
  const variant = meta.variant && typeof meta.variant === "object" ? meta.variant : {};
  return { fields, meta, variant };
}

/** Return a stable variant key when a record carries explicit variant evidence. */
export function variantIdentity(record = {}, opts = {}) {
  const { fields, variant } = stateObject(record);
  const variantId = cleanText(
    variant.variantId ?? variant.id ?? fields.variant_id ?? fields.variantId
      ?? fields.variantID,
    160,
  );
  if (variantId) return `id:${cleanKey(variantId)}`;

  const sku = cleanText(variant.sku ?? fields.variant_sku ?? fields.sku, 160);
  if (sku) return `sku:${cleanKey(sku)}`;

  const options = normalizeVariantOptions(
    variant.optionSelections ?? variant.options ?? fields.variant_options ?? fields.variantOptions,
  );
  if (options.length > 0) {
    return `options:${options.map((option) => `${cleanKey(option.name)}=${cleanKey(option.value)}`).join("|")}`;
  }

  const url = normalizeVariantUrl(
    variant.canonicalUrl ?? fields.product_url ?? fields.productUrl ?? fields.url ?? record.sourceUrl,
    opts.baseUrl,
  );
  if (url && new URL(url).search) return `url:${url}`;
  return "";
}

export function variantDisplayName(record = {}) {
  const { fields, variant } = stateObject(record);
  const explicit = cleanText(
    variant.displayName ?? variant.name ?? fields.variant_name ?? fields.variantName,
    300,
  );
  if (explicit) return explicit;
  const options = normalizeVariantOptions(
    variant.optionSelections ?? variant.options ?? fields.variant_options ?? fields.variantOptions,
  );
  return options.map((option) => option.name && option.value
    ? `${option.name}: ${option.value}`
    : option.value || option.name).join(" / ");
}

/** Attach a normalized, auditable variant state to a detail record. */
export function withVariantState(record, state = {}, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const options = normalizeVariantOptions(state.optionSelections ?? state.options);
  const variantId = cleanText(state.variantId ?? state.id, 160);
  const sku = cleanText(state.sku ?? state.variantSku, 160);
  const canonicalUrl = normalizeVariantUrl(
    state.canonicalUrl ?? state.url ?? record.fields?.product_url ?? record.sourceUrl,
    opts.baseUrl,
  );
  const displayName = cleanText(state.displayName ?? state.name, 300)
    || options.map((option) => option.name && option.value
      ? `${option.name}: ${option.value}`
      : option.value || option.name).join(" / ");
  const identity = variantIdentity({
    fields: {
      ...(record.fields || {}),
      ...(variantId ? { variant_id: variantId } : {}),
      ...(sku ? { variant_sku: sku } : {}),
      ...(options.length > 0 ? { variant_options: options } : {}),
      ...(canonicalUrl ? { product_url: canonicalUrl } : {}),
    },
  }, opts);
  const fields = {
    ...(record.fields || {}),
    ...(canonicalUrl ? { url: canonicalUrl, product_url: canonicalUrl } : {}),
    ...(variantId ? { variant_id: variantId } : {}),
    ...(sku ? { variant_sku: sku } : {}),
    ...(options.length > 0 ? { variant_options: options } : {}),
    ...(displayName ? { variant_name: displayName } : {}),
  };
  return {
    ...record,
    sourceUrl: canonicalUrl || record.sourceUrl,
    fields,
    _meta: {
      ...(record._meta || {}),
      variant: {
        ...(record._meta?.variant || {}),
        ...(variantId ? { variantId } : {}),
        ...(sku ? { sku } : {}),
        ...(options.length > 0 ? { optionSelections: options } : {}),
        ...(displayName ? { displayName } : {}),
        ...(canonicalUrl ? { canonicalUrl } : {}),
        ...(identity ? { identity } : {}),
        source: cleanText(state.source || "visual_variant_selection", 120),
        ...(state.isDefault === true ? { isDefault: true } : {}),
      },
    },
  };
}

/** Use a variant-qualified title when the API has no separate variant column. */
export function variantQualifiedProductName(record = {}) {
  const fields = record.fields && typeof record.fields === "object" ? record.fields : record;
  const title = cleanText(fields.title ?? fields.name ?? fields.productName, 300);
  const displayName = variantDisplayName(record);
  if (!title || !displayName || title.toLocaleLowerCase().includes(displayName.toLocaleLowerCase())) {
    return title;
  }
  return `${title} — ${displayName}`.slice(0, 360);
}

export const VARIANT_QUERY_KEYS = Object.freeze({
  pattern: VARIANT_QUERY_KEY_RE.source,
});

