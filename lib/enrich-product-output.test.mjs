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
      "confirmed Facts images require a visual_complete main ingredient review",
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
        },
        main_ingredients: [],
      },
    }, { domain: "example.com" });
    expect(input.mainIngredients).toEqual([]);
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
          main_ingredients: ["Vitamin C"],
          gallery_review: {
            status: "visual_complete",
            reviewed_image_urls: ["https://cdn.test/a.jpg"],
          },
        },
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
      mainIngredients: ["Vitamin C"],
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
      "api_ready_fields_missing:images,productForm,healthFunctions,mainIngredients,galleryReview",
    );
    expect(buildEnrichProductExport(records, { allowPartial: true }).inputs).toHaveLength(1);
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
          main_ingredients: ["Vitamin C"],
          gallery_review: {
            status: "visual_complete",
            reviewed_image_urls: ["https://cdn.test/a-front.jpg"],
          },
        },
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
