import { describe, expect, it } from "vitest";

import { HEALTH_FUNCTIONS } from "./health-functions.data.mjs";
import { matchHealthFunction, normalizeHealthFunctions } from "./health-function-vocab.mjs";

describe("health function controlled vocabulary", () => {
  it("loads the full canonical list with id + name", () => {
    expect(HEALTH_FUNCTIONS.length).toBe(658);
    expect(HEALTH_FUNCTIONS[0]).toMatchObject({ id: expect.any(String), name: "Immune Support" });
  });

  it("matches exact names case- and punctuation-insensitively", () => {
    expect(matchHealthFunction("Immune Support").name).toBe("Immune Support");
    expect(matchHealthFunction("immune support").name).toBe("Immune Support");
    expect(matchHealthFunction("ANTI-INFLAMMATORY").name).toBe("Anti-inflammatory");
  });

  it("resolves curated aliases the model tends to emit", () => {
    expect(matchHealthFunction("immunity").name).toBe("Immune Support");
    // "digestion" alias maps to Digestive Health (a bare "gut health" hits the
    // canonical "Gut Health" entry directly, since the vocab has both).
    expect(matchHealthFunction("digestion").name).toBe("Digestive Health");
    expect(matchHealthFunction("Joint And Musculoskeletal Support").name).toBe("Joint Health");
    expect(matchHealthFunction("Skin And Beauty Support").name).toBe("Skin Health");
    expect(matchHealthFunction("Energy and performance support").name).toBe("Energy Support");
  });

  it("returns null for terms not in the vocabulary (they go to review)", () => {
    expect(matchHealthFunction("Complete Meal Replacement")).toBeNull();
    expect(matchHealthFunction("High-Protein Nutrition")).toBeNull();
    expect(matchHealthFunction("")).toBeNull();
  });

  it("normalizes a list, dedupes matches, and separates unmatched", () => {
    const { matched, unmatched } = normalizeHealthFunctions([
      "Focus", "immunity", "Immune Support", "Complete Meal Replacement",
    ]);
    // immunity + Immune Support collapse to one canonical entry
    expect(matched.map((m) => m.name)).toEqual(["Focus", "Immune Support"]);
    expect(unmatched).toEqual(["Complete Meal Replacement"]);
  });
});
