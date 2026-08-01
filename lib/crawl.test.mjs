import { describe, expect, it } from "vitest";

import {
  annotateRecordsFromVisualRoute,
  collectProductUrls,
  collectVerifiedCategoryUrls,
  collectRenderedDetailEvidence,
  collectRenderedInlineProductRecords,
  collectRenderedProductImageUrls,
  collectRenderedProductCardUrls,
  captureLearningPage,
  crawlSite,
  extractProductsBatch,
  fieldCoverage,
  mergeProductRecords,
  openPage,
  probeOriginalImage,
  readPageBody,
  recordNeedsRenderedImageUpgrade,
  upgradeProductImageUrls,
  upgradeProducts,
} from "./crawl.mjs";

// These cover the decisions crawl.mjs makes on its own — which products go down
// the slow path, when pagination stops, when to give up on interactive retries.
// Getting them wrong is expensive in a way tests catch cheaply: a broken stop
// condition means an unbounded crawl, and a broken upgrade split means opening
// hundreds of pages one at a time for a field the site does not have.

const FIELDS = ["title", "price"];

function productHtml(name, { price = "$19.99" } = {}) {
  return `<html><body><h1 class="product-title">${name}</h1>${
    price ? `<div class="price"><span class="money">${price}</span></div>` : ""
  }</body></html>`;
}

function productHtmlWithImages(name, imageUrls) {
  const images = imageUrls.map((url) => `<img src="${url}" alt="${name}">`).join("");
  return `<html><body><h1 class="product-title">${name}</h1><div class="price">$19.99</div><div class="product-gallery">${images}</div></body></html>`;
}

function listingHtml(productPaths, nextHref) {
  const cards = productPaths
    .map((path) => `<a class="product-card" href="${path}"><span>Item</span></a>`)
    .join("");
  const next = nextHref ? `<a class="next" rel="next" href="${nextHref}">Next</a>` : "";
  return `<html><body><div class="product-grid">${cards}</div>${next}</body></html>`;
}

/** Minimal stand-in for the Codex `tab` binding, backed by a URL -> HTML map. */
function fakeTab(pages, { onGoto } = {}) {
  let current = "about:blank";
  const visited = [];
  return {
    visited,
    async goto(url) {
      current = url;
      visited.push(url);
      onGoto?.(url);
    },
    async url() {
      return current;
    },
    playwright: {
      async waitForLoadState() {},
      async waitForTimeout() {},
      async evaluate() {
        const html = pages[current];
        if (html === undefined) throw new Error(`no fixture for ${current}`);
        return { text: html, markup: true };
      },
      locator() {
        return {
          async count() {
            return 0;
          },
          async press() {},
          first() {
            return this;
          },
          async isVisible() {
            return false;
          },
          getByRole() {
            return this;
          },
          async click() {},
        };
      },
      getByText() {
        return { async count() { return 0; }, async click() {} };
      },
    },
  };
}

/** Stand-in for `browser.tabs.content` batch loading. */
function fakeBrowser(pages, { failUrls = new Set() } = {}) {
  return {
    tabs: {
      async content({ urls }) {
        return urls.map((url) => ({
          url,
          title: null,
          content: failUrls.has(url) ? null : (pages[url] ?? null),
        }));
      },
    },
  };
}

describe("readPageBody", () => {
  it("returns raw text for JSON documents instead of Chrome's <pre> wrapper", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          // Mirrors what the real in-page function returns for /products.json.
          return { text: '{"products":[]}', markup: false };
        },
      },
    };
    const body = await readPageBody(tab);
    expect(body.markup).toBe(false);
    expect(body.text).toBe('{"products":[]}');
  });
});

describe("openPage", () => {
  it("accepts a navigation timeout when the target document actually rendered", async () => {
    const target = "https://shop.test/products/slow";
    let current = "about:blank";
    const tab = {
      async goto(url) {
        current = url;
        throw new Error("Page.navigate timed out");
      },
      async url() {
        return current;
      },
      playwright: {
        async waitForLoadState() {},
        async evaluate() {
          return { text: "<main><h1>Slow product</h1></main>", markup: true };
        },
      },
    };

    await expect(openPage(tab, target)).resolves.toMatchObject({
      url: target,
      body: "<main><h1>Slow product</h1></main>",
      navigationWarning: expect.stringContaining("timed out"),
    });
  });

  it("does not accept stale DOM when navigation failed before leaving the previous page", async () => {
    const previous = "https://shop.test/products/previous";
    const tab = {
      async goto() {
        throw new Error("navigation failed");
      },
      async url() {
        return previous;
      },
      playwright: {
        async waitForLoadState() {},
        async evaluate() {
          return { text: "<main><h1>Previous product</h1></main>", markup: true };
        },
      },
    };

    await expect(openPage(tab, "https://shop.test/products/next")).rejects.toThrow("navigation failed");
  });

  it("accepts a timed-out reload when the tab was already on the requested target", async () => {
    const target = "https://shop.test/products/slow";
    const tab = {
      async goto() {
        throw new Error("Page.navigate timed out");
      },
      async url() {
        return target;
      },
      playwright: {
        async waitForLoadState() {},
        async evaluate() {
          return { text: "<main><h1>Slow product</h1></main>", markup: true };
        },
      },
    };

    await expect(openPage(tab, target)).resolves.toMatchObject({ url: target });
  });
});

