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
