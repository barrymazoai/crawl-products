import { describe, expect, it } from "vitest";
import {
  classifyNutritionProductUrl,
  classifyNutritionSingleProduct,
  filterNutritionSingleProductRecords,
} from "./product-scope.mjs";

function record(title, extra = {}) {
  return {
    sourceUrl: extra.sourceUrl ?? `https://example.com/products/${title.toLowerCase().replaceAll(" ", "-")}`,
    fields: {
      title,
      description: extra.description ?? "",
      ...(extra.fields ?? {}),
    },
    ...(extra.root ?? {}),
  };
}

describe("nutrition-only product scope", () => {
  it.each([
    "Vita Life Stack",
    "Prenatal Wellness Bundle",
    "Daily Essentials Pack",
    "Modere Liquid BioCell Life 2 Pack",
    "Healthy Starter Kit",
  ])("excludes bundle and pack title: %s", (title) => {
    expect(classifyNutritionSingleProduct(record(title, {
      description: "A dietary supplement with vitamins and minerals.",
    }))).toMatchObject({
      included: false,
      reason: "bundle_or_pack",
      evidence: "title",
    });
  });

  it("does not confuse single-serving packets with a bundle or pack", () => {
    expect(classifyNutritionSingleProduct(record("Modere Activate", {
      description: "Mix one packet into water and drink promptly. Convenient single-serving packets.",
      fields: {
        form: "powder drink mix",
        categories: ["Nutrition"],
      },
    }))).toMatchObject({
      included: true,
      reason: "nutrition_product",
    });
  });

  it("keeps an oral supplement even when merchandised in a Beauty category", () => {
    expect(classifyNutritionSingleProduct(record("Collagen-9", {
      sourceUrl: "https://example.com/Beauty/Collagen/Collagen-9/p/123",
      description: "Add one serving to your favorite drink daily.",
      fields: {
        categories: ["Beauty"],
        form: "powder drink mix",
        facts_images: [{ type: "Supplement Facts", image_url: "https://cdn.example/facts.png" }],
      },
    }))).toMatchObject({
      included: true,
      evidence: "facts",
    });
  });

  it.each([
    ["Vitamin C Face Serum", "A topical vitamin C serum.", ["Beauty"]],
    ["Age Defense Mineral Moisturizer SPF 30", "Apply to skin.", ["Beauty"]],
    ["Basic-G Germicide", "Disinfects hard household surfaces.", ["Green Home"]],
    ["Shampoo", "Apply to wet hair and rinse.", ["Personal Care"]],
  ])("excludes a non-nutrition product: %s", (title, description, categories) => {
    expect(classifyNutritionSingleProduct(record(title, {
      description,
      fields: { categories },
    }))).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
    });
  });

  it("does not let a generic powder form override explicit household evidence", () => {
    expect(classifyNutritionSingleProduct(record("Dish Washer Automatic Powder Concentrate", {
      sourceUrl: "https://example.com/Green-Home/Household-Cleaning/Dishes/product",
      description: "A concentrated powder dishwasher detergent.",
      fields: {
        categories: ["Green Home"],
        form: "powder concentrate",
      },
    }))).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
      evidence: "category_or_url",
    });
  });

  it("excludes pet and equine supplements even when a Facts panel exists", () => {
    expect(classifyNutritionSingleProduct(record("Liquid BioCell Equine & Pet", {
      description: "A liquid nutraceutical for pets and horses.",
      fields: {
        categories: ["Nutrition"],
        form: "liquid supplement",
        facts_images: [{ type: "Supplement Facts", image_url: "https://cdn.example/facts.png" }],
      },
    }))).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
    });
  });

  it("keeps a record with a supported Supplement Facts panel", () => {
    expect(classifyNutritionSingleProduct(record("Herbal Complex", {
      fields: {
        facts_images: [{ type: "Supplement Facts", image_url: "https://cdn.example/facts.png" }],
      },
    }))).toMatchObject({
      included: true,
      evidence: "facts",
    });
  });

  it("treats a structured supplement_facts field as nutrition evidence", () => {
    expect(classifyNutritionSingleProduct(record("Trace Mineral Complex", {
      fields: {
        supplement_facts: {
          servingSize: "1 capsule",
          rows: [{ name: "Zinc", amount: "10 mg" }],
        },
      },
    }))).toMatchObject({
      included: true,
      evidence: "facts",
    });
  });

  it("excludes Drug Facts products from the nutrition-only scope", () => {
    expect(classifyNutritionSingleProduct(record("Allergy Relief Tablets", {
      fields: {
        form: "tablet",
        facts_images: [{ type: "Drug Facts", image_url: "https://cdn.example/drug-facts.png" }],
      },
    }))).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
      evidence: "drug_facts",
    });
  });

  it("conservatively excludes an unproven product", () => {
    expect(classifyNutritionSingleProduct(record("Daily Balance", {
      description: "A better choice for every day.",
    }))).toMatchObject({
      included: false,
      reason: "nutrition_evidence_missing",
    });
  });

  it("filters records and records an auditable reason breakdown", () => {
    const result = filterNutritionSingleProductRecords([
      record("Vitamin D3", { fields: { form: "softgel" } }),
      record("Wellness Bundle", { fields: { form: "kit" } }),
      record("Face Cream", { fields: { form: "topical cream" } }),
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]._meta.productScope).toEqual({
      policy: "nutrition_single_products",
      decision: "included",
      evidence: "form",
    });
    expect(result.summary).toEqual({
      policy: "nutrition_single_products",
      received: 3,
      included: 1,
      excluded: 2,
      reasonCounts: {
        bundle_or_pack: 1,
        non_nutrition_product: 1,
      },
    });
  });
});

describe("candidate URL filtering", () => {
  it("rejects obvious bundles before opening the detail page", () => {
    expect(classifyNutritionProductUrl(
      "https://example.com/products/prenatal-wellness-bundle",
    )).toMatchObject({
      included: false,
      reason: "bundle_or_pack",
    });
  });

  it("rejects an obvious cosmetic product URL", () => {
    expect(classifyNutritionProductUrl(
      "https://example.com/beauty/face/age-defense-moisturizer",
    )).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
    });
  });

  it("rejects an explicit household category URL before detail extraction", () => {
    expect(classifyNutritionProductUrl(
      "https://example.com/Green-Home/Household-Cleaning/Laundry/fresh-powder",
    )).toMatchObject({
      included: false,
      reason: "non_nutrition_product",
    });
  });

  it("keeps packet packaging for detail validation", () => {
    expect(classifyNutritionProductUrl(
      "https://example.com/products/electrolyte-single-serving-packets",
    )).toMatchObject({
      included: true,
      reason: "needs_detail_validation",
    });
  });
});