describe("extractProductsBatch", () => {
  it("keeps partial records while routing them to the upgrade path", async () => {
    const pages = {
      "https://shop.test/products/a": productHtml("Product A"),
      "https://shop.test/products/b": productHtml("Product B", { price: "" }),
    };
    const browser = fakeBrowser(pages);
    const result = await extractProductsBatch(browser, Object.keys(pages), { fields: FIELDS });

    expect(result.records).toHaveLength(2);
    expect(result.records[0].fields.title).toBe("Product A");
    expect(result.records[1].fields.title).toBe("Product B");
    expect(result.records[1].fields.price).toBeUndefined();
    expect(result.partialRecordsKept).toBe(1);
    // B has a title but no price, and price has no allow_missing policy.
    expect(result.needsUpgrade).toEqual(["https://shop.test/products/b"]);
  });

  it("does not upgrade a field the profile marks allow_missing", async () => {
    const pages = { "https://shop.test/products/b": productHtml("Product B", { price: "" }) };
    const browser = fakeBrowser(pages);
    const result = await extractProductsBatch(browser, Object.keys(pages), {
      fields: FIELDS,
      profile: {
        version: 1,
        fieldPolicy: { price: { availability: "not_present", missingBehavior: "allow_missing" } },
      },
    });
    expect(result.records).toHaveLength(1);
    expect(result.needsUpgrade).toEqual([]);
  });

  it("records pages that failed to load rather than silently dropping them", async () => {
    const url = "https://shop.test/products/a";
    const browser = fakeBrowser({}, { failUrls: new Set([url]) });
    const result = await extractProductsBatch(browser, [url], { fields: FIELDS });
    expect(result.records).toEqual([]);
    expect(result.failed).toEqual([{ url, reason: "empty_content" }]);
    expect(result.needsUpgrade).toEqual([url]);
  });

  it("sends a whole chunk to the upgrade path when batch loading throws", async () => {
    const browser = { tabs: { async content() { throw new Error("tabs unavailable"); } } };
    const urls = ["https://shop.test/products/a", "https://shop.test/products/b"];
    const result = await extractProductsBatch(browser, urls, { fields: FIELDS });
    expect(result.needsUpgrade).toEqual(urls);
  });

  it("keeps a valid single-image record while routing it to rendered gallery upgrade", async () => {
    const url = "https://shop.test/products/a";
    const pages = { [url]: productHtmlWithImages("Product A", ["/media/a-front.jpg"]) };
    const result = await extractProductsBatch(fakeBrowser(pages), [url], {
      fields: ["title", "price", "images"],
    });

    expect(result.records).toHaveLength(1);
    expect(result.needsUpgrade).toEqual([url]);
    expect(recordNeedsRenderedImageUpgrade(result.records[0], ["images"])).toBe(true);
  });
});

