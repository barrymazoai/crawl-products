import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeTemplateFingerprint,
  createSiteProfile,
  loadSiteProfile,
  normalizeCdpProfile,
  normalizeListingProfile,
  normalizeVisualRoute,
  saveSiteProfile,
  validateMappedVisualRoute,
  validateSiteProfile,
} from "./profile-store.mjs";

function fieldQuality(overrides = {}) {
  return {
    valid: true,
    score: 12,
    tagName: "div",
    selectorCount: 1,
    textLength: 20,
    imageCount: 0,
    videoCount: 0,
    semanticSignals: ["test_signal"],
    reasons: [],
    ...overrides,
  };
}

describe("persistent site profiles", () => {
  it("keeps structural fingerprints stable across product values", () => {
    const first = `<main><h1>Product A</h1><a href="/p/a"><img src="/a.jpg"></a><span>$12.99</span></main>`;
    const second = `<main><h1>Product B</h1><a href="/p/b"><img src="/b.jpg"></a><span>$42.50</span></main>`;
    expect(computeTemplateFingerprint(first)).toBe(computeTemplateFingerprint(second));
  });

  it("atomically saves and reloads value-free crawl rules", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "crawl-products-profile-"));
    try {
      const profile = createSiteProfile({
        startUrl: "https://shop.test",
        fields: ["title", "price", "images"],
        templateFingerprint: "fingerprint",
        discovery: {
          strategy: "visual_route",
          listingSeeds: ["https://shop.test/collections/all"],
          sampleProductUrl: "https://shop.test/products/a",
        },
        visualRoute: {
          status: "mapped",
          targetRole: "detail",
          requestedFields: ["title", "price", "images"],
          steps: [{
            pageRole: "home",
            url: "https://shop.test/",
            action: {
              text: "Shop",
              targetUrl: "https://shop.test/collections/all",
              selector: "a[href='/collections/all']",
            },
          }, {
            pageRole: "listing",
            url: "https://shop.test/collections/all",
            action: {
              text: "Product A",
              targetUrl: "https://shop.test/products/a",
              generalSelector: ".product-card a",
            },
          }, {
            pageRole: "detail",
            url: "https://shop.test/products/a",
          }],
          fieldJourney: {
            status: "mapped",
            pageUrl: "https://shop.test/products/a",
            fields: [{
              field: "title",
              availability: "present_visible",
              targetSelector: "main h1",
              quality: fieldQuality({ tagName: "h1" }),
            }, {
              field: "price",
              availability: "present_visible",
              targetSelector: ".price",
              quality: fieldQuality(),
            }, {
              field: "images",
              availability: "present_visible",
              targetSelector: ".product-gallery",
              quality: fieldQuality({ imageCount: 2, textLength: 0 }),
            }],
          },
        },
        detailProfile: {
          version: 1,
          kind: "detail-extraction",
          fieldRules: { price: [{ mode: "selector_text", selectors: [".price"] }] },
        },
      });
      const filePath = await saveSiteProfile(directory, profile);
      expect(filePath.startsWith(directory)).toBe(true);

      const loaded = await loadSiteProfile(directory, "https://shop.test", {
        fields: ["title", "price"],
      });
      expect(loaded.validation.valid).toBe(true);
      expect(loaded.profile.discovery.listingSeeds).toEqual([
        "https://shop.test/collections/all",
      ]);
      expect(loaded.profile.visualRoute.steps[0].action.selector)
        .toBe("a[href='/collections/all']");
      expect(JSON.stringify(loaded.profile)).not.toContain("$12.99");

      const changedTemplate = await loadSiteProfile(directory, "https://shop.test", {
        fields: ["title", "price"],
        templateFingerprint: "changed",
      });
      expect(changedTemplate.validation).toEqual({
        valid: false,
        reasons: ["template_changed"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects replay when requested fields or template fingerprint changed", () => {
    const profile = createSiteProfile({
      startUrl: "https://shop.test",
      fields: ["title"],
      templateFingerprint: "old",
    });
    expect(validateSiteProfile(profile, {
      startUrl: "https://shop.test",
      fields: ["title", "price"],
      templateFingerprint: "new",
    })).toEqual({
      valid: false,
      reasons: ["fields_not_covered", "template_changed"],
    });
  });

  it("keeps only bounded product-response matching rules in CDP profiles", () => {
    expect(normalizeCdpProfile({
      responseRules: [{
        name: " product API ",
        urlIncludes: "/api/product/",
        resourceTypes: ["XHR", "Document", "XHR"],
        responseBody: "must not persist",
        headers: { authorization: "must not persist" },
      }],
      cookies: ["must not persist"],
    })).toEqual({
      responseRules: [{
        name: "product API",
        urlIncludes: "/api/product/",
        resourceTypes: ["XHR"],
      }],
    });
  });

  it("normalizes reusable semantic listing rules without page values", () => {
    expect(normalizeListingProfile({
      productLinkSelectors: [
        "a.product-item-link",
        "a.product-item-link",
        "",
      ],
      scrollListings: true,
      listingScrollScreens: 99,
      sampleProductTitle: "must not persist",
    })).toEqual({
      productLinkSelectors: ["a.product-item-link"],
      scrollListings: true,
      listingScrollScreens: 20,
    });
  });

  it("persists the verified external product-link decision", () => {
    expect(normalizeListingProfile({
      productLinkSelectors: [".productCard a.productBuyBtn"],
      followVerifiedExternalProductLinks: true,
    })).toEqual({
      productLinkSelectors: [".productCard a.productBuyBtn"],
      scrollListings: true,
      listingScrollScreens: 10,
      followVerifiedExternalProductLinks: true,
    });
  });

  it("normalizes mapped pagination controls", () => {
    expect(normalizeListingProfile({
      productLinkSelectors: [".product-card a"],
      paginationActions: [{
        action: "click",
        selector: "button.load-more",
        text: " Load more ",
      }, {
        action: "click",
        selector: "button.load-more",
      }],
    })).toEqual({
      productLinkSelectors: [".product-card a"],
      paginationActions: [{
        action: "click",
        selector: "button.load-more",
        text: "Load more",
      }],
      scrollListings: true,
      listingScrollScreens: 10,
    });
  });

  it("persists mapped catalog coverage without screenshot coordinates", () => {
    const route = normalizeVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "home",
        url: "https://shop.test/",
        action: {
          actionKind: "catalog_entry",
          catalogCoverage: "siblings",
          text: "Nutrition",
          targetUrl: "https://shop.test/nutrition",
          selector: "a[href='/nutrition']",
          generalSelector: "header nav a.department",
          generalSelectorSource: "repeated_navigation",
        },
      }, {
        pageRole: "listing",
        url: "https://shop.test/nutrition",
      }],
      catalogCoverage: {
        status: "mapped",
        listingSeeds: [
          "https://shop.test/nutrition",
          "https://shop.test/protein",
        ],
        families: [{
          sourceUrl: "https://shop.test/",
          sourcePageRole: "home",
          selector: "header nav a.department",
          coverage: "siblings",
          listingUrls: [
            "https://shop.test/nutrition",
            "https://shop.test/protein",
          ],
        }],
      },
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "not_present",
        }],
      },
    });

    expect(route.steps[0].action).toMatchObject({
      actionKind: "catalog_entry",
      catalogCoverage: "siblings",
      generalSelectorSource: "repeated_navigation",
    });
    expect(route.catalogCoverage.listingSeeds).toHaveLength(2);
    expect(validateMappedVisualRoute(route, { fields: ["title"] }).valid).toBe(true);
  });

  it("persists selector-only variant replay methods without concrete option values", () => {
    const route = normalizeVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/foo" }],
      variantProfile: {
        optionGroupSelectors: ["select[name='flavor']", "select[name='size']"],
        optionSelectors: ["select[name='flavor'] option"],
        selectedStateSelectors: ["[data-variant-id]"],
        settleMs: 999,
        maxStates: 999,
        optionValues: ["Chocolate", "30 capsules"],
      },
    });
    expect(route.variantProfile).toEqual({
      optionGroupSelectors: ["select[name='flavor']", "select[name='size']"],
      optionSelectors: ["select[name='flavor'] option"],
      selectedStateSelectors: ["[data-variant-id]"],
      settleMs: 999,
      maxStates: 200,
    });
  });

  it("requires explicit visual catalog closure before a full-catalog crawl", () => {
    const listingUrl = "https://shop.test/nutrition/best-sellers";
    const baseRoute = {
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "listing",
        url: listingUrl,
        action: { generalSelector: "a.product-card" },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      catalogCoverage: {
        status: "mapped",
        listingSeeds: [listingUrl],
        families: [],
      },
      fieldJourney: {
        status: "mapped",
        fields: [{ field: "title", availability: "not_present" }],
      },
    };

    expect(validateMappedVisualRoute(baseRoute, {
      fields: ["title"],
      requireCatalogCompletion: true,
    })).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "catalog_closure_not_proven",
        "catalog_listing_pagination_unverified",
      ]),
    });

    const completeRoute = {
      ...baseRoute,
      catalogCoverage: {
        ...baseRoute.catalogCoverage,
        listings: [{
          url: listingUrl,
          paginationMode: "none",
          verifiedVisually: true,
        }],
        closure: {
          status: "complete",
          verifiedVisually: true,
          basis: "single_listing_catalog",
        },
      },
    };
    expect(validateMappedVisualRoute(completeRoute, {
      fields: ["title"],
      requireCatalogCompletion: true,
    }).valid).toBe(true);
  });

  it("persists visual routes without screenshot bytes or click coordinates", () => {
    expect(normalizeVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title", "ingredients"],
      screenshots: ["must not persist"],
      steps: [{
        pageRole: "home",
        url: "https://shop.test/",
        x: 400,
        y: 220,
        action: {
          text: " Shop ",
          targetUrl: "https://shop.test/collections/all",
          selector: "header a[href='/collections/all']",
          screenshot: "must not persist",
        },
      }, {
        pageRole: "listing",
        url: "https://shop.test/collections/all",
        action: {
          text: "Product A",
          targetUrl: "https://shop.test/products/a",
          generalSelector: ".product-card a",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "mapped",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "title",
          availability: "present_visible",
          target: { x: 600, y: 180 },
          targetSelector: "main h1",
        }, {
          field: "ingredients",
          availability: "present_hidden",
          target: { x: 500, y: 700 },
          targetSelector: "#ingredients",
          revealAction: {
            action: "click",
            text: " Ingredients ",
            x: 420,
            y: 640,
            selectorHint: "button[data-tab='ingredients']",
          },
        }],
      },
    })).toEqual({
      version: 3,
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["ingredients", "title"],
      steps: [{
        pageRole: "home",
        url: "https://shop.test/",
        action: {
          text: "Shop",
          targetUrl: "https://shop.test/collections/all",
          selector: "header a[href='/collections/all']",
        },
      }, {
        pageRole: "listing",
        url: "https://shop.test/collections/all",
        action: {
          text: "Product A",
          targetUrl: "https://shop.test/products/a",
          generalSelector: ".product-card a",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "mapped",
        pageUrl: "https://shop.test/products/a",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "main h1",
        }, {
          field: "ingredients",
          availability: "present_hidden",
          targetSelector: "#ingredients",
          revealAction: {
            action: "click",
            text: "Ingredients",
            selectorHint: "button[data-tab='ingredients']",
          },
        }],
      },
    });
  });

  it("rejects a route that stops at the product page without mapping fields", () => {
    expect(validateMappedVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title", "price"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/a" }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "main h1",
          quality: fieldQuality({ tagName: "h1" }),
        }],
      },
    }, { fields: ["title", "price"] })).toEqual({
      valid: false,
      reasons: ["field_journey_incomplete"],
      missingFields: ["price"],
    });
  });

  it("rejects scalar field selector collisions and video-only image mappings", () => {
    const route = {
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title", "description", "images"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/a" }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "div.product-copy",
          quality: fieldQuality({ tagName: "div" }),
        }, {
          field: "description",
          availability: "present_visible",
          targetSelector: "div.product-copy",
          quality: fieldQuality({ textLength: 500 }),
        }, {
          field: "images",
          availability: "present_visible",
          targetSelector: "video.hero",
          quality: fieldQuality({
            valid: false,
            imageCount: 0,
            videoCount: 1,
            reasons: ["video_only_container"],
          }),
        }],
      },
    };
    expect(validateMappedVisualRoute(route)).toEqual({
      valid: false,
      reasons: ["field_selector_collision", "field_journey_incomplete"],
      missingFields: ["images"],
    });
  });

  it("accepts a hidden Facts field backed by the mapped product gallery", () => {
    const galleryQuality = fieldQuality({
      textLength: 0,
      imageCount: 7,
      semanticSignals: ["gallery_marker", "real_image_descendant"],
    });
    const route = {
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["images", "supplement_facts"],
      steps: [{ pageRole: "detail", url: "https://shop.test/products/a" }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "images",
          availability: "present_visible",
          targetSelector: ".product-gallery",
          quality: galleryQuality,
        }, {
          field: "supplement_facts",
          availability: "present_hidden",
          sourceKind: "gallery_image",
          targetSelector: ".product-gallery",
          quality: galleryQuality,
        }],
      },
    };

    expect(validateMappedVisualRoute(route)).toEqual({
      valid: true,
      reasons: [],
      missingFields: [],
    });
    expect(normalizeVisualRoute(route).fieldJourney.fields[1].sourceKind)
      .toBe("gallery_image");
  });

  it("requires a named relationship for cross-origin route transitions", () => {
    const route = {
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "home",
        url: "https://brand.test/",
        action: {
          selector: "a.store",
          targetUrl: "https://shop.test/products/a",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/a",
      }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "main h1",
          quality: fieldQuality({ tagName: "h1" }),
        }],
      },
    };
    expect(validateMappedVisualRoute(route).reasons)
      .toContain("cross_origin_relation_missing");
    route.steps[0].action.relationType = "official_store_handoff";
    expect(validateMappedVisualRoute(route).valid).toBe(true);
  });

  it("accepts a unique exact selector for a verified single-product listing", () => {
    expect(validateMappedVisualRoute({
      status: "mapped",
      targetRole: "detail",
      requestedFields: ["title"],
      steps: [{
        pageRole: "listing",
        url: "https://shop.test/catalog",
        action: {
          selector: "a[href='/products/only']",
          targetUrl: "https://shop.test/products/only",
        },
      }, {
        pageRole: "detail",
        url: "https://shop.test/products/only",
      }],
      fieldJourney: {
        status: "mapped",
        fields: [{
          field: "title",
          availability: "present_visible",
          targetSelector: "main h1",
          quality: fieldQuality({ tagName: "h1" }),
        }],
      },
    }).valid).toBe(true);
  });

  it("returns targeted migration hints for legacy v3 profiles", () => {
    const profile = {
      ...createSiteProfile({
        startUrl: "https://shop.test",
        fields: ["title"],
        discovery: { listingSeeds: ["https://shop.test/catalog"] },
      }),
      version: 3,
    };
    expect(validateSiteProfile(profile, {
      startUrl: "https://shop.test",
      fields: ["title"],
    })).toEqual({
      valid: false,
      reasons: ["legacy_profile_quality_revalidation_required"],
      migration: {
        reusable: ["discovery", "listingProfile", "visualRoute.steps", "cdpProfile"],
        revalidate: ["visualRoute.fieldJourney.quality", "imageProfile"],
      },
    });
  });
});
