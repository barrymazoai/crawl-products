import { describe, expect, it, vi } from "vitest";

import {
  extractionProfilesFromVisualRoute,
  mapVisualRouteAction,
  replayVisualRoute,
} from "./visual-route.mjs";

function evidence(url, { responses = [], html = "<main><h1>Page</h1></main>" } = {}) {
  return {
    url,
    html,
    htmlBytes: html.length,
    capabilities: { cdp: true, pageAssets: true },
    network: {
      eventCount: responses.length,
      responseCount: responses.length,
      truncated: false,
      responses,
      responseBodies: [],
    },
    imageEvidence: null,
    errors: {},
  };
}

describe("visual route learning", () => {
  it("maps the visually chosen action to exact and repeated DOM selectors", async () => {
    const tab = {
      playwright: {
        async evaluate(_fn, args) {
          expect(args).toEqual({
            actionText: "Shop",
            targetUrl: "https://shop.test/catalog",
          });
          return {
            selector: "a[href='/catalog']",
            generalSelector: "a.nav-link",
            generalSelectorCount: 4,
            href: "https://shop.test/catalog",
            text: "Shop",
            tagName: "a",
            score: 380,
          };
        },
      },
    };
    await expect(mapVisualRouteAction(tab, {
      text: "Shop",
      targetUrl: "https://shop.test/catalog",
    })).resolves.toMatchObject({
      selector: "a[href='/catalog']",
      generalSelector: "a.nav-link",
      generalSelectorCount: 4,
    });
  });

  it("replays a completed visual route under DOM and network observation", async () => {
    let currentUrl = "about:blank";
    const click = vi.fn(async () => {
      currentUrl = "https://shop.test/products/a";
    });
    const tab = {
      async url() {
        return currentUrl;
      },
      playwright: {
        locator(selector) {
          expect(selector).toBe("a[href='/products/a']");
          return {
            async count() { return 2; },
            nth(index) {
              return {
                async isVisible() { return index === 1; },
                click,
              };
            },
          };
        },
      },
    };
    const captureNavigationEvidence = vi.fn(async (_tab, url) => {
      currentUrl = url;
      return evidence(url);
    });
    const captureActionEvidence = vi.fn(async (_tab, action) => {
      await action();
      return evidence(currentUrl, {
        responses: [{
          type: "XHR",
          url: "https://shop.test/api/products/a",
          status: 200,
          mimeType: "application/json",
        }],
        html: "<main><h1>Product A</h1></main>",
      });
    });
    const mapAction = vi.fn(async () => ({
      selector: "a[href='/products/a']",
      selectorCount: 2,
      generalSelector: ".product-card a",
      generalSelectorCount: 12,
      generalSelectorSource: "repeated_ancestor",
      generalSelectorUniqueHrefCount: 12,
    }));
    const mapFieldTarget = vi.fn(async () => ({
      selector: "main h1",
      selectorCount: 1,
      tagName: "h1",
      usedScreenTarget: true,
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
    }));

    const result = await replayVisualRoute(tab, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "listing",
        url: "https://shop.test/catalog",
        action: {
          text: "Product A",
          targetUrl: "https://shop.test/products/a",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "visual_complete",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "title",
          availability: "present_visible",
          target: { x: 420, y: 180 },
        }],
      },
    }, {
      captureNavigationEvidence,
      captureActionEvidence,
      mapAction,
      mapFieldTarget,
    });

    expect(click).toHaveBeenCalledOnce();
    expect(result.visualRoute.steps[0].action).toMatchObject({
      selector: "a[href='/products/a']",
      generalSelector: ".product-card a",
    });
    expect(result.listingProfile.productLinkSelectors).toEqual([".product-card a"]);
    expect(result.visualRoute).toMatchObject({
      version: 3,
      status: "mapped",
      requestedFields: ["title"],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "main h1",
        }],
      },
    });
    expect(result.detailProfile.fieldRules.title).toEqual([{
      mode: "selector_text",
      selectors: ["main h1"],
    }]);
    expect(result.networkCandidates).toEqual([{
      stepIndex: 1,
      pageRole: "detail",
      type: "XHR",
      url: "https://shop.test/api/products/a",
      status: 200,
      mimeType: "application/json",
    }]);
  });

  it("maps nested catalog families and preserves their sibling listing seeds", async () => {
    let currentUrl = "about:blank";
    let actionIndex = 0;
    const actionTargets = [
      "https://shop.test/",
      "https://shop.test/nutrition/best-sellers",
      "https://shop.test/products/a",
    ];
    const mappings = [{
      selector: "button#nutrition",
      selectorCount: 1,
    }, {
      selector: "a[href='/nutrition/best-sellers']",
      selectorCount: 1,
      generalSelector: "nav.nutrition-menu a",
      generalSelectorCount: 4,
      generalSelectorSource: "repeated_navigation",
      generalSelectorUniqueHrefCount: 4,
    }, {
      selector: "a[href='/products/a']",
      selectorCount: 1,
      generalSelector: ".product-card a",
      generalSelectorCount: 20,
      generalSelectorSource: "repeated_ancestor",
      generalSelectorUniqueHrefCount: 20,
    }];
    const result = await replayVisualRoute({
      async url() { return currentUrl; },
    }, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "home",
        url: "https://shop.test/",
        action: {
          actionKind: "navigation_reveal",
          text: "Nutrition",
          targetUrl: "https://shop.test/",
        },
      }, {
        pageRole: "home",
        url: "https://shop.test/",
        action: {
          actionKind: "catalog_entry",
          catalogCoverage: "siblings",
          text: "Best Sellers",
          targetUrl: "https://shop.test/nutrition/best-sellers",
        },
      }, {
        pageRole: "listing",
        url: "https://shop.test/nutrition/best-sellers",
        action: {
          actionKind: "product_entry",
          text: "Product A",
          targetUrl: "https://shop.test/products/a",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      catalogCoverage: {
        status: "incomplete",
        listingSeeds: [
          "https://shop.test/nutrition/best-sellers",
          "https://shop.test/nutrition/new-arrivals",
          "https://shop.test/nutrition/vitamins",
          "https://shop.test/nutrition/protein",
        ],
        families: [],
        listings: [
          "best-sellers",
          "new-arrivals",
          "vitamins",
          "protein",
        ].map((slug) => ({
          url: `https://shop.test/nutrition/${slug}`,
          paginationMode: "none",
          verifiedVisually: true,
        })),
        closure: {
          status: "complete",
          verifiedVisually: true,
          basis: "navigation_exhausted",
        },
      },
      fieldJourney: {
        status: "visual_complete",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "title",
          availability: "present_visible",
          target: { x: 420, y: 180 },
        }],
      },
    }, {
      captureNavigationEvidence: async (_tab, url) => {
        currentUrl = url;
        return evidence(url);
      },
      captureActionEvidence: async () => {
        currentUrl = actionTargets[actionIndex];
        actionIndex += 1;
        return evidence(currentUrl);
      },
      mapAction: async () => mappings[actionIndex],
      collectCatalogUrls: async () => [
        "https://shop.test/nutrition/best-sellers",
        "https://shop.test/nutrition/new-arrivals",
        "https://shop.test/nutrition/vitamins",
        "https://shop.test/nutrition/protein",
      ],
      mapFieldTarget: async () => ({
        selector: "main h1",
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
      }),
    });

    expect(result.listingProfile).toMatchObject({
      categoryLinkSelectors: ["nav.nutrition-menu a"],
      productLinkSelectors: [".product-card a"],
    });
    expect(result.visualRoute.catalogCoverage).toMatchObject({
      status: "mapped",
      listingSeeds: expect.arrayContaining([
        "https://shop.test/nutrition/new-arrivals",
        "https://shop.test/nutrition/vitamins",
        "https://shop.test/nutrition/protein",
      ]),
      families: [{
        sourceUrl: "https://shop.test/",
        selector: "nav.nutrition-menu a",
        coverage: "siblings",
        listingUrls: expect.any(Array),
      }],
      listings: expect.arrayContaining([
        expect.objectContaining({
          url: "https://shop.test/nutrition/vitamins",
          paginationMode: "none",
          verifiedVisually: true,
        }),
      ]),
      closure: {
        status: "complete",
        verifiedVisually: true,
        basis: "navigation_exhausted",
      },
    });
  });

  it("rejects an explicitly sibling-backed catalog action that maps only one target", async () => {
    await expect(replayVisualRoute({}, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "home",
        url: "https://shop.test/",
        action: {
          actionKind: "catalog_entry",
          catalogCoverage: "siblings",
          text: "Best Sellers",
          targetUrl: "https://shop.test/nutrition/best-sellers",
        },
      }, {
        pageRole: "listing",
        url: "https://shop.test/nutrition/best-sellers",
      }],
      fieldJourney: {
        status: "visual_complete",
        fields: [{ field: "title", availability: "not_present" }],
      },
    }, {
      captureNavigationEvidence: async (_tab, url) => evidence(url),
      mapAction: async () => ({
        selector: "a[href='/nutrition/best-sellers']",
        selectorCount: 1,
      }),
      collectCatalogUrls: async () => [],
    })).rejects.toThrow("visual_catalog_family_not_mapped:0");
  });

  it("does not treat a generic repeated link class as a product-card selector", async () => {
    let currentUrl = "https://shop.test/catalog";
    const tab = {
      async url() {
        return currentUrl;
      },
      playwright: {
        locator() {
          return {
            async count() { return 1; },
            async click() {
              currentUrl = "https://shop.test/products/only";
            },
          };
        },
      },
    };
    const result = await replayVisualRoute(tab, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "listing",
        url: "https://shop.test/catalog",
        action: {
          text: "Only product",
          targetUrl: "https://shop.test/products/only",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/only",
      }],
      fieldJourney: {
        status: "visual_complete",
        fields: [{
          field: "title",
          availability: "present_visible",
          target: { x: 400, y: 180 },
        }],
      },
    }, {
      captureNavigationEvidence: async (_tab, url) => {
        currentUrl = url;
        return evidence(url);
      },
      captureActionEvidence: async (_tab, action) => {
        await action();
        return evidence(currentUrl);
      },
      mapAction: async () => ({
        selector: "a[href='/products/only']",
        selectorCount: 1,
        generalSelector: "a.link",
        generalSelectorCount: 8,
      }),
      mapFieldTarget: async () => ({
        selector: "main h1",
        quality: {
          valid: true,
          score: 12,
          tagName: "h1",
          selectorCount: 1,
          textLength: 12,
          imageCount: 0,
          videoCount: 0,
          semanticSignals: ["heading"],
          reasons: [],
        },
      }),
    });
    expect(result.visualRoute.steps[0].action.generalSelector).toBeUndefined();
    expect(result.listingProfile).toMatchObject({
      listingMode: "single_product",
      productLinkSelectors: ["a[href='/products/only']"],
    });
  });

  it("turns visually proven hidden and absent fields into replay policies", () => {
    const profiles = extractionProfilesFromVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["ingredients", "supplement_facts"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/a" }],
      fieldJourney: {
        status: "mapped",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "ingredients",
          availability: "present_hidden",
          targetSelector: "#ingredients-panel",
          revealAction: {
            action: "click",
            text: "Ingredients",
            selectorHint: "button[data-tab='ingredients']",
          },
        }, {
          field: "supplement_facts",
          availability: "not_present",
        }],
      },
    });

    expect(profiles.detailProfile.fieldPolicy.ingredients).toMatchObject({
      availability: "present_hidden",
      missingBehavior: "require_fallback",
      interactionHints: [{
        selectorHint: "button[data-tab='ingredients']",
      }],
    });
    expect(profiles.detailProfile.fieldPolicy.supplement_facts).toMatchObject({
      availability: "not_present",
      missingBehavior: "allow_missing",
    });
  });

  it("falls back to gallery assets when a Facts zoom target cannot be mapped", async () => {
    const galleryMapping = {
      selector: ".product-gallery",
      selectorCount: 1,
      tagName: "div",
      usedScreenTarget: true,
      quality: {
        valid: true,
        score: 14,
        tagName: "div",
        selectorCount: 1,
        textLength: 0,
        imageCount: 7,
        videoCount: 0,
        semanticSignals: ["gallery_marker", "real_image_descendant"],
        reasons: [],
      },
    };
    const captureActionEvidence = vi.fn(async (_tab, action) => {
      await action();
      return {
        ...evidence("https://shop.test/products/a"),
        imageEvidence: {
          renderedCount: 7,
          responseCandidateCount: 7,
          fullCandidateCount: 1,
          selectedCount: 7,
        },
      };
    });
    const mapFieldTarget = vi.fn(async (_tab, checkpoint) => {
      if (checkpoint.field === "images") return galleryMapping;
      return null;
    });

    const result = await replayVisualRoute({}, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["images", "supplement_facts"],
      steps: [{
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "visual_complete",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "images",
          availability: "present_visible",
          target: { x: 360, y: 320 },
        }, {
          field: "supplement_facts",
          availability: "present_hidden",
          revealAction: {
            action: "click",
            text: "Supplement Facts",
            x: 180,
            y: 640,
          },
          target: { x: 360, y: 320 },
        }],
      },
    }, {
      captureNavigationEvidence: async (_tab, url) => evidence(url),
      captureActionEvidence,
      mapAction: async () => null,
      mapFieldTarget,
    });

    expect(result.visualRoute.fieldJourney.fields).toEqual([
      expect.objectContaining({
        field: "images",
        targetSelector: ".product-gallery",
      }),
      expect.objectContaining({
        field: "supplement_facts",
        sourceKind: "gallery_image",
        targetSelector: ".product-gallery",
      }),
    ]);
    expect(result.visualRoute.fieldJourney.fields[1].revealAction).toBeUndefined();
    expect(result.fieldCheckpoints[1]).toMatchObject({
      field: "supplement_facts",
      sourceKind: "gallery_image",
      revealMappingSkipped: true,
    });
    expect(result.detailProfile.fieldRules?.supplement_facts).toBeUndefined();
    expect(result.detailProfile.fieldPolicy.supplement_facts).toMatchObject({
      missingBehavior: "allow_missing",
    });
    expect(result.imageProfile.galleryContainerHints).toEqual([".product-gallery"]);
    expect(result.detailImageEvidence.imageEvidence.selectedCount).toBe(7);
    expect(captureActionEvidence).toHaveBeenCalledOnce();
  });

  it("keeps page-based Facts tables as required DOM text rules", () => {
    const profiles = extractionProfilesFromVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["supplement_facts"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/a" }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "supplement_facts",
          availability: "present_visible",
          sourceKind: "dom",
          targetSelector: "table.supplement-facts",
        }],
      },
    });

    expect(profiles.detailProfile.fieldRules.supplement_facts).toEqual([{
      mode: "selector_text",
      selectors: ["table.supplement-facts"],
    }]);
    expect(profiles.detailProfile.fieldPolicy.supplement_facts.missingBehavior)
      .toBe("require_fallback");
    expect(profiles.imageProfile).toBeNull();
  });

  it("does not let one evidence call outlive the replay operation deadline", async () => {
    const startedAt = Date.now();
    const replay = replayVisualRoute({}, {
      status: "visual_complete",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "visual_complete",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "title",
          availability: "present_visible",
          target: { x: 420, y: 180 },
        }],
      },
    }, {
      operationTimeoutMs: 25,
      captureNavigationEvidence: () => new Promise(() => {}),
    });

    await expect(replay).rejects.toMatchObject({
      code: "browser_operation_timeout",
      operation: "initial_navigation",
      discardTab: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
