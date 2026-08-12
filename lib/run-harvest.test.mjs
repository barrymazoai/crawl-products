import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runHarvest, updateRunState } from "./run-harvest.mjs";
import { filterHarvestStageRecords } from "./product-scope.mjs";
import { verifyRunArtifacts } from "./verify-run-artifacts.mjs";

const tmpDirs = [];

async function makeOutDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-harvest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function plan(overrides = {}) {
  return {
    site: { origin: "https://shop.test", entryUrl: "https://shop.test/", browserMode: "iab" },
    decision: { kind: "storefront", evidence: ["screenshot:entry.png"] },
    route: {
      listingSeeds: [{
        url: "https://shop.test/all",
        paginationMode: "click",
        nextAction: { selector: "button.more" },
      }],
      detailProfile: { fields: {} },
    },
    termination: {
      perSeed: [{
        url: "https://shop.test/all",
        exhaustionSignal: "no_new_urls_after_clicks:3",
      }],
      oracles: [],
      ...overrides.termination,
    },
    ...overrides,
  };
}

function record(url, title) {
  return {
    sourceUrl: url,
    fields: {
      title,
      images: [`https://cdn.test/${title.toLowerCase()}.jpg`],
      ingredients: "Vitamin C 500mg, Zinc 10mg",
      description: "supports immunity",
    },
  };
}

function baseHooks(urls) {
  return {
    enumerate: async () => ({
      productUrls: urls,
      coverage: {
        status: "complete",
        seedReports: [{
          seedUrl: "https://shop.test/all",
          status: "complete",
          endReason: "exhausted",
        }],
      },
    }),
    extract: async (chunk) => ({
      records: chunk.map((url, i) => record(url, `P${i}`)),
      needsUpgrade: [],
      failed: [],
    }),
    upgrade: async () => ({ records: [], failed: [], skipped: [] }),
    fetchImage: async () => ({ bytes: Buffer.from("img"), mime: "image/jpeg" }),
    fetchProductData: async () => null,
    filterScope: (records) => ({ included: records, excluded: [] }),
  };
}

