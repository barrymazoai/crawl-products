import { describe, expect, it } from "vitest";

import {
  normalizeVariantOptions,
  normalizeVariantUrl,
  variantDisplayName,
  variantIdentity,
  variantQualifiedProductName,
  withVariantState,
} from "./product-variants.mjs";

describe("product variant identity", () => {
  it("preserves explicit variant selectors while removing category and tracking noise", () => {
    expect(normalizeVariantUrl(
      "https://shop.test/products/foo?variant=42&categoryCode=summer&utm_source=x",
    )).toBe("https://shop.test/products/foo?variant=42");
  });

  it("normalizes option selections and derives a stable key", () => {
    const record = {
      fields: {
        title: "Daily Powder",
        variant_options: [
          { name: "Flavor", value: "Chocolate" },
          { name: "Size", value: "30 servings" },
        ],
      },
    };
    expect(normalizeVariantOptions(record.fields.variant_options)).toEqual([
      { name: "Flavor", value: "Chocolate" },
      { name: "Size", value: "30 servings" },
    ]);
    expect(variantIdentity(record)).toBe("options:flavor=chocolate|size=30 servings");
    expect(variantDisplayName(record)).toBe("Flavor: Chocolate / Size: 30 servings");
    expect(variantQualifiedProductName(record)).toBe(
      "Daily Powder — Flavor: Chocolate / Size: 30 servings",
    );
  });

  it("attaches a canonical URL and keeps state in raw metadata", () => {
    const record = withVariantState({
      sourceUrl: "https://shop.test/products/foo",
      fields: { title: "Foo", images: ["https://cdn.test/front.jpg"] },
    }, {
      variantId: "42",
      sku: "FOO-CHOC-30",
      optionSelections: [{ name: "Flavor", value: "Chocolate" }],
      url: "https://shop.test/products/foo?variant=42&categoryCode=x",
      isDefault: true,
    });
    expect(record.sourceUrl).toBe("https://shop.test/products/foo?variant=42");
    expect(record.fields.product_url).toBe("https://shop.test/products/foo?variant=42");
    expect(record._meta.variant).toMatchObject({
      variantId: "42",
      sku: "FOO-CHOC-30",
      isDefault: true,
      identity: "id:42",
    });
  });
});

