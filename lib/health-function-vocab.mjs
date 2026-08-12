/**
 * Health-function controlled vocabulary matcher.
 *
 * The database owns a fixed list of 658 health_function terms. The model's
 * semantic phase produces free-text phrases ("Focus", "cognitive support",
 * "Complete Meal Replacement"); export must pin each to a canonical term or
 * flag it for review. This is a backstop, not fuzzy AI matching: it accepts a
 * phrase only when it maps unambiguously to a vocabulary entry (exact match
 * after case/punctuation/plural normalization, plus a small curated alias
 * map). Anything else is returned unmatched so it lands in review rather than
 * silently entering the database as a novel term.
 */

import { HEALTH_FUNCTIONS } from "./health-functions.data.mjs";

/** Curated aliases for phrasings the model reliably emits that differ from
 *  the canonical wording. Keys are normalized (see normalizeKey). */
const ALIASES = Object.freeze({
  "focus": "Brain Health",
  "memory": "Memory Support",
  "cognitive wellness": "Cognitive Function",
  "cognitive support": "Cognitive Function",
  "cognition": "Cognitive Function",
  "mental clarity": "Brain Health",
  "immunity": "Immune Support",
  "immune health": "Immune Support",
  "gut health": "Digestive Health",
  "digestion": "Digestive Health",
  "digestive support": "Digestive Health",
  "energy": "Energy Support",
  "energy and metabolism support": "Energy Support",
  "energy and performance support": "Energy Support",
  "sleep": "Sleep Support",
  "sleep and relaxation support": "Sleep Support",
  "relaxation": "Stress Management",
  "stress": "Stress Management",
  "stress relief": "Stress Management",
  "stress support": "Stress Management",
  "joint and mobility support": "Joint Health",
  "joint support": "Joint Health",
  "joint health support": "Joint Health",
  "joint and musculoskeletal support": "Joint Health",
  "musculoskeletal support": "Joint Health",
  "mobility": "Joint Health",
  "skin": "Skin Health",
  "skin health support": "Skin Health",
  "skin and beauty support": "Skin Health",
  "beauty": "Skin Health",
  "hair": "Hair Health",
  "hair skin nails": "Skin Health",
  "weight loss": "Weight Management",
  "healthy weight management support": "Weight Management",
  "metabolism": "Metabolism Support",
  "metabolic health": "Metabolic Support",
  "cardiovascular": "Heart Health",
  "cardiovascular support": "Heart Health",
  "cardiovascular health": "Heart Health",
  "heart": "Heart Health",
  "cleanse": "Detox Support",
  "cleanse detox support": "Detox Support",
  "detoxification support": "Detoxification",
  "hydration support": "Hydration",
  "performance": "Sports Performance",
  "athletic performance": "Sports Performance",
  "muscle": "Muscle Health",
  "muscle growth": "Muscle Building",
  "bone": "Bone Health",
  "eye": "Eye Health",
  "vision": "Eye Health",
  "mood": "Mood Support",
  "anti inflammatory": "Anti-inflammatory",
  "inflammation": "Anti-inflammatory",
  "blood sugar": "Blood Sugar Support",
  "hormonal support": "Hormonal Balance",
  "hormone support": "Hormone Balance",
});

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/s$/, "");   // light singularization (vitamins→vitamin)
}

// Canonical index: normalized name -> { id, name }
const BY_KEY = new Map();
for (const entry of HEALTH_FUNCTIONS) {
  BY_KEY.set(normalizeKey(entry.name), entry);
}
const ALIAS_KEYS = new Map(
  Object.entries(ALIASES).map(([k, canonical]) => [normalizeKey(k), canonical]),
);

/**
 * Match one free-text phrase to the vocabulary.
 * Returns { id, name } on a confident match, or null if unmatched.
 */
export function matchHealthFunction(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  if (ALIAS_KEYS.has(key)) {
    const canonicalKey = normalizeKey(ALIAS_KEYS.get(key));
    return BY_KEY.get(canonicalKey) ?? null;
  }
  return null;
}

/**
 * Normalize an array of model-produced phrases. Returns the matched canonical
 * entries (deduped, order-preserved) plus the phrases that could not be
 * matched — the caller sends a record with unmatched terms to review.
 */
export function normalizeHealthFunctions(values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  for (const value of list) {
    const hit = matchHealthFunction(value);
    if (!hit) {
      const raw = String(value ?? "").trim();
      if (raw) unmatched.push(raw);
      continue;
    }
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    matched.push(hit);
  }
  return { matched, unmatched };
}