describe("upgradeProducts", () => {
  it("extracts from an interactively loaded page", async () => {
    const url = "https://shop.test/products/a";
    const tab = fakeTab({ [url]: productHtml("Product A") });
    const result = await upgradeProducts(tab, [url], { fields: FIELDS });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].fields.title).toBe("Product A");
  });

  it("attempts every URL when the batch path produced no usable baseline", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://shop.test/products/p${i}`);
    const pages = Object.fromEntries(urls.map((url) => [url, productHtml("P", { price: "" })]));
    const tab = fakeTab(pages);

    const result = await upgradeProducts(tab, urls, { fields: FIELDS, disableAfter: 3 });

    expect(tab.visited.length).toBe(10);
    expect(result.failed).toEqual([]);
    expect(result.records).toHaveLength(10);
  });

  it("disables only the baseline field signature that stopped improving", async () => {
    const priceUrls = Array.from({ length: 5 }, (_, i) => `https://shop.test/products/price-${i}`);
    const descriptionUrl = "https://shop.test/products/description";
    const urls = [...priceUrls, descriptionUrl];
    const pages = Object.fromEntries([
      ...priceUrls.map((url) => [url, productHtml("P", { price: "" })]),
      [descriptionUrl, productHtml("Different template")],
    ]);
    const baselineRecords = [
      ...priceUrls.map((sourceUrl) => ({
        sourceUrl,
        fields: { url: sourceUrl, title: "P" },
      })),
      {
        sourceUrl: descriptionUrl,
        fields: { url: descriptionUrl, title: "Different template", price: "$19.99" },
      },
    ];

    const result = await upgradeProducts(fakeTab(pages), urls, {
      fields: ["title", "price", "description"],
      baselineRecords,
      disableAfter: 3,
    });

    expect(result.skipped.map((entry) => entry.url)).toEqual(priceUrls.slice(3));
    expect(result.records.some((record) => record.sourceUrl === descriptionUrl)).toBe(true);
  });

  it("does not mark preserved batch records as failed when optional gallery upgrade stops", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://shop.test/products/p${i}`);
    const pages = Object.fromEntries(urls.map((url, i) => [
      url,
      productHtmlWithImages(`P${i}`, [`/media/p${i}-front.jpg`]),
    ]));
    const baselineRecords = urls.map((sourceUrl, i) => ({
      sourceUrl,
      fields: {
        title: `P${i}`,
        price: "$19.99",
        images: [`https://shop.test/media/p${i}-front.jpg`],
      },
    }));

    const result = await upgradeProducts(fakeTab(pages), urls, {
      fields: ["title", "price", "images"],
      baselineRecords,
      disableAfter: 3,
    });

    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.records).toHaveLength(3);
  });

  it("uses compact rendered field evidence when the full DOM transport is truncated", async () => {
    const url = "https://shop.test/products/iso-whey";
    let current = "about:blank";
    const tab = {
      async goto(next) {
        current = next;
      },
      async url() {
        return current;
      },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (String(fn).includes("spider-field-capture")) {
            return "<spider-field-capture><h1>Iso Whey Zero 908g</h1><span class=\"np-product__price\">€69,90</span></spider-field-capture>";
          }
          return {
            text: "<main><h1>Iso Whey Zero 908g</h1><p>908 g package</p></main>",
            markup: true,
          };
        },
        locator() {
          return {
            async count() { return 0; },
            async press() {},
            first() { return this; },
            async isVisible() { return false; },
            getByRole() { return this; },
            async click() {},
          };
        },
        getByText() {
          return { async count() { return 0; }, async click() {} };
        },
      },
    };

    const result = await upgradeProducts(tab, [url], {
      fields: ["title", "price"],
      useCdp: false,
    });

    expect(result.records[0].fields.price).toBe("€69,90");
  });
});

describe("visual-first learning", () => {
  it("uses rendered DOM without requesting CDP before a route has been learned", async () => {
    const url = "https://shop.test/products/a";
    const tab = fakeTab({ [url]: productHtml("Product A") });

    const sample = await captureLearningPage(tab, url, { fields: FIELDS });

    expect(tab.visited).toEqual([url]);
    expect(sample.record.fields.title).toBe("Product A");
    expect(sample.browserEvidence).toMatchObject({
      documentBodySource: "dom_fallback",
      capabilities: { cdp: false, pageAssets: false },
    });
  });
});