describe("runHarvest lifecycle engine", () => {
  it("refuses an invalid plan before touching anything", async () => {
    const bad = plan();
    bad.termination.perSeed = [];
    await expect(runHarvest(null, null, bad, { outDir: await makeOutDir() }))
      .rejects.toThrow(/harvest_plan_invalid/);
  });

  it("requires outDir so progress is always persistable", async () => {
    await expect(runHarvest(null, null, plan(), {}))
      .rejects.toThrow(/outDir is required/);
  });

  it("runs to complete, writes evidence packages, and passes the Tier 1 audit", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/a", "https://shop.test/p/b"];
    const result = await runHarvest(null, null, plan(), {
      outDir,
      hooks: baseHooks(urls),
    });

    expect(result.status).toBe("complete");
    expect(result.counts).toEqual({
      discovered: 2, complete: 2, failed: 0, excluded: 0, remaining: 0,
    });

    const packages = JSON.parse(
      await fs.readFile(path.join(outDir, "evidence/records.json"), "utf8"),
    );
    expect(packages).toHaveLength(2);
    expect(packages[0].coverage.gallerySaved).toBe("1/1");
    const saved = await fs.readFile(path.join(outDir, packages[0].gallery[0].localPath));
    expect(saved.toString()).toBe("img");

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
    expect(audit.status).toBe("pass");
    expect(audit.claimedState).toBe("harvest_done");
  });

  it("finalizes incomplete when a seed does not exhaust", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a"]);
    hooks.enumerate = async () => ({
      productUrls: ["https://shop.test/p/a"],
      coverage: {
        status: "incomplete",
        seedReports: [{
          seedUrl: "https://shop.test/all",
          status: "incomplete",
          endReason: "max_pages_reached",
        }],
      },
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("seed_max_pages_reached");
    // Extraction still ran for what was discovered: partial progress is kept.
    expect(result.counts.complete).toBe(1);
  });

  it("treats an unsatisfied oracle as incomplete, never as complete", async () => {
    const outDir = await makeOutDir();
    const withOracle = plan({
      termination: {
        perSeed: [{
          url: "https://shop.test/all",
          exhaustionSignal: "no_new_urls_after_clicks:3",
        }],
        oracles: [{ type: "collection_count", expected: 5, source: "listing header" }],
      },
    });
    const result = await runHarvest(null, null, withOracle, {
      outDir,
      hooks: baseHooks(["https://shop.test/p/a", "https://shop.test/p/b"]),
    });
    expect(result.status).toBe("incomplete");
    expect(result.reasons).toContain("oracle_mismatch");
    expect(result.oracle[0]).toMatchObject({ status: "mismatch", observed: 2 });
  });

  it("records failed URLs as terminal states with an attempt history", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/good", "https://shop.test/p/bad"];
    const hooks = baseHooks(urls);
    hooks.extract = async (chunk) => ({
      records: chunk.filter((u) => u.includes("good")).map((u) => record(u, "Good")),
      needsUpgrade: chunk.filter((u) => u.includes("bad")),
      failed: [],
    });
    hooks.upgrade = async (chunk) => ({
      records: [],
      failed: chunk.map((url) => ({ url, reason: "navigation_timeout" })),
      skipped: [],
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });

    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ complete: 1, failed: 1, remaining: 0 });
    expect(result.failed[0]).toMatchObject({
      url: "https://shop.test/p/bad",
      reason: "navigation_timeout",
    });
    expect(result.failed[0].attempts.map((a) => a.method))
      .toEqual(["batch_content", "rendered_upgrade"]);

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
  });

  it("excludes explicit bundle URLs before any browser work is spent", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/single", "https://shop.test/p/bundle"];
    const hooks = baseHooks(urls);
    const extractedUrls = [];
    hooks.extract = async (chunk) => {
      extractedUrls.push(...chunk);
      return { records: chunk.map((u, i) => record(u, `P${i}`)), needsUpgrade: [], failed: [] };
    };
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.counts).toMatchObject({ complete: 1, excluded: 1 });
    expect(result.excluded[0]).toMatchObject({
      url: "https://shop.test/p/bundle",
      reason: "bundle_or_pack",
    });
    // The bundle URL never reached extraction — zero navigation retries burned.
    expect(extractedUrls).toEqual(["https://shop.test/p/single"]);
  });

  it("flags image download failures instead of failing the record", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a"]);
    hooks.fetchImage = async () => { throw new Error("http_403"); };
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.status).toBe("complete");
    const packages = JSON.parse(
      await fs.readFile(path.join(outDir, "evidence/records.json"), "utf8"),
    );
    expect(packages[0].flags.some((f) => f.startsWith("image_download_failed"))).toBe(true);
    expect(packages[0].coverage.gallerySaved).toBe("0/1");
  });

  it("trips the wall-clock watchdog into incomplete plus checkpoint", async () => {
    const outDir = await makeOutDir();
    let clock = 0;
    const hooks = baseHooks(["https://shop.test/p/a"]);
    const result = await runHarvest(null, null, plan(), {
      outDir,
      hooks,
      now: () => { clock += 45 * 60_000; return clock; },
    });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toMatch(/wall_clock_budget_exhausted|stall_watchdog_tripped/);
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(outDir, "checkpoint.json"), "utf8"),
    );
    expect(checkpoint).toHaveProperty("discovered");
  });

  it("falls back to sequential rendered extraction on bindings without a batch API (IAB)", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/a", "https://shop.test/p/b"];
    const hooks = baseHooks(urls);
    delete hooks.extract; // use the engine default against a batch-less binding
    let upgradedUrls = [];
    hooks.upgrade = async (chunk) => {
      upgradedUrls.push(...chunk);
      return { records: chunk.map((u, i) => record(u, `U${i}`)), failed: [], skipped: [] };
    };
    const iabLikeBrowser = { tabs: { new: async () => ({}) } }; // no tabs.content

    const result = await runHarvest(iabLikeBrowser, null, plan(), { outDir, hooks });
    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ complete: 2, failed: 0 });
    expect(upgradedUrls).toEqual(urls);

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
  });

  it("does not record a phantom batch attempt when the batch API is unavailable", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/bad"]);
    delete hooks.extract;
    hooks.upgrade = async (chunk) => ({
      records: [],
      failed: chunk.map((url) => ({ url, reason: "navigation_timeout" })),
      skipped: [],
    });
    const result = await runHarvest({ tabs: {} }, null, plan(), { outDir, hooks });
    expect(result.counts).toMatchObject({ failed: 1 });
    expect(result.failed[0].attempts.map((a) => a.method)).toEqual(["rendered_upgrade"]);
  });

  it("defers nutrition judgment at harvest: evidence-less records stay included", async () => {
    const outDir = await makeOutDir();
    const urls = [
      "https://shop.test/products/whey-protein",
      "https://shop.test/products/ultimate-gut-bundle",
    ];
    const hooks = baseHooks(urls);
    delete hooks.filterScope; // use the engine default (harvest-stage filter)
    hooks.extract = async (chunk) => ({
      // records deliberately carry no ingredients/facts evidence
      records: chunk.map((url, i) => ({
        sourceUrl: url,
        fields: { title: `P${i}`, images: [`https://cdn.test/p${i}.jpg`] },
      })),
      needsUpgrade: [],
      failed: [],
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    // The protein record has no semantic evidence yet — must NOT be excluded.
    expect(result.counts).toMatchObject({ complete: 1, excluded: 1, failed: 0 });
    expect(result.excluded[0]).toMatchObject({
      url: "https://shop.test/products/ultimate-gut-bundle",
      reason: "bundle_or_pack",
    });
  });

  it("resumes from checkpoint without redoing processed URLs", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/a", "https://shop.test/p/b"];
    let extractCalls = 0;

    const failingHooks = baseHooks(urls);
    failingHooks.extract = async (chunk) => {
      extractCalls += chunk.length;
      // First run: only extract the first URL, then die on the second chunk.
      if (chunk.includes("https://shop.test/p/b")) throw new Error("binding_lost");
      return { records: chunk.map((u, i) => record(u, `P${i}`)), needsUpgrade: [], failed: [] };
    };
    // Chunk size is 5, so force per-URL chunks by seeding one URL first run.
    failingHooks.enumerate = async () => ({
      productUrls: ["https://shop.test/p/a"],
      coverage: { status: "complete", seedReports: [{ seedUrl: "https://shop.test/all", status: "complete", endReason: "exhausted" }] },
    });
    await runHarvest(null, null, plan(), { outDir, hooks: failingHooks });
    expect(extractCalls).toBe(1);

    const resumeHooks = baseHooks(urls);
    resumeHooks.extract = async (chunk) => {
      extractCalls += chunk.length;
      return { records: chunk.map((u, i) => record(u, `R${i}`)), needsUpgrade: [], failed: [] };
    };
    const second = await runHarvest(null, null, plan(), {
      outDir,
      resume: true,
      hooks: resumeHooks,
    });
    expect(second.status).toBe("complete");
    expect(second.counts).toMatchObject({ discovered: 2, complete: 2, remaining: 0 });
    // p/a was processed in run one and must not be re-extracted on resume.
    expect(extractCalls).toBe(2);
  });
});

