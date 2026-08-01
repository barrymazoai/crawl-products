import { describe, expect, it } from "vitest";

import {
  buildSemanticEvidenceBrief,
  classifyFactsImageCandidate,
  finalizeFactsIngredientReview,
  finalizeFactsImageReview,
  finalizeGalleryReview,
  mergeProductSemanticEnrichment,
  normalizeProductSemanticEnrichment,
  semanticCompletion,
} from "./product-semantics.mjs";

describe("product semantics", () => {
  it("classifies explicit facts metadata without visual review", () => {
    expect(classifyFactsImageCandidate({
      url: "https://shop.test/media/facts.png",
      alt: "Supplement Facts",
      galleryIndex: 1,
    })).toMatchObject({
      decision: "classified",
      factsType: "Supplement Facts",
      requiresVisualReview: false,
      reason: "explicit_metadata",
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
      },
    });
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

  it("reports semantic omissions for model review instead of filling them with defaults", () => {
    expect(semanticCompletion({
      fields: {
        title: "Alpha",
        form: "powder",
        health_function: ["immune support"],
        main_ingredients: ["Vitamin C"],
        gallery_review: { status: "visual_complete", reviewed_image_urls: [] },
      },
    })).toEqual({ status: "complete", missing: [] });

    expect(semanticCompletion({ fields: { title: "Partial" } })).toEqual({
      status: "needs_model_review",
      missing: ["form", "health_function", "main_ingredients", "gallery_review"],
    });
  });
});
