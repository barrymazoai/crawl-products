import { describe, expect, it } from "vitest";

import {
  adjudicateNotFound,
  applySemanticOutcome,
  buildSemanticQueue,
  computeFieldPresencePriors,
  isNotPresentSurprising,
  semanticQueueSummary,
} from "./semantic-queue.mjs";

function pkg(overrides = {}) {
  return {
    productUrl: "https://shop.test/p/a",
    fields: { title: "Alpha", description: "supports immunity",
      ingredients_text: "Vitamin C 500mg" },
    gallery: [
      { url: "https://cdn.test/a.jpg", index: 0,
        localPath: "evidence/img/a.jpg", mime: "image/jpeg", factsCandidateRank: 1 },
    ],
    coverage: {
      gallerySaved: "1/1",
      domSectionsExpanded: ["main_content"],
      pageTextSearched: ["ingredients"],
      jsonLdCaptured: true,
    },
    flags: [],
    ...overrides,
  };
}

const trace = {
  verdict: "enriched",
  method: "visual_image_read",
  surface: "local_file",
  evidence: ["evidence/img/a.jpg"],
  verifier: "semantic:enrich",
};

describe("buildSemanticQueue", () => {
  it("starts complete packages as pending", () => {
    expect(buildSemanticQueue([pkg()])).toEqual([
      { productUrl: "https://shop.test/p/a", status: "pending" },
    ]);
  });

  it("routes packages with known evidence gaps straight to needs_browser", () => {
    const broken = pkg({ flags: ["image_download_failed:https://cdn.test/a.jpg"] });
    const [entry] = buildSemanticQueue([broken]);
    expect(entry.status).toBe("needs_browser");
    expect(entry.gaps).toContain("image_download_failed:https://cdn.test/a.jpg");
  });
});

describe("field presence priors and the surprise check", () => {
  const packages = [
    pkg(),
    pkg({ productUrl: "https://shop.test/p/b" }),
    pkg({
      productUrl: "https://shop.test/p/c",
      gallery: [{ url: "https://cdn.test/c.jpg", index: 0,
        localPath: "evidence/img/c.jpg", mime: "image/jpeg" }],
      fields: { title: "Gamma" },
    }),
  ];

  it("computes per-field presence rates", () => {
    const priors = computeFieldPresencePriors(packages);
    expect(priors.records).toBe(3);
    expect(priors.factsImage).toBeCloseTo(2 / 3);
    expect(priors.ingredientsText).toBeCloseTo(2 / 3);
  });

  it("flags not_present as surprising only where the site usually has the field", () => {
    const priors = computeFieldPresencePriors(packages);
    expect(isNotPresentSurprising("facts_image", priors)).toBe(true);
    expect(isNotPresentSurprising("facts_image", { factsImage: 0.1 })).toBe(false);
  });
});

describe("adjudicateNotFound", () => {
  const priors = { factsImage: 0.9, ingredientsText: 0.9 };

  it("sends coverage holes to targeted gap-filling, not retries", () => {
    const holey = pkg();
    holey.coverage.gallerySaved = "0/1";
    const verdict = adjudicateNotFound("ingredients", holey, priors);
    expect(verdict.action).toBe("fill_gaps");
    expect(verdict.gaps).toContain("gallery_images_unsaved:1");
  });

  it("asks for one second look when the claim is surprising", () => {
    expect(adjudicateNotFound("ingredients", pkg(), priors))
      .toMatchObject({ action: "second_look" });
  });

  it("accepts expected absence immediately — genuine absence costs nothing", () => {
    expect(adjudicateNotFound("ingredients", pkg(), { ingredientsText: 0.1 }))
      .toEqual({ action: "accept_not_present" });
  });

  it("accepts after the second look has been done", () => {
    expect(adjudicateNotFound("ingredients", pkg(), priors, { secondLookDone: true }))
      .toEqual({ action: "accept_not_present" });
  });
});

describe("applySemanticOutcome", () => {
  const entry = { productUrl: "https://shop.test/p/a", status: "pending" };

  it("accepts an enriched outcome with a trace", () => {
    const { applied, entry: updated } = applySemanticOutcome(entry, {
      status: "enriched",
      trace,
    }, pkg());
    expect(applied).toBe(true);
    expect(updated.status).toBe("enriched");
  });

  it("rejects enriched outcomes without a verification trace", () => {
    const { applied, errors } = applySemanticOutcome(entry, { status: "enriched" }, pkg());
    expect(applied).toBe(false);
    expect(errors).toContain("trace_evidence_missing");
  });

  it("requires reasons on review and gaps on needs_browser", () => {
    expect(applySemanticOutcome(entry, { status: "review" }).errors)
      .toContain("semantic_reason_missing");
    expect(applySemanticOutcome(entry, { status: "needs_browser", reason: "x" }).errors)
      .toContain("needs_browser_gaps_missing");
  });

  it("validates embedded not_present claims against the package coverage", () => {
    const holey = pkg();
    holey.coverage.gallerySaved = "0/1";
    const { applied, errors } = applySemanticOutcome(entry, {
      status: "enriched",
      trace,
      notPresent: [{ field: "facts_image", trace: { ...trace, verdict: "not_present" } }],
    }, holey);
    expect(applied).toBe(false);
    expect(errors.some((e) => e.startsWith("not_present_coverage_gap"))).toBe(true);
  });
});

describe("semanticQueueSummary", () => {
  it("reports drained only when every entry is terminal", () => {
    const queue = [
      { productUrl: "a", status: "enriched" },
      { productUrl: "b", status: "review", reason: "no taxonomy" },
      { productUrl: "c", status: "pending" },
    ];
    expect(semanticQueueSummary(queue)).toMatchObject({
      total: 3,
      drained: false,
      counts: { enriched: 1, review: 1, pending: 1, needs_browser: 0 },
    });
    queue[2].status = "needs_browser";
    expect(semanticQueueSummary(queue).drained).toBe(true);
    expect(semanticQueueSummary(queue).reviewRatio).toBeCloseTo(1 / 3);
  });
});