describe("filterHarvestStageRecords (harvest-stage scope)", () => {
  it("includes evidence-less records and marks the judgment deferred", () => {
    const { included, excluded } = filterHarvestStageRecords([
      { sourceUrl: "https://shop.test/products/whey-protein",
        fields: { title: "Whey Protein" } },
    ]);
    expect(excluded).toEqual([]);
    expect(included[0]._meta.productScope.reason).toBe("deferred_to_semantic_stage");
  });

  it("excludes explicit bundle URLs with a recorded reason", () => {
    const { included, excluded } = filterHarvestStageRecords([
      { sourceUrl: "https://shop.test/products/starter-kit-bundle",
        fields: { title: "Starter Kit" } },
    ]);
    expect(included).toEqual([]);
    expect(excluded[0]._meta.productScope.reason).toBe("bundle_or_pack");
  });
});

describe("updateRunState (exclusive state.json writer)", () => {
  it("writes the fixed schema and appends worker notes separately", async () => {
    const outDir = await makeOutDir();
    await updateRunState(outDir, "semantic_done", "queue drained after 10/10", {
      now: () => 1000,
    });
    const state = JSON.parse(await fs.readFile(path.join(outDir, "state.json"), "utf8"));
    expect(state).toEqual({ state: "semantic_done", updatedAtMs: 1000 });
    const notes = JSON.parse(
      await fs.readFile(path.join(outDir, "worker-notes.json"), "utf8"),
    );
    expect(notes).toEqual([
      { state: "semantic_done", atMs: 1000, notes: "queue drained after 10/10" },
    ]);
  });

  it("rejects states outside the machine", async () => {
    const outDir = await makeOutDir();
    await expect(updateRunState(outDir, "done_i_promise"))
      .rejects.toThrow(/invalid_run_state/);
  });
});