describe("collectProductUrls", () => {
  it("follows pagination and stops when it runs out of next pages", async () => {
    const pages = {
      "https://shop.test/collections/all": listingHtml(
        ["/products/a", "/products/b"],
        "/collections/all?page=2",
      ),
      "https://shop.test/collections/all?page=2": listingHtml(["/products/c"], null),
    };
    const tab = fakeTab(pages);
    const result = await collectProductUrls(tab, ["https://shop.test/collections/all"], {
      maxItems: 50,
    });
    expect(result.pagesVisited).toBe(2);
    expect(result.productUrls).toHaveLength(3);
  });

  it("replays a visually mapped Load More control on the same listing page", async () => {
    const listingUrl = "https://shop.test/collections/all";
    let current = "about:blank";
    let expanded = false;
    const tab = {
      async goto(url) { current = url; },
      async url() { return current; },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate() {
          return {
            text: listingHtml(
              expanded ? ["/products/a", "/products/b", "/products/c"] : ["/products/a", "/products/b"],
              null,
            ),
            markup: true,
          };
        },
        locator(selector) {
          if (selector === "body") {
            return {
              async count() { return 1; },
              first() { return this; },
              async press() {},
            };
          }
          expect(selector).toBe("button.load-more");
          return {
            async count() { return expanded ? 0 : 1; },
            async isVisible() { return true; },
            async click() { expanded = true; },
          };
        },
      },
    };

    const result = await collectProductUrls(tab, [listingUrl], {
      maxItems: 20,
      paginationActions: [{ action: "click", selector: "button.load-more" }],
    });

    expect(result.productUrls).toHaveLength(3);
    expect(result.pagesVisited).toBe(2);
  });

  it("stops after two consecutive pages that add nothing new", async () => {
    // A pagination loop that keeps serving the same products would otherwise
    // run until maxPagesPerSeed.
    const same = ["/products/a", "/products/b"];
    const pages = {
      "https://shop.test/c": listingHtml(same, "/c?page=2"),
      "https://shop.test/c?page=2": listingHtml(same, "/c?page=3"),
      "https://shop.test/c?page=3": listingHtml(same, "/c?page=4"),
      "https://shop.test/c?page=4": listingHtml(same, "/c?page=5"),
    };
    const tab = fakeTab(pages);
    const result = await collectProductUrls(tab, ["https://shop.test/c"], { maxItems: 50 });
    expect(result.pagesVisited).toBe(3);
    expect(result.productUrls).toHaveLength(2);
  });

  it("honours maxItems", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/products/p${i}`);
    const pages = { "https://shop.test/c": listingHtml(paths, null) };
    const tab = fakeTab(pages);
    const result = await collectProductUrls(tab, ["https://shop.test/c"], { maxItems: 4 });
    expect(result.productUrls).toHaveLength(4);
  });

  it("keeps going to the next seed when one listing page fails to load", async () => {
    const pages = { "https://shop.test/good": listingHtml(["/products/a"], null) };
    const tab = fakeTab(pages);
    const result = await collectProductUrls(
      tab,
      ["https://shop.test/missing", "https://shop.test/good"],
      { maxItems: 50 },
    );
    expect(result.productUrls).toHaveLength(1);
  });

  it("keeps products embedded in one catalog page when there are no detail links", async () => {
    const listingUrl = "https://shop.test/products";
    let current = "about:blank";
    const inlineCandidates = [
      {
        title: "Alpha Eye Drops 10 mL",
        description: "Fast relief for itchy eyes.",
        text: "Alpha Eye Drops 10 mL BUY NOW",
        images: ["/media/alpha-front.png"],
        action: true,
      },
      {
        title: "Alpha Twin Pack 2 x 10 mL",
        description: "Two bottles for allergy season.",
        text: "Alpha Twin Pack 2 x 10 mL BUY NOW",
        images: ["/media/twin-front.png"],
        action: true,
      },
    ];
    const tab = {
      async goto(url) { current = url; },
      async url() { return current; },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (String(fn).includes("semanticSelector")) return inlineCandidates;
          return { text: "<main><h1>Our products</h1></main>", markup: true };
        },
        locator() {
          return {
            async count() { return 0; },
            first() { return this; },
            async press() {},
            async isVisible() { return false; },
            getByRole() { return this; },
            async click() {},
          };
        },
      },
    };

    const result = await collectProductUrls(tab, [listingUrl], { maxItems: 10 });
    expect(result.productUrls).toEqual([]);
    expect(result.inlineRecords).toHaveLength(2);
    expect(result.inlineRecords[0].fields.title).toBe("Alpha Eye Drops 10 mL");
  });

  it("collects verified external detail links without recursing the merchant catalog", async () => {
    const listingUrl = "https://brand.test/produkty";
    let current = "about:blank";
    const tab = {
      async goto(url) { current = url; },
      async url() { return current; },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (String(fn).includes("pageSelectors")) {
            return [
              {
                href: "https://merchant.test/arthr-boswellia-180-tablet/",
                text: "Koupit",
                className: "productBuyBtn",
              },
            ];
          }
          if (String(fn).includes("semanticSelector")) return [];
          return { text: "<main><h1>Produkty</h1></main>", markup: true };
        },
        locator() {
          return {
            async count() { return 0; },
            first() { return this; },
            async press() {},
            async isVisible() { return false; },
            getByRole() { return this; },
            async click() {},
          };
        },
      },
    };

    const result = await collectProductUrls(tab, [listingUrl], {
      maxItems: 10,
      followVerifiedExternalProductLinks: true,
    });
    expect(result.productUrls).toEqual([
      "https://merchant.test/arthr-boswellia-180-tablet/",
    ]);
    expect(result.externalProductUrlsFound).toBe(1);
    expect(result.storefrontOrigins).toEqual(["https://merchant.test"]);
  });
});

describe("discovery fallbacks and profile replay", () => {
  it("requires at least two unique inline products before treating a long page as a catalog", async () => {
    const candidates = [{
      title: "One promotional feature",
      description: "",
      text: "One promotional feature LEARN MORE",
      images: ["/media/feature.png"],
      action: true,
    }];
    const tab = {
      playwright: {
        async evaluate() { return candidates; },
      },
    };
    await expect(collectRenderedInlineProductRecords(
      tab,
      "https://shop.test/landing",
    )).resolves.toEqual([]);
  });

  it("accepts semantic product cards even when the URL has no product keyword", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          return [
            {
              href: "https://shop.test/marcas/essential-series/vitamin-b12",
              text: "Vitamin B12",
              className: "product-item-link",
            },
            {
              href: "https://shop.test/cart",
              text: "Cart",
              className: "product-item-link",
            },
            {
              href: "https://marketplace.test/item/123",
              text: "Marketplace",
              className: "product-item-link",
            },
          ];
        },
      },
    };
    await expect(collectRenderedProductCardUrls(
      tab,
      "https://shop.test/nutricion",
    )).resolves.toEqual([
      "https://shop.test/marcas/essential-series/vitamin-b12",
    ]);
  });

  it("follows exact external product-card links only when explicitly enabled", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          return [
            {
              href: "https://merchant.test/arthr-boswellia-180-tablet/",
              text: "Koupit",
              className: "productBuyBtn",
            },
            {
              href: "https://merchant.test/znacka/nutricius/",
              text: "Koupit",
              className: "productBuyBtn",
            },
            {
              href: "https://www.amazon.com/example",
              text: "Buy",
              className: "productBuyBtn",
            },
          ];
        },
      },
    };

    await expect(collectRenderedProductCardUrls(
      tab,
      "https://brand.test/produkty",
    )).resolves.toEqual([]);
    await expect(collectRenderedProductCardUrls(
      tab,
      "https://brand.test/produkty",
      { followVerifiedExternalProductLinks: true },
    )).resolves.toEqual([
      "https://merchant.test/arthr-boswellia-180-tablet/",
    ]);
  });

  it("expands only the sibling categories mapped by the visual route", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          return [
            {
              href: "https://shop.test/nutricion-deportiva",
              text: "Nutrición deportiva",
              className: "level-0",
            },
            {
              href: "https://shop.test/contacto",
              text: "Contacto",
              className: "level-0",
            },
            {
              href: "https://shop.test/produkty",
              text: "Produkty",
              className: "",
            },
          ];
        },
      },
    };
    await expect(collectVerifiedCategoryUrls(
      tab,
      "https://shop.test",
      {
        categoryLinkSelectors: ["header a.level-0"],
        verifiedListingSeeds: ["https://shop.test/nutricion-deportiva"],
      },
    )).resolves.toEqual([
      "https://shop.test/nutricion-deportiva",
      "https://shop.test/produkty",
    ]);
  });

  it("keeps Next.js image proxies in inline product records", async () => {
    const candidates = [
      {
        title: "Arthr Boswellia 180 tablet",
        description: "Boswellia supplement.",
        text: "Arthr Boswellia 180 tablet 299 Kč Koupit",
        images: [
          "https://brand.test/_next/image?url=%2Fassets%2Fproducts%2Farthr.png&w=640&q=75",
        ],
        semantic: true,
        action: true,
      },
      {
        title: "Biotin 300 mcg 90 tablet",
        description: "Biotin supplement.",
        text: "Biotin 300 mcg 90 tablet 199 Kč Koupit",
        images: [
          "https://brand.test/_next/image?url=%2Fassets%2Fproducts%2Fbiotin.png&w=640&q=75",
        ],
        semantic: true,
        action: true,
      },
    ];
    const tab = {
      playwright: {
        async evaluate() {
          return candidates;
        },
      },
    };

    const records = await collectRenderedInlineProductRecords(
      tab,
      "https://brand.test/produkty",
    );
    expect(records).toHaveLength(2);
    expect(records[0].fields.images[0]).toContain("/_next/image?");
  });

  it("refuses an unknown site instead of running automatic discovery", async () => {
    const startUrl = "https://parent.test";
    const tab = fakeTab({ [startUrl]: "<main><h1>Parent Company</h1></main>" });
    const browser = fakeBrowser({});

    await expect(crawlSite(browser, tab, startUrl, {
      fields: FIELDS,
      resolveOriginalImages: false,
    })).rejects.toThrow("visual_route_required_before_crawl");
    expect(tab.visited).toEqual([]);
  });

  it("refuses to expand a direct brand into a second portfolio layer", async () => {
    const startUrl = "https://brand-a.test";
    const tab = fakeTab({});
    const browser = fakeBrowser({});

    await expect(crawlSite(browser, tab, startUrl, {
      fields: FIELDS,
      portfolioDepth: 1,
      resolveOriginalImages: false,
      visualRoute: {
        version: 3,
        status: "mapped",
        targetRole: "detail",
        requestedFields: FIELDS,
        steps: [{
          pageRole: "portfolio",
          url: startUrl,
          action: {
            text: "Sub-brand",
            targetUrl: "https://subbrand.test",
            relationType: "portfolio_brand_site",
          },
        }],
        fieldJourney: {
          status: "mapped",
          fields: [],
        },
      },
    })).rejects.toMatchObject({
      code: "portfolio_depth_exceeded",
      maxDepth: 1,
    });
    expect(tab.visited).toEqual([]);
  });

  it("crawls every listing seed captured by mapped catalog coverage", async () => {
    const startUrl = "https://shop.test";
    const nutritionUrl = "https://shop.test/nutrition";
    const proteinUrl = "https://shop.test/protein";
    const productA = "https://shop.test/products/a";
    const productB = "https://shop.test/products/b";
    const listingPages = {
      [nutritionUrl]: listingHtml(["/products/a"], null),
      [proteinUrl]: listingHtml(["/products/b"], null),
    };
    let current = "about:blank";
    const tab = {
      visited: [],
      async goto(url) { current = url; this.visited.push(url); },
      async url() { return current; },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (String(fn).includes("pageSelectors")) {
            return current === nutritionUrl
              ? [{ href: productA, text: "Product A", className: "product-card" }]
              : [{ href: productB, text: "Product B", className: "product-card" }];
          }
          return { text: listingPages[current], markup: true };
        },
        locator() {
          return {
            async count() { return 0; },
            first() { return this; },
            async press() {},
          };
        },
      },
    };
    const browser = fakeBrowser({
      [productA]: productHtml("Product A"),
      [productB]: productHtml("Product B"),
    });
    const quality = (tagName, textLength) => ({
      valid: true,
      score: 12,
      tagName,
      selectorCount: 1,
      textLength,
      imageCount: 0,
      videoCount: 0,
      semanticSignals: [],
      reasons: [],
    });

    const result = await crawlSite(browser, tab, startUrl, {
      fields: FIELDS,
      maxItems: 10,
      productScope: "all_products",
      resolveOriginalImages: false,
      listingProfile: {
        productLinkSelectors: ["a.product-card"],
      },
      visualRoute: {
        status: "mapped",
        targetRole: "detail",
        requestedFields: FIELDS,
        steps: [{
          pageRole: "listing",
          url: nutritionUrl,
          action: {
            actionKind: "product_entry",
            text: "Product A",
            targetUrl: productA,
            selector: "a[href='/products/a']",
            generalSelector: "a.product-card",
            generalSelectorSource: "repeated_ancestor",
          },
        }, {
          pageRole: "detail",
          url: productA,
        }],
        catalogCoverage: {
          status: "mapped",
          listingSeeds: [nutritionUrl, proteinUrl],
          families: [],
        },
        fieldJourney: {
          status: "mapped",
          pageUrl: productA,
          fields: [{
            field: "title",
            availability: "present_visible",
            targetSelector: "h1.product-title",
            quality: quality("h1", 9),
          }, {
            field: "price",
            availability: "present_visible",
            targetSelector: ".price",
            quality: quality("span", 6),
          }],
        },
      },
    });

    expect(result.records).toHaveLength(2);
    expect(result.stats.listingSeeds).toBe(2);
    expect(tab.visited).toEqual([nutritionUrl, proteinUrl]);
  });

  it("replays stored listing rules without rediscovering the homepage", async () => {
    const startUrl = "https://shop.test";
    const listingUrl = "https://shop.test/collections/all";
    const productUrl = "https://shop.test/products/a";
    const tab = fakeTab({
      [listingUrl]: listingHtml(["/products/a"], null),
    });
    const browser = fakeBrowser({
      [productUrl]: productHtml("Product A"),
    });
    const siteProfile = {
      version: 4,
      kind: "crawl-products-site-profile",
      site: { startUrl, origin: startUrl, hostname: "shop.test" },
      fields: FIELDS,
      discovery: {
        strategy: "visual_route",
        listingSeeds: [listingUrl],
        storefrontOrigins: [startUrl],
        sampleProductUrl: productUrl,
      },
      visualRoute: {
        version: 3,
        status: "mapped",
        targetRole: "detail",
        requestedFields: FIELDS,
        steps: [{
          pageRole: "listing",
          url: listingUrl,
          action: {
            text: "Product A",
            targetUrl: productUrl,
            generalSelector: ".product-card",
          },
        }, {
          pageRole: "detail",
          url: productUrl,
        }],
        fieldJourney: {
          status: "mapped",
          pageUrl: productUrl,
          fields: [{
            field: "title",
            availability: "present_visible",
            targetSelector: "h1.product-title",
            quality: {
              valid: true,
              score: 12,
              tagName: "h1",
              selectorCount: 1,
              textLength: 9,
              imageCount: 0,
              videoCount: 0,
              semanticSignals: ["heading"],
              reasons: [],
            },
          }, {
            field: "price",
            availability: "present_visible",
            targetSelector: ".price",
            quality: {
              valid: true,
              score: 12,
              tagName: "span",
              selectorCount: 1,
              textLength: 6,
              imageCount: 0,
              videoCount: 0,
              semanticSignals: ["price_marker"],
              reasons: [],
            },
          }],
        },
      },
      detailProfile: null,
      imageProfile: null,
    };

    const result = await crawlSite(browser, tab, startUrl, {
      fields: FIELDS,
      maxItems: 10,
      productScope: "all_products",
      siteProfile,
      resolveOriginalImages: false,
    });

    expect(result.stats.profile.replayed).toBe(true);
    expect(result.stats.profile.visualRouteReused).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(tab.visited).toEqual([listingUrl]);
  });
});

describe("fieldCoverage", () => {
  it("reports per-field fill rates", () => {
    const records = [
      { fields: { title: "A", price: "$1", images: ["x"] } },
      { fields: { title: "B", price: "", images: [] } },
    ];
    expect(fieldCoverage(records, ["title", "price", "images"])).toEqual({
      title: 1,
      price: 0.5,
      images: 0.5,
    });
  });

  it("reports zero coverage rather than dividing by zero", () => {
    expect(fieldCoverage([], ["title"])).toEqual({ title: 0 });
  });
});

describe("rendered gallery recovery", () => {
  it("returns a compact field projection from the live DOM", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          return "<spider-field-capture><span class=\"price\">€69,90</span></spider-field-capture>";
        },
      },
    };

    await expect(collectRenderedDetailEvidence(tab)).resolves.toContain("€69,90");
  });

  it("normalizes and deduplicates a compact rendered-DOM gallery projection", async () => {
    const tab = {
      playwright: {
        async evaluate() {
          return [
            "/media/catalog/product/cache/abc1234567890123/a/front.jpg",
            "/media/catalog/product/cache/abc1234567890123/a/front.jpg",
            "/media/catalog/product/cache/abc1234567890123/a/back.webp",
            "/static/logo.png",
          ];
        },
      },
    };

    await expect(collectRenderedProductImageUrls(tab, "https://shop.test/products/a")).resolves.toEqual([
      "https://shop.test/media/catalog/product/cache/abc1234567890123/a/front.jpg",
      "https://shop.test/media/catalog/product/cache/abc1234567890123/a/back.webp",
    ]);
  });

  it("deduplicates rendered resize-proxy variants by their underlying image", async () => {
    const firstLarge =
      "https://shop.test/inc/thumb.php?w=1000&h=1000&img=http%3A%2F%2Fcdn.test%2Fproduct-1.jpg";
    const firstThumb =
      "https://shop.test/inc/thumb.php?w=100&h=100&img=http%3A%2F%2Fcdn.test%2Fproduct-1.jpg";
    const secondLarge =
      "https://shop.test/inc/thumb.php?w=1000&h=1000&img=http%3A%2F%2Fcdn.test%2Fproduct-2.jpg";
    const tab = {
      playwright: {
        async evaluate() {
          return [firstLarge, firstThumb, secondLarge];
        },
      },
    };

    await expect(collectRenderedProductImageUrls(
      tab,
      "https://shop.test/products/product",
    )).resolves.toEqual([firstLarge, secondLarge]);
  });

  it("merges batch and rendered variants without duplicating the product", () => {
    const sourceUrl = "https://shop.test/products/a";
    const merged = mergeProductRecords([
      { sourceUrl, fields: { title: "A", images: ["https://cdn.test/a-front.jpg?width=400"] } },
      {
        sourceUrl,
        fields: {
          title: "A",
          description: "Details",
          images: [
            "https://cdn.test/a-front.jpg?width=400",
            "https://cdn.test/a-back.jpg?width=400",
          ],
        },
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].fields.description).toBe("Details");
    expect(merged[0].fields.images).toHaveLength(2);
  });

  it("keeps conflicting prices attributable instead of silently overwriting them", () => {
    const sourceUrl = "https://store.test/products/a";
    const merged = mergeProductRecords([
      {
        sourceUrl,
        fields: { title: "A", price: "492 Kč" },
        _meta: { layer: "brand-listing" },
      },
      {
        sourceUrl,
        fields: { title: "A", price: "370 Kč" },
        _meta: { layer: "external-detail" },
      },
    ]);

    expect(merged[0].fields.price).toBe("492 Kč");
    expect(merged[0]._meta.fieldConflicts.price).toEqual([
      expect.objectContaining({ value: "492 Kč", layer: "brand-listing" }),
      expect.objectContaining({ value: "370 Kč", layer: "external-detail" }),
    ]);
  });

  it("annotates external product fields with the verified route relation", () => {
    const records = annotateRecordsFromVisualRoute([{
      sourceUrl: "https://store.test/products/a",
      fields: { title: "A", price: "370 Kč" },
      _meta: { layer: "detail-profile" },
    }], "https://brand.test/products", {
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title", "price"],
      steps: [{
        pageRole: "listing",
        url: "https://brand.test/products",
        action: {
          targetUrl: "https://store.test/products/a",
          relationType: "external_product_detail",
          selector: "a.product",
        },
      }, {
        pageRole: "detail",
        url: "https://store.test/products/a",
      }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "h1",
          quality: {
            valid: true,
            score: 10,
            selectorCount: 1,
            textLength: 1,
            imageCount: 0,
            videoCount: 0,
            semanticSignals: ["heading"],
            reasons: [],
          },
        }, {
          field: "price",
          availability: "present_visible",
          targetSelector: ".price",
          quality: {
            valid: true,
            score: 10,
            selectorCount: 1,
            textLength: 6,
            imageCount: 0,
            videoCount: 0,
            semanticSignals: ["price_marker"],
            reasons: [],
          },
        }],
      },
    });

    expect(records[0]._meta).toMatchObject({
      sourceOrigin: "https://store.test",
      routeStartOrigin: "https://brand.test",
      relationType: "external_product_detail",
      fieldSources: {
        price: [expect.objectContaining({
          sourceOrigin: "https://store.test",
          relationType: "external_product_detail",
        })],
      },
    });
  });
});

describe("original image resolution", () => {
  function imageProbeTab(fixtures) {
    let current = "about:blank";
    return {
      visited: [],
      async goto(url) {
        current = url;
        this.visited.push(url);
      },
      playwright: {
        async waitForLoadState() {},
        async evaluate() {
          const fixture = fixtures[current];
          if (!fixture) throw new Error(`no image fixture for ${current}`);
          return fixture;
        },
      },
    };
  }

  it("accepts a sufficiently large image document", async () => {
    const url = "https://shop.test/media/catalog/product/a/item.jpg";
    const tab = imageProbeTab({
      [url]: { contentType: "image/jpeg", width: 1610, height: 1610 },
    });
    await expect(probeOriginalImage(tab, url)).resolves.toMatchObject({ ok: true, width: 1610 });
  });

  it("accepts an image that rendered even when navigation reported a timeout", async () => {
    const tab = {
      async goto() {
        throw new Error("Page.navigate timed out");
      },
      playwright: {
        async waitForLoadState() {},
        async evaluate() {
          return { contentType: "image/webp", width: 1610, height: 1610 };
        },
      },
    };

    await expect(probeOriginalImage(tab, "https://cdn.test/original.webp")).resolves.toMatchObject({
      ok: true,
      width: 1610,
    });
  });

  it("upgrades approved platform groups and keeps rejected groups as fallback", async () => {
    const magentoSource =
      "https://shop.test/media/catalog/product/cache/5a15c5988afb4929a2501169a37460ec/a/item.jpg";
    const magentoOriginal = "https://shop.test/media/catalog/product/a/item.jpg";
    const shopifySource = "https://cdn.shopify.com/s/files/1/items/b.jpg?width=400";
    const shopifyOriginal = "https://cdn.shopify.com/s/files/1/items/b.jpg";
    const records = [{
      sourceUrl: "https://shop.test/product/a",
      fields: { images: [magentoSource, shopifySource] },
    }];
    const tab = imageProbeTab({
      [magentoOriginal]: { contentType: "image/jpeg", width: 1610, height: 1610 },
      [shopifyOriginal]: { contentType: "image/jpeg", width: 400, height: 400 },
    });

    const stats = await upgradeProductImageUrls(tab, records);

    expect(records[0].fields.images).toEqual([magentoOriginal, shopifySource]);
    expect(stats).toMatchObject({
      candidateCount: 2,
      groupsApproved: 1,
      groupsRejected: 1,
      imagesUpgraded: 1,
      byResolver: { magento_catalog_cache: 1 },
    });
  });

  it("validates and unwraps a Next.js image proxy before replacing it", async () => {
    const source =
      "https://brand.test/_next/image?url=%2Fassets%2Fproducts%2Farthr.png&w=640&q=75";
    const original = "https://brand.test/assets/products/arthr.png";
    const records = [{
      sourceUrl: "https://brand.test/produkty#inline-product=arthr",
      fields: { images: [source] },
    }];
    const tab = imageProbeTab({
      [original]: { contentType: "image/png", width: 1200, height: 1200 },
    });

    const stats = await upgradeProductImageUrls(tab, records);

    expect(records[0].fields.images).toEqual([original]);
    expect(stats).toMatchObject({
      candidateCount: 1,
      groupsApproved: 1,
      imagesUpgraded: 1,
      byResolver: { next_image_proxy: 1 },
    });
  });
});
