import { describe, expect, it } from "vitest";

import {
  DEFAULT_HARVEST_BUDGETS,
  evidenceCoverageGaps,
  isValidExhaustionSignal,
  normalizeHarvestPlan,
  validateEvidencePackage,
  validateHarvestPlan,
  validateNotPresentClaim,
  validateVerificationTrace,
} from "./harvest-plan.mjs";

function goodPlan() {
  return {
    site: { origin: "https://shop.test", entryUrl: "https://shop.test/", browserMode: "iab" },
    decision: { kind: "storefront", evidence: ["screenshot:entry.png"] },
    route: {
      listingSeeds: [
        { url: "https://shop.test/vitamins", paginationMode: "click",
          nextAction: { selector: "button.load-more" } },
        { url: "https://shop.test/protein", paginationMode: "none" },
      ],
      detailProfile: { fields: {} },
    },
    termination: {
      perSeed: [
        { url: "https://shop.test/vitamins", exhaustionSignal: "no_new_urls_after_clicks:3" },
        { url: "https://shop.test/protein", exhaustionSignal: "single_page_confirmed" },
      ],
      oracles: [{ type: "collection_count", expected: 42, source: "listing header" }],
    },
  };
}

function goodEvidencePackage() {
  return {
    productUrl: "https://shop.test/products/alpha",
    fields: { title: "Alpha", description: "..." },
    gallery: [
      { url: "https://cdn.test/a-front.jpg", alt: "front", index: 0,
        localPath: "evidence/img/a1.jpg", mime: "image/jpeg" },
      { url: "https://cdn.test/a-facts.jpg", alt: "", index: 1,
        localPath: "evidence/img/a2.jpg", mime: "image/jpeg", factsCandidateRank: 1 },
    ],
    coverage: {
      gallerySaved: "2/2",
      domSectionsExpanded: ["Description", "Supplement Facts"],
      pageTextSearched: ["ingredients", "supplement facts"],
      jsonLdCaptured: true,
    },
    flags: [],
  };
}

describe("HarvestPlan validation", () => {
  it("accepts a complete plan and fills default budgets", () => {
    const { valid, errors, plan } = validateHarvestPlan(goodPlan());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(plan.termination.budgets.maxItems).toBe(DEFAULT_HARVEST_BUDGETS.maxItems);
    expect(plan.termination.retryPerUrl).toBe(DEFAULT_HARVEST_BUDGETS.retryPerUrl);
    expect(plan.site.browserMode).toBe("iab");
  });

  it("refuses to start without a termination contract for every seed", () => {
    const input = goodPlan();
    input.termination.perSeed.pop();
    const { valid, errors } = validateHarvestPlan(input);
    expect(valid).toBe(false);
    expect(errors).toContain("termination_missing_for_seed:https://shop.test/protein");
  });

  it("rejects exhaustion signals that do not match the pagination mode", () => {
    const input = goodPlan();
    input.termination.perSeed[0].exhaustionSignal = "single_page_confirmed";
    const { valid, errors } = validateHarvestPlan(input);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.startsWith("termination_signal_invalid:https://shop.test/vitamins"))).toBe(true);
  });

  it("rejects non-crawlable entry decisions and missing evidence", () => {
    const input = goodPlan();
    input.decision = { kind: "multi_brand_retailer", evidence: [] };
    const { errors } = validateHarvestPlan(input);
    expect(errors).toContain("decision_kind_not_crawlable:multi_brand_retailer");
    expect(errors).toContain("decision_evidence_missing");
  });

  it("requires a next action for click/link pagination", () => {
    const input = goodPlan();
    delete input.route.listingSeeds[0].nextAction;
    const { errors } = validateHarvestPlan(input);
    expect(errors).toContain("seed_next_action_missing:https://shop.test/vitamins");
  });

  it("flags termination entries pointing at unknown seeds", () => {
    const input = goodPlan();
    input.termination.perSeed.push({
      url: "https://shop.test/ghost",
      exhaustionSignal: "next_link_absent",
    });
    const { errors } = validateHarvestPlan(input);
    expect(errors).toContain("termination_orphan_seed:https://shop.test/ghost");
  });

  it("validates exhaustion signal grammar", () => {
    expect(isValidExhaustionSignal("click", "no_new_urls_after_clicks:3")).toBe(true);
    expect(isValidExhaustionSignal("click", "no_new_urls_after_clicks:0")).toBe(false);
    expect(isValidExhaustionSignal("scroll", "no_new_cards_after_scrolls:2")).toBe(true);
    expect(isValidExhaustionSignal("link", "next_link_absent")).toBe(true);
    expect(isValidExhaustionSignal("none", "button_gone")).toBe(false);
  });

  it("normalizes without throwing on junk input", () => {
    const plan = normalizeHarvestPlan(null);
    expect(plan.route.listingSeeds).toEqual([]);
    expect(plan.termination.budgets.stallMinutes).toBe(DEFAULT_HARVEST_BUDGETS.stallMinutes);
  });
});