describe("fixes from the BIOHM rerun (E/F/G/H)", () => {
  it("E: preserves route.listingProfile and hands it to enumeration", async () => {
    const outDir = await makeOutDir();
    const withProfile = plan();
    withProfile.route.listingProfile = { productLinkSelectors: [".product-card a"] };
    let seenListingProfile = null;
    const hooks = baseHooks(["https://shop.test/p/a"]);
    hooks.enumerate = async (seeds, enumerateOpts) => {
      seenListingProfile = enumerateOpts.listingProfile;
      return {
        productUrls: ["https://shop.test/p/a"],
        coverage: {
          status: "complete",
          seedReports: [{ seedUrl: "https://shop.test/all", status: "complete", endReason: "exhausted" }],
        },
      };
    };
    await runHarvest(null, null, withProfile, { outDir, hooks });
    expect(seenListingProfile).toEqual({ productLinkSelectors: [".product-card a"] });
  });

  it("F: a replaced tab returned by the upgrade hook propagates to the run", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/a"];
    const hooks = baseHooks(urls);
    hooks.extract = async (chunk) => ({ records: [], needsUpgrade: [...chunk], failed: [] });
    const freshTab = { id: "fresh-after-taint" };
    hooks.upgrade = async (chunk) => ({
      records: chunk.map((u, i) => record(u, `U${i}`)),
      failed: [],
      skipped: [],
      tab: freshTab,
    });
    const result = await runHarvest(null, { id: "original" }, plan(), { outDir, hooks });
    expect(result.activeTab).toBe(freshTab);
  });

  it("H: acceptProductLimit turns a capped run into an honest complete", async () => {
    const outDir = await makeOutDir();
    const capped = plan({
      termination: {
        perSeed: [{ url: "https://shop.test/all", exhaustionSignal: "no_new_urls_after_clicks:3" }],
        oracles: [{ type: "collection_count", expected: 15, source: "listing header" }],
        budgets: { maxItems: 2 },
      },
    });
    const urls = ["https://shop.test/p/a", "https://shop.test/p/b"];
    const hooks = baseHooks(urls);
    hooks.enumerate = async () => ({
      productUrls: urls,
      coverage: {
        status: "incomplete",
        seedReports: [{
          seedUrl: "https://shop.test/all",
          status: "incomplete",
          endReason: "max_items_reached",
        }],
      },
    });
    const result = await runHarvest(null, null, capped, {
      outDir,
      hooks,
      acceptProductLimit: true,
    });
    expect(result.status).toBe("complete");
    expect(result.reasons).toEqual([]);
    expect(result.oracle[0]).toMatchObject({ status: "capped", observed: 2, cappedAt: 2 });
    expect(result.productLimit).toEqual({ accepted: true, maxItems: 2 });

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
  });

  it("H: without acceptProductLimit a capped run stays incomplete (no silent cap)", async () => {
    const outDir = await makeOutDir();
    const capped = plan({
      termination: {
        perSeed: [{ url: "https://shop.test/all", exhaustionSignal: "no_new_urls_after_clicks:3" }],
        oracles: [{ type: "collection_count", expected: 15, source: "listing header" }],
        budgets: { maxItems: 2 },
      },
    });
    const hooks = baseHooks(["https://shop.test/p/a", "https://shop.test/p/b"]);
    hooks.enumerate = async () => ({
      productUrls: ["https://shop.test/p/a", "https://shop.test/p/b"],
      coverage: {
        status: "incomplete",
        seedReports: [{
          seedUrl: "https://shop.test/all",
          status: "incomplete",
          endReason: "max_items_reached",
        }],
      },
    });
    const result = await runHarvest(null, null, capped, { outDir, hooks });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("max_items_reached");
  });
});

