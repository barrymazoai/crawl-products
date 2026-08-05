import { describe, expect, it } from "vitest";

import {
  buildSemanticEvidenceBrief,
  classifyFactsImageCandidate,
  finalizeFactsIngredientReview,
  finalizeFactsImageReview,
  finalizeFactsSourceReview,
  finalizeGalleryReview,
  mergeProductSemanticEnrichment,
  normalizeProductSemanticEnrichment,
  semanticCompletion,
} from "./product-semantics.mjs";

describe("product semantics", () => {
  it("treats explicit Facts metadata as a candidate that still needs visual review", () => {
    expect(classifyFactsImageCandidate({
      url: "https://shop.test/media/facts.png",
      alt: "Supplement Facts",
      galleryIndex: 1,
    })).toMatchObject({
      decision: "visual_review",
      factsType: "Supplement Facts",
      requiresVisualReview: true,
      reason: "explicit_metadata_candidate",
    });
  });

  it("routes ingredient-labelled gallery images to visual review", () => {
    expect(classifyFactsImageCandidate({
      url: "https://us.shaklee.com/medias/34034-02.png",
      alt: "Activate Ingredients",
      galleryIndex: 1,
    })).toEqual({
      decision: "visual_review",
      factsType: null,
      requiresVisualReview: true,
      reason: "ambiguous_label_or_asset_name",
      image: {
        url: "https://us.shaklee.com/medias/34034-02.png",
        alt: "Activate Ingredients",
        title: null,
        galleryIndex: 1,
      },
    });
  });

  it("routes unlabeled secondary gallery images to visual review", () => {
    expect(classifyFactsImageCandidate({
      url: "https://shop.test/media/back.png",
      galleryIndex: 2,
    })).toMatchObject({
      decision: "visual_review",
      reason: "unlabeled_secondary_gallery_image",
    });
  });

  it("records a visually confirmed facts image even when alt is misleading", () => {
    const candidate = classifyFactsImageCandidate({
      url: "https://us.shaklee.com/medias/34034-02.png",
      alt: "Activate Ingredients",
      galleryIndex: 1,
    });
    expect(finalizeFactsImageReview(candidate, {
      reviewedVisually: true,
      isFactsImage: true,
      factsType: "Supplement Facts",
      visibleHeading: "Supplement Facts",
    })).toEqual({
      type: "Supplement Facts",
      image_url: "https://us.shaklee.com/medias/34034-02.png",
      alt: "Activate Ingredients",
      gallery_index: 1,
      classification_basis: "visual_content",
      evidence: "Supplement Facts",
    });
  });

  it("does not turn an ambiguous ingredient image into facts without review", () => {
    const candidate = classifyFactsImageCandidate({
      url: "https://shop.test/media/ingredients.png",
      alt: "Ingredients",
      galleryIndex: 1,
    });
    expect(finalizeFactsImageReview(candidate, {
      reviewedVisually: true,
      isFactsImage: false,
    })).toBeNull();
  });

  it("closes a gallery only after every image has an explicit visual decision", () => {
    const images = ["https://cdn.test/front.jpg", "https://cdn.test/facts.jpg"];
    expect(finalizeGalleryReview(images, [
      {
        url: images[0],
        reviewedVisually: true,
        isFactsImage: false,
      },
      {
        url: images[1],
        reviewedVisually: true,
        isFactsImage: true,
        factsType: "Supplement Facts",
        visibleHeading: "Supplement Facts",
      },
    ])).toEqual({
      fields: {
        gallery_review: {
          status: "visual_complete",
          image_count: 2,
          reviewed_image_urls: images,
          facts_status: "confirmed",
          facts_image_count: 1,
        },
      },
      meta: {
        galleryReview: {
          status: "visual_complete",
          image_count: 2,
          reviewed_image_urls: images,
          facts_status: "confirmed",
          facts_image_count: 1,
        },
      },
    });

    expect(() => finalizeGalleryReview(images, [{
      url: images[0],
      reviewedVisually: true,
      isFactsImage: false,
    }])).toThrow("gallery image was not visually reviewed");
  });

  it("reads Carb Blocker's main ingredient from the Facts image without a site lexicon", () => {
    const factsImage = {
      type: "Supplement Facts",
      image_url: "https://cdn.test/modere-carb-blocker-facts.jpg",
    };
    expect(finalizeFactsIngredientReview(factsImage, {
      reviewedVisually: true,
      visibleHeading: "Supplement Facts",
      ingredients: [
        {
          name: "White Kidney Bean Extract",
          visibleText: "White Kidney Bean Extract",
          substance: "White Kidney Bean",
          category: "herbs_botanicals",
          confidence: "high",
        },
        {
          name: "Hibiscus Flower Extract",
          visibleText: "Hibiscus Flower Extract",
          substance: "Hibiscus",
          category: "herbs_botanicals",
          confidence: "high",
        },
      ],
    })).toEqual({
      fields: {
        main_ingredients: [
          {
            name: "White Kidney Bean Extract",
            substance: "White Kidney Bean",
            category: "herbs_botanicals",
          },
          {
            name: "Hibiscus Flower Extract",
            substance: "Hibiscus",
            category: "herbs_botanicals",
          },
        ],
      },
      meta: {
        semanticInferences: {
          main_ingredients: [
            {
              value: "White Kidney Bean Extract",
              basis: "explicit",
              confidence: "high",
              evidence: [{
                source: "facts_image",
                excerpt: "White Kidney Bean Extract",
              }],
              taxonomy: {
                substance: "White Kidney Bean",
                category: "herbs_botanicals",
              },
            },
            {
              value: "Hibiscus Flower Extract",
              basis: "explicit",
              confidence: "high",
              evidence: [{
                source: "facts_image",
                excerpt: "Hibiscus Flower Extract",
              }],
              taxonomy: {
                substance: "Hibiscus",
                category: "herbs_botanicals",
              },
            },
          ],
        },
        factsIngredientReview: {
          status: "visual_complete",
          result: "ingredients_read",
          image_url: "https://cdn.test/modere-carb-blocker-facts.jpg",
          facts_type: "Supplement Facts",
          visible_heading: "Supplement Facts",
          ingredient_count: 2,
        },
        factsIngredientReviews: [{
          status: "visual_complete",
          result: "ingredients_read",
          image_url: "https://cdn.test/modere-carb-blocker-facts.jpg",
          facts_type: "Supplement Facts",
          visible_heading: "Supplement Facts",
          ingredient_count: 2,
        }],
      },
    });
  });

  it("merges ingredients and review evidence from every Facts image", () => {
    let record = { fields: { title: "Two-panel product" }, _meta: {} };
    record = mergeProductSemanticEnrichment(record, finalizeFactsIngredientReview({
      type: "Supplement Facts",
      image_url: "https://cdn.test/facts-1.jpg",
    }, {
      reviewedVisually: true,
      visibleHeading: "Supplement Facts",
      ingredients: [{
        name: "Vitamin C",
        visibleText: "Vitamin C 500 mg",
        substance: "Vitamin C",
        category: "vitamins",
      }],
    }));
    record = mergeProductSemanticEnrichment(record, finalizeFactsIngredientReview({
      type: "Supplement Facts",
      image_url: "https://cdn.test/facts-2.jpg",
    }, {
      reviewedVisually: true,
      visibleHeading: "Supplement Facts",
      ingredients: [{
        name: "Zinc Citrate",
        visibleText: "Zinc (as Zinc Citrate) 10 mg",
        substance: "Zinc",
        form: "Zinc Citrate",
        category: "minerals",
      }],
    }));

    expect(record.fields.main_ingredients).toHaveLength(2);
    expect(record._meta.semanticInferences.main_ingredients).toHaveLength(2);
    expect(record._meta.factsIngredientReviews.map((review) => review.image_url)).toEqual([
      "https://cdn.test/facts-1.jpg",
      "https://cdn.test/facts-2.jpg",
    ]);
  });

  it("requires both DOM/page elements and gallery Facts sources to be checked", () => {
    const gallery = finalizeGalleryReview(["https://cdn.test/front.jpg"], [{
      url: "https://cdn.test/front.jpg",
      reviewedVisually: true,
      isFactsImage: false,
    }]);
    expect(finalizeFactsSourceReview({
      pageElements: { checked: true, result: "not_present" },
      galleryReview: gallery,
    })).toMatchObject({
      fields: {
        facts_source_review: {
          status: "complete",
          page_elements: { checked: true, result: "not_present" },
          gallery: { checked: true, result: "not_present" },
        },
      },
    });
    expect(() => finalizeFactsSourceReview({
      pageElements: { checked: false, result: "not_present" },
      galleryReview: gallery,
    })).toThrow("must check page elements");
  });

  it("rejects Facts ingredients that were not read visually", () => {
    expect(() => finalizeFactsIngredientReview({
      type: "Supplement Facts",
      image_url: "https://cdn.test/facts.jpg",
    }, {
      reviewedVisually: false,
      visibleHeading: "Supplement Facts",
      ingredients: [{
        name: "Vitamin C",
        visibleText: "Vitamin C 500 mg",
      }],
    })).toThrow("must be completed visually");
  });

  it("does not accept a Facts classification from alt text without a visual review", () => {
    const candidate = classifyFactsImageCandidate({
      url: "https://cdn.test/facts.jpg",
      alt: "Supplement Facts",
      galleryIndex: 1,
    });
    expect(() => finalizeFactsImageReview(candidate, {
      isFactsImage: true,
      factsType: "Supplement Facts",
      visibleHeading: "Supplement Facts",
    })).toThrow("must be completed visually");
  });

  it("normalizes evidence-backed form, health function, and main ingredients", () => {
    expect(normalizeProductSemanticEnrichment({
      form: {
        value: "powder",
        presentation: "single-serving packets",
        basis: "inferred",
        confidence: "high",
        rationale: "Serving size and package text identify a powdered packet format.",
        evidence: [
          { source: "supplement_facts_image", excerpt: "Serving Size 1 Packet (9 g)" },
        ],
      },
      healthFunction: [
        {
          value: "digestive health support",
          basis: "inferred",
          confidence: "high",
          rationale: "The page positions the cleanse around digestive energy.",
          evidence: [
            { source: "description", excerpt: "ignite your digestive energy" },
          ],
        },
      ],
      mainIngredients: [
        {
          value: "Vitamin C",
          basis: "explicit",
          confidence: "high",
          evidence: [
            { source: "supplement_facts_image", excerpt: "Vitamin C 500 mg" },
          ],
        },
        {
          value: "Green Tea Extract",
          basis: "inferred",
          confidence: "medium",
          rationale: "The standardized botanical source identifies the principal active extract.",
          substance: "Green Tea",
          form: "Green Tea Extract",
          category: "Herbs & Botanicals",
          evidence: [
            { source: "ingredients", excerpt: "Green tea leaf extract standardized to polyphenols" },
          ],
        },
      ],
    })).toMatchObject({
      fields: {
        form: "powder",
        form_presentation: "single-serving packets",
        health_function: ["digestive health support"],
        main_ingredients: [
          "Vitamin C",
          {
            name: "Green Tea Extract",
            substance: "Green Tea",
            form: "Green Tea Extract",
            category: "herbs_botanicals",
          },
        ],
      },
      meta: {
        semanticInferences: {
          form: {
            basis: "inferred",
            confidence: "high",
          },
          health_function: [{
            value: "digestive health support",
            basis: "inferred",
            confidence: "high",
          }],
          main_ingredients: [
            {
              value: "Vitamin C",
              basis: "explicit",
              confidence: "high",
            },
            {
              value: "Green Tea Extract",
              basis: "inferred",
              confidence: "medium",
              taxonomy: {
                substance: "Green Tea",
                form: "Green Tea Extract",
                category: "herbs_botanicals",
              },
            },
          ],
        },
      },
    });
  });

  it("requires evidence and rationale for inferred values", () => {
    expect(() => normalizeProductSemanticEnrichment({
      form: {
        value: "powder",
        basis: "inferred",
        confidence: "high",
        evidence: [{ source: "image", excerpt: "packet" }],
      },
    })).toThrow("inferred values require a rationale");
  });

  it("rejects treatment claims and low-confidence guesses", () => {
    expect(() => normalizeProductSemanticEnrichment({
      healthFunction: [{
        value: "treats digestive disease",
        basis: "inferred",
        confidence: "medium",
        rationale: "Unsupported",
        evidence: [{ source: "description", excerpt: "digestive" }],
      }],
    })).toThrow("unsupported treatment or prevention claim");

    expect(() => normalizeProductSemanticEnrichment({
      form: {
        value: "powder",
        basis: "explicit",
        confidence: "low",
        evidence: [{ source: "title", excerpt: "Powder" }],
      },
    })).toThrow("confidence must be high or medium");
  });

  it("requires substance when an ingredient supplies form or category taxonomy", () => {
    expect(() => normalizeProductSemanticEnrichment({
      mainIngredients: [{
        value: "Ascorbic Acid",
        basis: "explicit",
        confidence: "high",
        form: "Ascorbic Acid",
        category: "vitamins",
        evidence: [{ source: "facts_image", excerpt: "Vitamin C (Ascorbic Acid)" }],
      }],
    })).toThrow("taxonomy form/category requires substance");
  });

  it("merges normalized fields without discarding extraction metadata", () => {
    const record = {
      fields: { title: "Example" },
      _meta: { fieldSources: { title: [{ source: "dom" }] } },
    };
    const merged = mergeProductSemanticEnrichment(record, {
      form: {
        value: "capsule",
        basis: "explicit",
        confidence: "high",
        evidence: [{ source: "title", excerpt: "Capsules" }],
      },
    });
    expect(merged.fields).toMatchObject({ title: "Example", form: "capsule" });
    expect(merged._meta.fieldSources.title).toEqual([{ source: "dom" }]);
    expect(merged._meta.semanticInferences.form.value).toBe("capsule");
  });

  it("builds a bounded evidence brief for model-led semantic reasoning", () => {
    const brief = buildSemanticEvidenceBrief({
      sourceUrl: "https://shop.test/products/alpha",
      fields: {
        title: "Alpha Powder",
        description: "Supports everyday immune health.",
        ingredients: "Vitamin C and zinc.",
        images: ["https://cdn.test/front.jpg", "https://cdn.test/facts.jpg"],
        facts_images: [{ image_url: "https://cdn.test/facts.jpg" }],
      },
    });
    expect(brief).toMatchObject({
      productUrl: "https://shop.test/products/alpha",
      title: "Alpha Powder",
      description: "Supports everyday immune health.",
      ingredients: "Vitamin C and zinc.",
      images: ["https://cdn.test/front.jpg", "https://cdn.test/facts.jpg"],
      factsImages: [{ image_url: "https://cdn.test/facts.jpg" }],
    });
  });

  it("does not treat an Ingredients accordion heading as ingredient evidence", () => {
    const brief = buildSemanticEvidenceBrief({
      sourceUrl: "https://shop.test/products/heading-only",
      fields: {
        title: "Heading Only Capsule",
        ingredients: "Ingredients",
        supplement_facts: "Supplement Facts",
        description: "Supports everyday immune health.",
        facts_images: [{ image_url: "https://cdn.test/facts.jpg" }],
      },
    });
    expect(brief.ingredients).toBeNull();
    expect(brief.supplementFacts).toBeNull();
    expect(brief.sourceGaps).toEqual(expect.arrayContaining([
      "ingredients_content",
      "form",
      "health_function",
      "main_ingredients",
    ]));
    expect(brief.nextActions).toEqual(expect.arrayContaining([
      "read_each_facts_or_label_image_for_ingredient_rows",
      "infer_health_function_from_description_category_benefit_copy",
    ]));
  });

  it("reports semantic omissions for model review instead of filling them with defaults", () => {
    const gallery = finalizeGalleryReview(["https://cdn.test/front.jpg"], [{
      url: "https://cdn.test/front.jpg",
      reviewedVisually: true,
      isFactsImage: false,
    }]);
    let complete = {
      fields: {
        title: "Alpha",
        ...gallery.fields,
      },
      _meta: { ...gallery.meta },
    };
    complete = mergeProductSemanticEnrichment(complete, normalizeProductSemanticEnrichment({
      form: {
        value: "powder",
        basis: "explicit",
        confidence: "high",
        evidence: [{ source: "title", excerpt: "Alpha Powder" }],
      },
      healthFunction: [{
        value: "immune support",
        basis: "explicit",
        confidence: "high",
        evidence: [{ source: "description", excerpt: "supports immune health" }],
      }],
      mainIngredients: [{
        value: "Vitamin C",
        basis: "explicit",
        confidence: "high",
        substance: "Vitamin C",
        category: "vitamins",
        evidence: [{ source: "ingredients", excerpt: "Vitamin C" }],
      }],
    }));
    complete = mergeProductSemanticEnrichment(complete, finalizeFactsSourceReview({
      pageElements: { checked: true, result: "not_present" },
      galleryReview: gallery,
    }));
    expect(semanticCompletion(complete)).toEqual({ status: "complete", missing: [] });

    expect(semanticCompletion({ fields: { title: "Partial" } })).toEqual({
      status: "needs_model_review",
      missing: [
        "form",
        "health_function",
        "main_ingredients",
        "gallery_review",
        "facts_source_review",
      ],
    });

    expect(semanticCompletion({
      fields: {
        form: "capsule",
        health_function: ["immune support"],
        main_ingredients: ["Vitamin C"],
        gallery_review: { status: "visual_complete", reviewed_image_urls: [] },
      },
    }, { requireFactsSourceReview: false })).toEqual({
      status: "needs_model_review",
      missing: [
        "main_ingredient_taxonomy",
        "form_evidence",
        "health_function_evidence",
        "main_ingredient_evidence",
      ],
    });
  });
});
