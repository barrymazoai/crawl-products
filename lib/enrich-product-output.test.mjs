import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildEnrichProductExport,
  toEnrichProductEnvelope,
  toEnrichProductInput,
  writeEnrichProductExport,
} from "./enrich-product-output.mjs";

function inference(value, evidence, taxonomy = null) {
  return {
    value,
    basis: "explicit",
    confidence: "high",
    evidence: [{ source: "page", excerpt: evidence }],
    ...(taxonomy ? { taxonomy } : {}),
  };
}

function strictMeta({ form, healthFunctions, mainIngredients, factsStatus = "not_present" }) {
  return {
    semanticInferences: {
      form: inference(form, form),
      health_function: healthFunctions.map((value) => inference(value, value)),
      main_ingredients: mainIngredients.map((item) => inference(
        typeof item === "string" ? item : item.name,
        typeof item === "string" ? item : item.name,
        typeof item === "object" ? {
          substance: item.substance,
          ...(item.form ? { form: item.form } : {}),
          category: item.category,
        } : null,
      )),
    },
    factsSourceReview: {
      status: "complete",
      page_elements: { checked: true, result: "not_present", evidence: [] },
      gallery: { checked: true, result: factsStatus, reviewed_image_urls: [] },
    },
  };
}

describe("Supply Smart enrich product output", () => {
  it("maps a crawl record to the API input and keeps Facts images", () => {
    const input = toEnrichProductInput({
      sourceUrl: "https://www.shaklee.com/products/vivix",
      fields: {
        title: "Vivix Liquid",
        images: ["https://cdn.test/front.jpg"],
        facts_images: [{
          image_url: "https://cdn.test/facts.jpg",
        }],
        facts_ingredient_review: {
          status: "visual_complete",
          result: "ingredients_read",
          image_url: "https://cdn.test/facts.jpg",
        },
        health_function: ["cellular health", "anti-aging support"],
        main_ingredients: [
          "Resveratrol",
          {
            name: "Muscadine Grape Extract",
            substance: "Grape",
            category: "Herbs & Botanicals",
          },
          "resveratrol",
        ],
        form: "liquid",
        price: "$49.00",
      },
    }, {
      processedAt: "2026-07-30T08:00:00Z",
    });

    expect(input).toEqual({
      domain: "shaklee.com",
      productName: "Vivix Liquid",
      productUrl: "https://www.shaklee.com/products/vivix",
      images: [
        "https://cdn.test/front.jpg",
        "https://cdn.test/facts.jpg",
      ],
      healthFunctions: ["Cellular Health", "Anti-Aging Support"],
      mainIngredients: [
        "Resveratrol",
        {
          name: "Muscadine Grape Extract",
          substance: "Grape",
          category: "herbs_botanicals",
        },
      ],
      updateExisting: false,
      productForm: "Liquid",
      processedAt: "2026-07-30T08:00:00Z",
    });
    expect(input).not.toHaveProperty("price");
  });

  it("matches every current enrich request field and preserves the full product URL", () => {
    const input = toEnrichProductInput({
      sourceUrl: "https://us.shaklee.com/en_US/s/Nutrition/Product/p/21432?categoryCode=bestSellerNutrition",
      fields: {
        title: "Liquid BioCell Life+",
        images: ["https://cdn.test/front.jpg"],
        health_function: ["joint health support"],
        main_ingredients: [{
          name: "Zinc Citrate",
          substance: "Zinc",
          form: "Zinc Citrate",
          category: "minerals",
        }],
        form: "liquid",
        price: "$94.10",
        supplement_facts_ocr: { servingSize: "1 tbsp" },
        error: "source note",
      },
    }, {
      processedAt: "2026-08-01T00:00:00.000Z",
      updateExisting: true,
      includeNonPersistedFields: true,
    });
    expect(toEnrichProductEnvelope(input)).toEqual({
      json: {
        domain: "shaklee.com",
        productName: "Liquid BioCell Life+",
        productUrl: "https://us.shaklee.com/en_US/s/Nutrition/Product/p/21432?categoryCode=bestSellerNutrition",
        images: ["https://cdn.test/front.jpg"],
        healthFunctions: ["Joint Health Support"],
        mainIngredients: [{
          name: "Zinc Citrate",
          substance: "Zinc",
          form: "Zinc Citrate",
          category: "minerals",
        }],
        updateExisting: true,
        productForm: "Liquid",
        processedAt: "2026-08-01T00:00:00.000Z",
        error: "source note",
        price: "$94.10",
        supplementFactsOCR: { servingSize: "1 tbsp" },
      },
    });
  });

  it("includes non-persisted fields only when requested", () => {
    const input = toEnrichProductInput({
      fields: {
        title: "Example",
        price: "$10",
        supplement_facts_ocr: { servingSize: "1 capsule" },
      },
    }, {
      domain: "shop.example.com",
      includeNonPersistedFields: true,
    });
    expect(input).toMatchObject({
      domain: "shop.example.com",
      price: "$10",
      supplementFactsOCR: { servingSize: "1 capsule" },
    });
  });

  it("accepts taxonomy hints from semantic inference items and updateExisting", () => {
    const input = toEnrichProductInput({
      fields: {
        title: "Vitamin C",
        main_ingredients: [{
          value: "Ascorbic Acid",
          taxonomy: {
            substance: "Vitamin C",
            form: "Ascorbic Acid",
            category: "vitamins",
          },
        }],
      },
    }, {
      domain: "example.com",
      updateExisting: true,
    });
    expect(input.mainIngredients).toEqual([{
      name: "Ascorbic Acid",
      substance: "Vitamin C",
      form: "Ascorbic Acid",
      category: "vitamins",
    }]);
    expect(input.updateExisting).toBe(true);
  });

  it("rejects incomplete or unsupported ingredient taxonomy", () => {
    expect(() => toEnrichProductInput({
      fields: {
        title: "Example",
        main_ingredients: [{
          name: "Ascorbic Acid",
          form: "Ascorbic Acid",
          category: "vitamins",
        }],
      },
    }, { domain: "example.com" })).toThrow("form/category requires substance");

    expect(() => toEnrichProductInput({
      fields: {
        title: "Example",
        main_ingredients: [{
          name: "Example Extract",
          substance: "Example",
          category: "not_a_real_category",
        }],
      },
    }, { domain: "example.com" })).toThrow("unsupported ingredient category");
  });

  it("rejects confirmed Facts images without a completed visual ingredient review", () => {
    expect(() => toEnrichProductInput({
      fields: {
        title: "Example",
        facts_images: [{ image_url: "https://cdn.test/facts.jpg" }],
        main_ingredients: ["Vitamin C"],
      },
    }, { domain: "example.com" })).toThrow(
      "every confirmed Facts image requires a visual_complete main ingredient review",
    );
  });

  it("allows a visually confirmed Facts image with no main ingredient rows", () => {
    const input = toEnrichProductInput({
      fields: {
        title: "Example",
        facts_images: [{ image_url: "https://cdn.test/facts.jpg" }],
        facts_ingredient_review: {
          status: "visual_complete",
          result: "no_main_ingredients_visible",
          image_url: "https://cdn.test/facts.jpg",
        },
        main_ingredients: [],
      },
    }, { domain: "example.com" });
    expect(input.mainIngredients).toEqual([]);
  });

  it("requires a separate ingredient review for every confirmed Facts image", () => {
    expect(() => toEnrichProductInput({
      fields: {
        title: "Two-panel product",
        facts_images: [
          { image_url: "https://cdn.test/facts-1.jpg" },
          { image_url: "https://cdn.test/facts-2.jpg" },
        ],
        facts_ingredient_reviews: [{
          status: "visual_complete",
          result: "ingredients_read",
          image_url: "https://cdn.test/facts-1.jpg",
        }],
        main_ingredients: [{
          name: "Vitamin C",
          substance: "Vitamin C",
          category: "vitamins",
        }],
      },
    }, { domain: "example.com" })).toThrow(
      "every confirmed Facts image requires a visual_complete main ingredient review",
    );
  });

  it("does not convert a raw ingredient paragraph into a vocabulary item", () => {
    const input = toEnrichProductInput({
      fields: {
        title: "Example",
        ingredients: "Water, Vitamin C, natural flavors",
      },
    }, { domain: "example.com" });
    expect(input.mainIngredients).toEqual([]);
  });

  it("wraps each request in the oRPC json envelope and reports invalid records", () => {
    const exported = buildEnrichProductExport([
      {
        sourceUrl: "https://shop.test/a",
        fields: {
          title: "A",
          images: ["https://cdn.test/a.jpg"],
          form: "capsule",
          health_function: ["immune support"],
          main_ingredients: [{
            name: "Vitamin C",
            substance: "Vitamin C",
            category: "vitamins",
          }],
          gallery_review: {
            status: "visual_complete",
            reviewed_image_urls: ["https://cdn.test/a.jpg"],
          },
        },
        _meta: strictMeta({
          form: "Capsule",
          healthFunctions: ["Immune Support"],
          mainIngredients: [{
            name: "Vitamin C",
            substance: "Vitamin C",
            category: "vitamins",
          }],
        }),
      },
      { sourceUrl: "https://shop.test/b", fields: { title: "" } },
    ]);
    expect(exported.summary).toEqual({
      recordsReceived: 2,
      inputsReady: 1,
      errors: 1,
    });
    expect(exported.requests[0]).toEqual(toEnrichProductEnvelope({
      domain: "shop.test",
      productName: "A",
      productUrl: "https://shop.test/a",
      images: ["https://cdn.test/a.jpg"],
      healthFunctions: ["Immune Support"],
      mainIngredients: [{
        name: "Vitamin C",
        substance: "Vitamin C",
        category: "vitamins",
      }],
      productForm: "Capsule",
      updateExisting: false,
    }));
    expect(exported.errors[0]).toMatchObject({
      index: 1,
      sourceUrl: "https://shop.test/b",
      error: "productName is required",
    });
  });

  it("rejects partial inventory records unless the caller explicitly opts in", () => {
    const records = [{ sourceUrl: "https://shop.test/a", fields: { title: "A" } }];
    expect(buildEnrichProductExport(records).errors[0].error).toBe(
      "api_ready_fields_missing:images,productForm,healthFunctions,mainIngredients,factsSourceReview,galleryReview",
    );
    expect(buildEnrichProductExport(records, { allowPartial: true }).inputs).toHaveLength(1);
  });

  it("rejects unclassified ingredient strings in strict API-ready output", () => {
    const exported = buildEnrichProductExport([{
      sourceUrl: "https://shop.test/a",
      fields: {
        title: "A",
        images: ["https://cdn.test/a.jpg"],
        form: "capsule",
        health_function: ["immune support"],
        main_ingredients: ["Vitamin C"],
        gallery_review: {
          status: "visual_complete",
          reviewed_image_urls: ["https://cdn.test/a.jpg"],
        },
      },
      _meta: strictMeta({
        form: "Capsule",
        healthFunctions: ["Immune Support"],
        mainIngredients: ["Vitamin C"],
      }),
    }]);
    expect(exported.inputs).toEqual([]);
    expect(exported.errors[0].error).toBe(
      "api_ready_fields_missing:mainIngredientTaxonomy,semanticEvidence",
    );
  });

  it("writes API-ready JSON, JSONL, CSV, raw evidence, errors, and a report", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-products-enrich-"));
    try {
      const output = await writeEnrichProductExport(outDir, [{
        sourceUrl: "https://www.example.com/products/a",
        fields: {
          title: "A",
          images: ["https://cdn.test/a-front.jpg"],
          form: "powder",
          health_function: ["immune support"],
          main_ingredients: [{
            name: "Vitamin C (Ascorbic Acid)",
            substance: "Vitamin C",
            form: "Ascorbic Acid",
            category: "vitamins",
          }],
          gallery_review: {
            status: "visual_complete",
            reviewed_image_urls: ["https://cdn.test/a-front.jpg"],
          },
        },
        _meta: strictMeta({
          form: "Powder",
          healthFunctions: ["Immune Support"],
          mainIngredients: [{
            name: "Vitamin C (Ascorbic Acid)",
            substance: "Vitamin C",
            form: "Ascorbic Acid",
            category: "vitamins",
          }],
        }),
      }], {
        processedAt: "2026-07-30T08:00:00Z",
      });
      expect(output.summary.inputsReady).toBe(1);
      expect(JSON.parse(await fs.readFile(output.files.products, "utf8"))[0]).toMatchObject({
        json: {
          domain: "example.com",
          productName: "A",
          productUrl: "https://www.example.com/products/a",
          productForm: "Powder",
          updateExisting: false,
        },
      });
      expect(JSON.parse(await fs.readFile(output.files.inputs, "utf8"))[0]).toMatchObject({
        productName: "A",
      });
      expect(JSON.parse(await fs.readFile(output.files.requests, "utf8"))).toEqual([{
        json: expect.objectContaining({ productName: "A" }),
      }]);
      expect(JSON.parse((await fs.readFile(output.files.requestsJsonl, "utf8")).trim())).toEqual({
        json: expect.objectContaining({ productName: "A" }),
      });
      expect(await fs.readFile(output.files.csv, "utf8")).toContain("mainIngredients");
      expect(JSON.parse(await fs.readFile(output.files.rawRecords, "utf8"))).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(output.files.errors, "utf8"))).toEqual([]);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
