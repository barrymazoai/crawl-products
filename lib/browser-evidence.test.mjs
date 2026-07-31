import { describe, expect, it, vi } from "vitest";

import {
  bundleObservedProductAssets,
  captureBrowserActionEvidence,
  captureBrowserEvidence,
  extractResponseImageCandidates,
  selectProductImagesFromEvidence,
} from "./browser-evidence.mjs";

describe("CDP/browser evidence", () => {
  it("extracts tiered gallery URLs from a complete document response", () => {
    const html = `
      <script>
        [{"thumb":"https:\\/\\/shop.test\\/cache\\/thumb\\/a-front.webp",
          "img":"https:\\/\\/shop.test\\/cache\\/display\\/a-front.webp",
          "full":"https:\\/\\/shop.test\\/cache\\/full\\/a-front.webp"},
         {"full":"https:\\/\\/shop.test\\/cache\\/full\\/b-front.webp"}]
      </script>
    `;
    const candidates = extractResponseImageCandidates(html, "https://shop.test/products/a");
    expect(candidates.filter((candidate) => candidate.tier === 3).map((candidate) => candidate.url))
      .toEqual([
        "https://shop.test/cache/full/a-front.webp",
        "https://shop.test/cache/full/b-front.webp",
      ]);
  });

  it("binds full-size candidates to the currently rendered variant", () => {
    const responseCandidates = extractResponseImageCandidates(`
      {"full":"https://shop.test/media/cache/full/a-150g-front.webp"}
      {"full":"https://shop.test/media/cache/full/a-150g-label.webp"}
      {"full":"https://shop.test/media/cache/full/a-1kg-front.webp"}
    `, "https://shop.test/products/a");
    const selected = selectProductImagesFromEvidence({
      baseUrl: "https://shop.test/products/a",
      renderedImages: [
        "https://shop.test/media/cache/thumb/a-150g-front.webp",
        "https://shop.test/media/cache/thumb/a-150g-label.webp",
      ],
      responseCandidates,
    });
    expect(selected).toEqual([
      "https://shop.test/media/cache/full/a-150g-front.webp",
      "https://shop.test/media/cache/full/a-150g-label.webp",
    ]);
  });

  it("captures requests triggered by a visually learned click during replay", async () => {
    let currentUrl = "https://shop.test/catalog";
    let reads = 0;
    const cdp = {
      async send() {
        return {};
      },
      async readEvents() {
        reads += 1;
        if (reads === 1) return { cursor: 10, events: [], hasMore: false, truncated: false };
        return {
          cursor: 12,
          hasMore: false,
          truncated: false,
          events: [{
            method: "Network.responseReceived",
            sequence: 11,
            params: {
              requestId: "xhr-1",
              type: "XHR",
              response: {
                url: "https://shop.test/api/product/a",
                status: 200,
                mimeType: "application/json",
              },
            },
          }],
        };
      },
    };
    const tab = {
      async url() {
        return currentUrl;
      },
      capabilities: {
        async list() {
          return [{ id: "cdp" }];
        },
        async get() {
          return cdp;
        },
      },
      playwright: {
        async waitForLoadState() {},
        async waitForTimeout() {},
        async evaluate(fn) {
          if (String(fn).includes("rootSelectors")) return [];
          return "<html><body><h1>Product A</h1></body></html>";
        },
      },
    };

    const evidence = await captureBrowserActionEvidence(tab, async () => {
      currentUrl = "https://shop.test/products/a";
    });

    expect(evidence.url).toBe("https://shop.test/products/a");
    expect(evidence.network.responses).toEqual([{
      requestId: "xhr-1",
      url: "https://shop.test/api/product/a",
      status: 200,
      mimeType: "application/json",
      type: "XHR",
      fromDiskCache: false,
      fromServiceWorker: false,
    }]);
    expect(evidence.documentBodySource).toBe("dom_fallback");
  });

  it("reads the complete Document response and page asset inventory through advertised capabilities", async () => {
    let currentUrl = "https://shop.test/collections/all";
    let eventRead = 0;
    const cdp = {
      async send(method, params) {
        if (method === "Network.getResponseBody") {
          if (params?.requestId === "xhr-1") {
            return {
              body: `{"product":{"ingredients":"Water, Cocoa"}}`,
              base64Encoded: false,
            };
          }
          return {
            body: `{"full":"https://shop.test/media/full/a-front.webp"}`,
            base64Encoded: false,
          };
        }
        return {};
      },
      async readEvents() {
        eventRead += 1;
        if (eventRead === 1) return { cursor: 10, events: [], hasMore: false, truncated: false };
        return {
          cursor: 20,
          hasMore: false,
          truncated: false,
          events: [
            {
              method: "Network.responseReceived",
              sequence: 11,
              params: {
                requestId: "doc-1",
                type: "Document",
                response: {
                  url: "https://shop.test/products/a",
                  status: 200,
                  mimeType: "text/html",
                },
              },
            },
            {
              method: "Network.responseReceived",
              sequence: 12,
              params: {
                requestId: "xhr-1",
                type: "XHR",
                response: {
                  url: "https://shop.test/api/product/a",
                  status: 200,
                  mimeType: "application/json",
                },
              },
            },
          ],
        };
      },
    };
    const pageAssets = {
      async list() {
        return {
          id: "inventory-1",
          assets: [{
            id: "image-1",
            kind: "image",
            name: "a-front.webp",
            url: "https://shop.test/media/thumb/a-front.webp",
            sources: [],
          }],
          inlineSvgs: [],
          pageUrl: currentUrl,
          summary: { byKind: { image: 1 }, inlineSvgCount: 0, totalCount: 1 },
        };
      },
      async bundle(options) {
        return {
          assets: options.assetIds.map((id) => ({ id, path: `/tmp/${id}.webp` })),
          directoryPath: "/tmp/assets",
          failures: [],
          manifestPath: "/tmp/assets/manifest.json",
          summary: {
            requestedCount: options.assetIds.length,
            downloadedCount: options.assetIds.length,
            failedCount: 0,
            elapsedMs: 1,
          },
        };
      },
    };
    const tab = {
      async url() {
        return currentUrl;
      },
      async goto(url) {
        currentUrl = url;
      },
      capabilities: {
        async list() {
          return [{ id: "cdp" }, { id: "pageAssets" }];
        },
        async get(id) {
          return id === "cdp" ? cdp : pageAssets;
        },
      },
      playwright: {
        async evaluate() {
          return ["https://shop.test/media/thumb/a-front.webp"];
        },
      },
    };

    const evidence = await captureBrowserEvidence(tab, "https://shop.test/products/a", {
      cdpProfile: {
        responseRules: [{
          name: "product-api",
          urlIncludes: "/api/product/",
          resourceTypes: ["XHR"],
        }],
      },
    });
    expect(evidence.documentBodySource).toBe("cdp_response");
    expect(evidence.htmlBytes).toBeGreaterThan(20);
    expect(evidence.capabilities).toEqual({ cdp: true, pageAssets: true });
    expect(evidence.productImages).toEqual(["https://shop.test/media/full/a-front.webp"]);
    expect(evidence.network.responseCount).toBe(2);
    expect(evidence.network.responseBodies).toEqual([{
      name: "product-api",
      url: "https://shop.test/api/product/a",
      type: "XHR",
      mimeType: "application/json",
      status: 200,
      body: `{"product":{"ingredients":"Water, Cocoa"}}`,
      bodyBytes: 42,
      truncated: false,
    }]);
    expect(evidence.assets.productAssetIds).toEqual(["image-1"]);
    const bundled = await bundleObservedProductAssets(tab, evidence);
    expect(bundled.summary.downloadedCount).toBe(1);
  });

  it("bounds a hanging pageAssets capability and reports the timeout", async () => {
    const waitForLoadState = vi.fn();
    const waitForTimeout = vi.fn(async () => {});
    const tab = {
      async url() {
        return "https://shop.test/products/a";
      },
      capabilities: {
        async list() {
          return [{ id: "pageAssets" }];
        },
        async get() {
          return {
            async list() {
              return new Promise(() => {});
            },
          };
        },
      },
      playwright: {
        waitForLoadState,
        waitForTimeout,
        async evaluate(fn) {
          if (String(fn).includes("rootSelectors")) return [];
          return "<html><body><h1>Product A</h1></body></html>";
        },
      },
    };
    const startedAt = Date.now();
    const evidence = await captureBrowserActionEvidence(tab, async () => {}, {
      useCdp: false,
      expectNavigation: false,
      actionSettleMs: 0,
      pageAssetsTimeoutMs: 100,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(evidence.errors.pageAssets).toBe("page_assets_timeout");
    expect(waitForLoadState).not.toHaveBeenCalled();
  });

  it("skips gallery and pageAssets work when image evidence is disabled", async () => {
    const capabilityList = vi.fn(async () => {
      throw new Error("image capability lookup must not run");
    });
    const tab = {
      async url() {
        return "https://shop.test/products/a";
      },
      capabilities: {
        list: capabilityList,
      },
      playwright: {
        async waitForTimeout() {},
        async evaluate() {
          return "<html><body><h1>Product A</h1></body></html>";
        },
      },
    };
    const evidence = await captureBrowserActionEvidence(tab, async () => {}, {
      useCdp: false,
      includeImageEvidence: false,
      actionSettleMs: 0,
    });
    expect(capabilityList).not.toHaveBeenCalled();
    expect(evidence.productImages).toEqual([]);
  });
});