describe("EvidencePackage validation", () => {
  it("accepts a complete package", () => {
    const { valid, errors } = validateEvidencePackage(goodEvidencePackage());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("requires every gallery image to be saved unless a download failure is flagged", () => {
    const pkg = goodEvidencePackage();
    pkg.gallery[1].localPath = "";
    expect(validateEvidencePackage(pkg).errors)
      .toContain("evidence_image_not_saved:https://cdn.test/a-facts.jpg");

    pkg.flags = ["image_download_failed:https://cdn.test/a-facts.jpg"];
    expect(validateEvidencePackage(pkg).valid).toBe(true);
  });

  it("reports coverage gaps for targeted follow-up instead of blind retries", () => {
    const pkg = goodEvidencePackage();
    pkg.coverage.gallerySaved = "1/2";
    pkg.coverage.domSectionsExpanded = [];
    expect(evidenceCoverageGaps(pkg)).toEqual([
      "gallery_images_unsaved:1",
      "dom_sections_not_expanded",
    ]);
  });

  it("detects coverage manifests that disagree with the gallery", () => {
    const pkg = goodEvidencePackage();
    pkg.coverage.gallerySaved = "3/3";
    expect(evidenceCoverageGaps(pkg)).toContain("gallery_coverage_count_mismatch");
  });
});

describe("verification traces and not_present claims", () => {
  const trace = {
    verdict: "not_present",
    method: "visual_image_read",
    surface: "local_file",
    evidence: ["evidence/img/a1.jpg", "evidence/img/a2.jpg"],
    verifier: "semantic:ingredients",
  };

  it("accepts a full trace and rejects traces missing the how/where/what", () => {
    expect(validateVerificationTrace(trace)).toEqual([]);
    expect(validateVerificationTrace({ verdict: "ok" })).toEqual(
      expect.arrayContaining([
        "trace_method_invalid:missing",
        "trace_surface_invalid:missing",
        "trace_evidence_missing",
        "trace_verifier_missing",
      ]),
    );
  });

  it("admits a not_present claim only with complete coverage and a trace", () => {
    expect(validateNotPresentClaim(
      { field: "ingredients", trace },
      goodEvidencePackage(),
    )).toEqual([]);
  });

  it("rejects a not_present claim when coverage has holes", () => {
    const pkg = goodEvidencePackage();
    pkg.coverage.gallerySaved = "1/2";
    const errors = validateNotPresentClaim({ field: "ingredients", trace }, pkg);
    expect(errors).toContain("not_present_coverage_gap:gallery_images_unsaved:1");
  });
});

describe("route.listingProfile survives normalization", () => {
  it("keeps the listing profile the engine hands to enumeration", () => {
    const input = goodPlan();
    input.route.listingProfile = { productLinkSelectors: [".card a"] };
    const { plan } = validateHarvestPlan(input);
    expect(plan.route.listingProfile).toEqual({ productLinkSelectors: [".card a"] });
  });
});
