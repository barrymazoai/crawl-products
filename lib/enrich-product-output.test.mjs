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

function apiReadyRecord(name = "A") {
  const ingredient = {
    name: "Vitamin C (Ascorbic Acid)",
    substance: "Vitamin C",
    form: "Ascorbic Acid",
    category: "vitamins",
  };
  return {
    sourceUrl: `https://www.example.com/products/${name.toLowerCase()}`,
    fields: {
      title: name,
      images: [`https://cdn.test/${name.toLowerCase()}-front.jpg`],
      form: "powder",
      health_function: ["immune support"],
      main_ingredients: [ingredient],
      gallery_review: {
        status: "visual_complete",
        reviewed_image_urls: [`https://cdn.test/${name.toLowerCase()}-front.jpg`],
      },
    },
    _meta: strictMeta({
      form: "Powder",
      healthFunctions: ["Immune Support"],
      mainIngredients: [ingredient],
    }),
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

  it("keeps the source title while preserving the selected variant in raw record metadata", () => {
    const input = toEnrichProductInput({
      sourceUrl: "https://www.example.com/products/foo?variant=42",
      fields: {
        title: "Foo",
        variant_name: "Flavor: Chocolate",
        images: ["https://cdn.test/foo.jpg"],
        form: "powder",
        health_function: ["energy support"],
        main_ingredients: [{
          name: "Caffeine",
          substance: "Caffeine",
          category: "amino_acids_peptides",
        }],
      },
      _meta: strictMeta({
        form: "Powder",
        healthFunctions: ["Energy Support"],
        mainIngredients: [{
          name: "Caffeine",
          substance: "Caffeine",
          category: "amino_acids_peptides",
        }],
      }),
    }, { requireGalleryReview: false });
    expect(input.productName).toBe("Foo");
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

  it("exports sku when the crawl found one and omits it otherwise", () => {
    const withSku = toEnrichProductInput({
      ...apiReadyRecord("A"),
      fields: { ...apiReadyRecord("A").fields, sku: " 21432 " },
    });
    expect(withSku.sku).toBe("21432");

    const withoutSku = toEnrichProductInput(apiReadyRecord("B"));
    expect(withoutSku).not.toHaveProperty("sku");
  });

  it("falls back to the variant sku when the product-level sku is absent", () => {
    const record = apiReadyRecord("C");
    record.fields.variant_sku = "C-CHOC-30";
    record._meta.variant = { sku: "C-CHOC-30" };
    expect(toEnrichProductInput(record).sku).toBe("C-CHOC-30");
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
    expect(exported.summary).toMatchObject({
      outputMode: "api_ready",
      completionStatus: "incomplete",
      recordsReceived: 2,
      inputsReady: 1,
      errors: 1,
    });
    expect(exported.summary.semanticCoverage).toEqual({
      form: 1,
      healthFunctions: 1,
      mainIngredients: 1,
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

  it("removes allowPartial and requires a named inventory output mode", () => {
    const records = [{ sourceUrl: "https://shop.test/a", fields: { title: "A" } }];
    expect(buildEnrichProductExport(records).errors[0].error).toBe(
      "api_ready_fields_missing:images,productForm,healthFunctions,mainIngredients,factsSourceReview,galleryReview",
    );
    expect(() => buildEnrichProductExport(records, { allowPartial: true }))
      .toThrow("allowPartial_removed_use_outputMode_inventory_partial");
    const inventory = buildEnrichProductExport(records, {
      outputMode: "inventory_partial",
    });
    expect(inventory.inputs).toHaveLength(1);
    expect(inventory.summary).toMatchObject({
      outputMode: "inventory_partial",
      completionStatus: "incomplete",
    });
  });

  it("writes partial inventory without creating API-ready product request files", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-products-partial-"));
    try {
      const output = await writeEnrichProductExport(outDir, [{
        sourceUrl: "https://shop.test/a",
        fields: { title: "A" },
      }], { outputMode: "inventory_partial" });
      expect(path.basename(output.files.inventory)).toBe("inventory-partial.json");
      expect(path.basename(output.files.semanticReviewQueue)).toBe("semantic-review-queue.json");
      expect(output.summary.inputsReady).toBe(0);
      expect(output.summary.reviewQueue).toBe(1);
      expect(JSON.parse(await fs.readFile(output.files.semanticReviewQueue, "utf8"))).toMatchObject([{
        status: "needs_model_review",
        missing: expect.arrayContaining(["form", "health_function", "main_ingredients"]),
      }]);
      await expect(fs.access(path.join(outDir, "products.json"))).rejects.toThrow();
      await expect(fs.access(path.join(outDir, "product-enrich-requests.json"))).rejects.toThrow();
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
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
        runCompletion: { status: "complete" },
      });
      expect(output.summary.inputsReady).toBe(1);
      expect(output.summary.formalArtifactsWritten).toBe(true);
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

  it("does not create formal product files until the whole run is proven complete", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-products-unfinished-"));
    try {
      await fs.writeFile(path.join(outDir, "products.json"), "stale");
      await fs.writeFile(path.join(outDir, "product-enrich-requests.json"), "stale");
      const output = await writeEnrichProductExport(outDir, [apiReadyRecord()]);
      expect(output.summary).toMatchObject({
        completionStatus: "incomplete",
        runCompletionStatus: "missing",
        formalArtifactsWritten: false,
      });
      expect(path.basename(output.files.candidates)).toBe("api-ready-candidates.json");
      await expect(fs.access(path.join(outDir, "products.json"))).rejects.toThrow();
      await expect(fs.access(path.join(outDir, "product-enrich-requests.json"))).rejects.toThrow();
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("does not create formal product files when any record fails validation", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-products-mixed-"));
    try {
      const output = await writeEnrichProductExport(outDir, [
        apiReadyRecord(),
        { sourceUrl: "https://www.example.com/products/b", fields: { title: "B" } },
      ], { runCompletion: { status: "complete" } });
      expect(output.summary).toMatchObject({
        completionStatus: "incomplete",
        runCompletionStatus: "complete",
        formalArtifactsWritten: false,
      });
      expect(output.errors).toHaveLength(1);
      await expect(fs.access(path.join(outDir, "products.json"))).rejects.toThrow();
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