describe("platform variant expansion and SKU backfill", () => {
  const shopifyProduct = {
    id: 1,
    options: [{ name: "Strength" }, { name: "Flavor" }],
    variants: [
      { id: 111, title: "1000mg / Cinnamon", option1: "1000mg", option2: "Cinnamon",
        sku: "FS1000CIN", price: "89.00", available: false },
      { id: 222, title: "1000mg / Natural", option1: "1000mg", option2: "Natural",
        sku: "FS1000NAT", price: "89.00", available: true,
        featured_image: { src: "https://cdn.test/nat.jpg" } },
    ],
  };

  it("captures every sellable state and backfills the default variant sku", async () => {
    const outDir = await makeOutDir();
    const url = "https://shop.test/products/full-spectrum-extract";
    const hooks = baseHooks([url]);
    hooks.fetchProductData = async () => shopifyProduct;
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.counts.complete).toBe(1);

    const [pkg] = JSON.parse(
      await fs.readFile(path.join(outDir, "evidence/records.json"), "utf8"),
    );
    expect(pkg.variants).toHaveLength(2);
    expect(pkg.variants[0]).toMatchObject({
      variantId: "111",
      sku: "FS1000CIN",
      options: { Strength: "1000mg", Flavor: "Cinnamon" },
      url: "https://shop.test/products/full-spectrum-extract?variant=111",
    });
    expect(pkg.variants[1].imageUrl).toBe("https://cdn.test/nat.jpg");
    // Default sku comes from the first *available* variant, not merely the first.
    expect(pkg.fields.sku).toBe("FS1000NAT");
  });

  it("leaves the package untouched when no platform data exists", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a"]);
    hooks.fetchProductData = async () => null;
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    const [pkg] = JSON.parse(
      await fs.readFile(path.join(outDir, "evidence/records.json"), "utf8"),
    );
    expect(pkg.variants).toBeUndefined();
    expect(pkg.fields.sku).toBeUndefined();
    expect(result.counts.complete).toBe(1);

    const audit = await verifyRunArtifacts(outDir);
    expect(audit.problems).toEqual([]);
  });

  it("never fails a record because the platform probe threw", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/products/alpha"]);
    hooks.fetchProductData = async () => { throw new Error("http_500"); };
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.counts).toMatchObject({ complete: 1, failed: 0 });
  });
});

