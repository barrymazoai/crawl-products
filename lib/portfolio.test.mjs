import { describe, expect, it } from "vitest";

import {
  assertPortfolioRouteWithinDepth,
  createRedirectPortfolioCandidate,
  createPortfolioProfile,
  discoverPortfolioCandidates,
  isAllowedPortfolioCandidate,
  normalizeDirectBrandSites,
} from "./portfolio.mjs";

describe("portfolio discovery", () => {
  const html = `
    <main>
      <section class="our-brands">
        <h2>Our Brands</h2>
        <a href="https://shop.parent.test/">Corporate Store</a>
        <a href="https://brand-a.test/">Brand A</a>
        <a href="https://brand-b.test/">Visit Brand B Store</a>
        <a href="https://amazon.test/brand-a">Buy on Amazon</a>
        <a href="https://instagram.test/parent">Instagram</a>
      </section>
    </main>
  `;

  it("nominates same-site stores and external brand roots but rejects marketplaces/social links", () => {
    const candidates = discoverPortfolioCandidates("https://parent.test", html);
    expect(candidates.map((candidate) => candidate.origin)).toContain("https://shop.parent.test");
    expect(candidates.map((candidate) => candidate.origin)).toContain("https://brand-a.test");
    expect(candidates.map((candidate) => candidate.origin)).toContain("https://brand-b.test");
    expect(candidates.some((candidate) => /amazon|instagram/.test(candidate.origin))).toBe(false);
  });

  it("requires an explicit cross-domain scope policy", () => {
    const candidates = discoverPortfolioCandidates("https://parent.test", html);
    const external = candidates.find((candidate) => candidate.origin === "https://brand-a.test");
    const sibling = candidates.find((candidate) => candidate.origin === "https://shop.parent.test");
    expect(isAllowedPortfolioCandidate(sibling)).toBe(true);
    expect(isAllowedPortfolioCandidate(external)).toBe(false);
    expect(isAllowedPortfolioCandidate(external, { scopeMode: "verified_brand_sites" })).toBe(true);
    expect(isAllowedPortfolioCandidate(external, {
      scopeMode: "explicit_allowlist",
      allowedOrigins: ["https://brand-a.test/path"],
    })).toBe(true);
  });

  it("persists verified brand relationships without sharing child extraction rules", () => {
    const profile = createPortfolioProfile("https://parent.test", [{
      origin: "https://brand-a.test",
      url: "https://brand-a.test/products",
      label: "Brand A",
      relation: "official_brand",
      confidence: 0.95,
      evidence: ["parent_site_link", "product_catalog"],
    }], { maxDepth: 9 });
    expect(profile.kind).toBe("crawl-products-portfolio-profile");
    expect(profile.version).toBe(2);
    expect(profile.scopeMode).toBe("same_site");
    expect(profile.maxDepth).toBe(1);
    expect(profile.directBrandOnly).toBe(true);
    expect(profile.sites[0]).toMatchObject({
      origin: "https://brand-a.test",
      brandOrigin: "https://brand-a.test",
      parentOrigin: "https://parent.test",
      depth: 1,
      entryUrl: "https://brand-a.test/products",
      relation: "official_brand",
      profileRef: null,
    });
  });

  it("keeps only direct brands and rejects explicitly nested descendants", () => {
    const normalized = normalizeDirectBrandSites("https://group.test", [{
      origin: "https://brand-a.test",
      url: "https://brand-a.test/catalog",
      depth: 1,
    }, {
      origin: "https://subbrand.test",
      parentOrigin: "https://brand-a.test",
      depth: 2,
    }]);

    expect(normalized.sites).toEqual([
      expect.objectContaining({
        parentOrigin: "https://group.test",
        brandOrigin: "https://brand-a.test",
        depth: 1,
        entryUrl: "https://brand-a.test/catalog",
      }),
    ]);
    expect(normalized.rejected).toEqual([
      expect.objectContaining({
        origin: "https://subbrand.test",
        reason: "portfolio_depth_exceeded",
      }),
    ]);
  });

  it("allows same-brand store handoff but blocks a brand-to-subbrand route", () => {
    expect(assertPortfolioRouteWithinDepth({
      steps: [{
        pageRole: "home",
        action: { relationType: "official_store_handoff" },
      }, {
        pageRole: "listing",
      }],
    }, 1)).toBe(true);

    expect(() => assertPortfolioRouteWithinDepth({
      steps: [{
        pageRole: "portfolio",
        action: { relationType: "portfolio_brand_site" },
      }],
    }, 1)).toThrow("portfolio_depth_exceeded");
  });

  it("treats a direct cross-domain redirect as a candidate, not implicit global scope", () => {
    const candidate = createRedirectPortfolioCandidate(
      "https://group.test",
      "https://brand-a.test/shop",
    );
    expect(candidate).toMatchObject({
      origin: "https://brand-a.test",
      relation: "official_brand_candidate",
      sameSite: false,
    });
    expect(candidate.evidence).toContain("direct_parent_redirect");
    expect(isAllowedPortfolioCandidate(candidate)).toBe(false);
    expect(isAllowedPortfolioCandidate(candidate, {
      scopeMode: "verified_brand_sites",
    })).toBe(true);
    expect(createRedirectPortfolioCandidate(
      "https://group.test",
      "https://amazon.com/group",
    )).toBeNull();
  });
});
