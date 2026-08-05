import { describe, expect, it } from "vitest";

import {
  classifyBrowserAccessError,
  classifySiteOutcome,
  createSiteObservation,
  isSiteObservationFresh,
  resolveEntryCrawlPlan,
} from "./site-outcome.mjs";

describe("site outcome classification", () => {
  it.each([
    ["net::ERR_TIMED_OUT", "navigation_timeout"],
    ["net::ERR_CONNECTION_CLOSED", "connection_closed"],
    ["net::ERR_CERT_COMMON_NAME_INVALID", "tls_certificate_error"],
  ])("classifies %s as %s", (message, kind) => {
    expect(classifyBrowserAccessError(message)).toMatchObject({
      kind,
      persistable: true,
    });
  });

  it("does not persist browser execution policy failures as site facts", () => {
    const access = classifyBrowserAccessError("blocked_by_browser_url_policy");
    expect(access).toMatchObject({
      kind: "browser_execution_error",
      retryable: true,
      persistable: false,
    });
    expect(createSiteObservation("https://shop.test", {
      kind: "access_error",
      access,
    })).toBeNull();
  });

  it.each([
    "Timed out waiting for CDP command Page.captureScreenshot",
    "screenshot_render_blank",
    "browser_operation_timeout:visual_screenshot:10000",
  ])("keeps screenshot/control failure %s out of site observations", (message) => {
    const access = classifyBrowserAccessError(message);
    expect(access).toMatchObject({
      kind: "browser_execution_error",
      retryable: true,
      persistable: false,
    });
    expect(createSiteObservation("https://shop.test", {
      kind: "access_error",
      access,
    })).toBeNull();
  });

  it("keeps official store handoffs distinct from brand portfolios", () => {
    expect(classifySiteOutcome({
      officialStoreUrl: "https://official-shop.test/catalog",
    })).toEqual({
      kind: "official_store_handoff",
      terminal: false,
      officialStoreUrl: "https://official-shop.test/catalog",
    });
    expect(classifySiteOutcome({
      portfolioOrigins: ["https://brand-a.test", "https://brand-b.test"],
    })).toEqual({
      kind: "portfolio",
      terminal: false,
    });
    expect(classifySiteOutcome({
      officialStoreUrl: "https://shop.parent.test",
      portfolioOrigins: ["https://brand-a.test", "https://brand-b.test"],
    })).toEqual({
      kind: "portfolio",
      terminal: false,
    });
  });

  it("excludes a multi-brand retailer before treating its product cards as a storefront", () => {
    const outcome = classifySiteOutcome({
      isMultiBrandRetailer: true,
      productCount: 3_965,
      hasPurchasableProducts: true,
      portfolioOrigins: ["https://brand-a.test", "https://brand-b.test"],
    });
    expect(outcome).toEqual({
      kind: "multi_brand_retailer",
      terminal: true,
      reason: "multi_brand_retailer_excluded",
    });
    expect(resolveEntryCrawlPlan("https://retailer.test", {
      entryOutcome: outcome,
      verifiedSites: [{ origin: "https://brand-a.test", depth: 1 }],
      brandCandidates: [{ url: "https://brand-b.test", label: "Brand B" }],
    })).toMatchObject({
      mode: "terminal",
      terminal: true,
      reason: "multi_brand_retailer_excluded",
    });
  });

  it("only crawls an identified multi-brand retailer after an explicit override", () => {
    expect(classifySiteOutcome({
      isMultiBrandRetailer: true,
      includeMultiBrandRetailers: true,
      productCount: 3_965,
    })).toEqual({ kind: "storefront", terminal: false });
  });

  it("keeps an empty parent nonterminal when direct Brands are verified", () => {
    expect(resolveEntryCrawlPlan("https://parent.test", {
      entryOutcome: { kind: "service_or_out_of_scope", terminal: true },
      verifiedSites: [{ origin: "https://brand-a.test", depth: 1 }],
    })).toMatchObject({
      mode: "portfolio",
      terminal: false,
      reason: "verified_direct_brands_replace_empty_parent",
      outcome: { kind: "portfolio", terminal: false },
    });
    expect(resolveEntryCrawlPlan("https://parent.test", {
      entryOutcome: {
        kind: "official_store_handoff",
        terminal: false,
        officialStoreUrl: "https://shop.parent.test",
      },
      verifiedSites: [{ origin: "https://brand-a.test", depth: 1 }],
    }).mode).toBe("portfolio");
  });

  it("requires candidate verification instead of ending an empty parent crawl", () => {
    expect(resolveEntryCrawlPlan("https://parent.test", {
      entryOutcome: { kind: "service_or_out_of_scope", terminal: true },
      brandCandidates: [{ url: "https://brand-a.test", label: "Brand A" }],
    })).toMatchObject({
      mode: "needs_brand_verification",
      terminal: false,
      reason: "direct_brand_candidates_require_visual_verification",
    });
  });

  it("requires visual entry classification when no outcome evidence exists", () => {
    expect(resolveEntryCrawlPlan("https://unknown.test")).toMatchObject({
      mode: "needs_visual_classification",
      terminal: false,
      reason: "visual_entry_outcome_required",
    });
  });

  it("expires persisted access observations", () => {
    const checkedAt = "2026-07-29T00:00:00.000Z";
    const access = classifyBrowserAccessError("net::ERR_TIMED_OUT", { checkedAt });
    const observation = createSiteObservation(
      "https://shop.test",
      { kind: "access_error", access },
      { checkedAt },
    );
    expect(isSiteObservationFresh(
      observation,
      Date.parse("2026-07-29T00:30:00.000Z"),
    )).toBe(true);
    expect(isSiteObservationFresh(
      observation,
      Date.parse("2026-07-29T02:00:00.000Z"),
    )).toBe(false);
  });
});