describe("binding death is resumable, never a terminal URL state (sebastar case)", () => {
  it("aborts to incomplete+checkpoint when upgrade failures are binding-level", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/a", "https://shop.test/p/b", "https://shop.test/p/c"];
    const hooks = baseHooks(urls);
    hooks.extract = async (chunk) => ({
      records: chunk.filter((u) => u.endsWith("/a")).map((u) => record(u, "A")),
      needsUpgrade: chunk.filter((u) => !u.endsWith("/a")),
      failed: [],
    });
    hooks.upgrade = async (chunk) => ({
      records: [],
      failed: chunk.map((url) => ({
        url,
        reason: "Error: Browser is not available: -84d7-4fc3",
      })),
      skipped: [],
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });

    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("binding_lost");
    // Work done before the death is kept; the victims stay retryable.
    expect(result.counts).toMatchObject({ complete: 1, failed: 0, remaining: 2 });

    // Resume with a healthy binding finishes the job.
    const healthy = baseHooks(urls);
    healthy.extract = async (chunk) => ({
      records: chunk.map((u, i) => record(u, `R${i}`)), needsUpgrade: [], failed: [],
    });
    const second = await runHarvest(null, null, plan(), {
      outDir, resume: true, hooks: healthy,
    });
    expect(second.status).toBe("complete");
    expect(second.counts).toMatchObject({ complete: 3, failed: 0, remaining: 0 });
  });

  it("aborts resumable when a browser call goes idle (no progress) past the deadline", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a", "https://shop.test/p/b"]);
    // extract never settles AND never pings — a genuine hang.
    hooks.extract = () => new Promise(() => {});
    const result = await runHarvest(null, null, plan(), {
      outDir,
      hooks,
      operationIdleMs: 60,
    });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("binding_lost");
    // Nothing was terminal-failed; the URLs stay retryable on resume.
    expect(result.counts).toMatchObject({ complete: 0, failed: 0, remaining: 2 });
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(outDir, "checkpoint.json"), "utf8"),
    );
    expect(checkpoint.discovered).toContain("https://shop.test/p/a");
  });

  it("does NOT abort a slow call that keeps reporting progress", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a", "https://shop.test/p/b"]);
    // Total runtime (~250ms) far exceeds the 60ms idle deadline, but the hook
    // pings every 30ms — a slow-but-alive site must not be killed.
    hooks.extract = async (chunk, opts) => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 30));
        opts.onProgress?.();
      }
      return { records: chunk.map((u, i) => record(u, `P${i}`)), needsUpgrade: [], failed: [] };
    };
    const result = await runHarvest(null, null, plan(), {
      outDir,
      hooks,
      operationIdleMs: 60,
    });
    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ complete: 2, failed: 0, remaining: 0 });
  });

  it("treats a throwing extract hook as resumable, not as a crash or failures", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/a"]);
    hooks.extract = async () => { throw new Error("Browser is not available: gone"); };
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.status).toBe("incomplete");
    expect(result.reasons.join()).toContain("binding_lost:extract_exception");
    expect(result.counts).toMatchObject({ complete: 0, failed: 0, remaining: 1 });
  });

  it("still terminal-fails page-level errors after the retry ladder", async () => {
    const outDir = await makeOutDir();
    const hooks = baseHooks(["https://shop.test/p/bad"]);
    hooks.extract = async (chunk) => ({ records: [], needsUpgrade: [...chunk], failed: [] });
    hooks.upgrade = async (chunk) => ({
      records: [],
      failed: chunk.map((url) => ({ url, reason: "single_url_watchdog_timeout" })),
      skipped: [],
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ failed: 1, remaining: 0 });
  });
});

describe("defaultFetchImage (browser-dressed HTTP with retry)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sends a browser UA and a same-origin referer", async () => {
    const { defaultFetchImage } = await import("./run-harvest.mjs");
    let seen;
    globalThis.fetch = async (url, opts) => {
      seen = opts.headers;
      return { ok: true, headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const out = await defaultFetchImage("https://cdn.test/x.jpg");
    expect(out.mime).toBe("image/jpeg");
    expect(seen["user-agent"]).toMatch(/Mozilla/);
    expect(seen.referer).toBe("https://cdn.test/");
  });

  it("retries once on 5xx then succeeds", async () => {
    const { defaultFetchImage } = await import("./run-harvest.mjs");
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, headers: { get: () => "" } };
      return { ok: true, headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([9]).buffer };
    };
    const out = await defaultFetchImage("https://cdn.test/y.png");
    expect(calls).toBe(2);
    expect(out.mime).toBe("image/png");
  });

  it("does not retry a 403 and surfaces it", async () => {
    const { defaultFetchImage } = await import("./run-harvest.mjs");
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: false, status: 403, headers: { get: () => "" } }; };
    await expect(defaultFetchImage("https://cdn.test/z.jpg")).rejects.toThrow(/http_403/);
    expect(calls).toBe(1);
  });
});
