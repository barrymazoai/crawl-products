import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createShopifyHarvestHooks,
  fetchAllShopifyProducts,
  shopifyProductToRecord,
} from "./shopify-http.mjs";
import { runHarvest } from "./run-harvest.mjs";
import { verifyRunArtifacts } from "./verify-run-artifacts.mjs";

const tmpDirs = [];
async function makeOutDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shopify-http-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length > 0) await fs.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function product(handle, title, variants) {
  return {
    id: handle.length,
    handle,
    title,
    body_html: `<p>Supports wellbeing. <strong>${title}</strong></p>`,
    product_type: "Capsules",
    tags: ["wellness"],
    options: [{ name: "Size", position: 1, values: variants.map((v) => v.option1) }],
    images: [{ src: `https://cdn.test/${handle}.jpg`, width: 800, height: 800, position: 1 }],
    variants: variants.map((v) => ({
      id: v.id, title: v.option1, option1: v.option1, sku: v.sku,
      price: v.price, available: v.available ?? true,
    })),
  };
}

// A paged fake of /products.json?limit=N&page=P
function fakeCatalog(products, pageSize = 250) {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get("page") || "1");
    const limit = Number(new URL(url).searchParams.get("limit") || pageSize);
    const slice = products.slice((page - 1) * limit, page * limit);
    return { products: slice };
  };
}

describe("shopifyProductToRecord", () => {
  it("maps handle/title/description/images and category without leaking raw product", () => {
    const rec = shopifyProductToRecord(
      product("alpha", "Alpha", [{ id: 1, option1: "60ct", sku: "A-60", price: "11.90" }]),
      "https://shop.test",
    );
    expect(rec.sourceUrl).toBe("https://shop.test/products/alpha");
    expect(rec.fields.title).toBe("Alpha");
    expect(rec.fields.description).toContain("Supports wellbeing");
    expect(rec.fields.images).toEqual(["https://cdn.test/alpha.jpg"]);
    expect(rec.fields.category).toEqual(["Capsules", "wellness"]);
    expect(rec).not.toHaveProperty("_shopifyProduct");
  });
});

describe("fetchAllShopifyProducts paging", () => {
  it("pages until a short page and does not mark truncated", async () => {
    const products = Array.from({ length: 30 }, (_, i) =>
      product(`p${i}`, `P${i}`, [{ id: i, option1: "1ct", sku: `P${i}`, price: "9.99" }]));
    const out = await fetchAllShopifyProducts("shop.test", {
      fetchJson: fakeCatalog(products, 25), pageSize: 25,
    });
    expect(out.products).toHaveLength(30);
    expect(out.truncated).toBe(false);
  });

  it("flags truncated when the page ceiling is hit", async () => {
    const products = Array.from({ length: 20 }, (_, i) =>
      product(`p${i}`, `P${i}`, [{ id: i, option1: "1ct", sku: `P${i}`, price: "9.99" }]));
    const out = await fetchAllShopifyProducts("shop.test", {
      fetchJson: fakeCatalog(products, 10), pageSize: 10, maxPages: 2,
    });
    expect(out.products).toHaveLength(20);
    expect(out.truncated).toBe(true);
  });
});

describe("createShopifyHarvestHooks driving runHarvest with no browser", () => {
  function plan(oracleExpected) {
    return {
      site: { origin: "https://shop.test", entryUrl: "https://shop.test/", browserMode: "iab" },
      decision: { kind: "storefront", evidence: ["screenshot:entry.png"] },
      route: {
        listingSeeds: [{ url: "https://shop.test/products.json", paginationMode: "none" }],
        detailProfile: { fields: {} },
      },
      termination: {
        perSeed: [{ url: "https://shop.test/products.json", exhaustionSignal: "single_page_confirmed" }],
        oracles: oracleExpected
          ? [{ type: "shopify_products_json", expected: oracleExpected, source: "products.json" }]
          : [],
      },
    };
  }

  it("harvests the full catalog with variants/sku/price and passes Tier 1 audit", async () => {
    const outDir = await makeOutDir();
    const products = [
      product("alpha", "Alpha", [
        { id: 11, option1: "60ct", sku: "A-60", price: "11.90", available: false },
        { id: 12, option1: "120ct", sku: "A-120", price: "19.90", available: true },
      ]),
      product("beta", "Beta", [{ id: 21, option1: "30ct", sku: "B-30", price: "9.00" }]),
    ];
    const built = await createShopifyHarvestHooks("shop.test", {
      fetchJson: fakeCatalog(products),
    });
    built.hooks.fetchImage = async () => ({ bytes: Buffer.from("img"), mime: "image/jpeg" });

    expect(built.origin).toBe("https://shop.test");
    expect(built.productCount).toBe(2);

    const result = await runHarvest(null, null, plan(2), {
      outDir,
      hooks: built.hooks,
    });
    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ discovered: 2, complete: 2, remaining: 0 });

    const packages = JSON.parse(
      await fs.readFile(path.join(outDir, "evidence/records.json"), "utf8"),
    );
    const alpha = packages.find((p) => p.productUrl.endsWith("/alpha"));
    expect(alpha.variants).toHaveLength(2);
    expect(alpha.fields.sku).toBe("A-120");    // default = first available variant
    expect(alpha.fields.price).toBe("19.90");
    expect(alpha.variants[0]).toMatchObject({ sku: "A-60", options: { Size: "60ct" } });

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
  });

  it("stays incomplete when the catalog was truncated at the page ceiling", async () => {
    const outDir = await makeOutDir();
    const products = Array.from({ length: 6 }, (_, i) =>
      product(`p${i}`, `P${i}`, [{ id: i, option1: "1ct", sku: `P${i}`, price: "5.00" }]));
    const built = await createShopifyHarvestHooks("shop.test", {
      fetchJson: fakeCatalog(products, 3), pageSize: 3, maxPages: 2,
    });
    built.hooks.fetchImage = async () => ({ bytes: Buffer.from("img"), mime: "image/jpeg" });
    const result = await runHarvest(null, null, plan(), { outDir, hooks: built.hooks });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("shopify_page_ceiling_reached");
  });
});
