import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runHarvest } from "./run-harvest.mjs";
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

  it("keeps scope exclusions as terminal states with reasons", async () => {
    const outDir = await makeOutDir();
    const urls = ["https://shop.test/p/single", "https://shop.test/p/bundle"];
    const hooks = baseHooks(urls);
    hooks.filterScope = (records) => ({
      included: records.filter((r) => !r.sourceUrl.includes("bundle")),
      excluded: records
        .filter((r) => r.sourceUrl.includes("bundle"))
        .map((r) => ({ ...r, _meta: { productScope: { reason: "bundle_pack_kit" } } })),
    });
    const result = await runHarvest(null, null, plan(), { outDir, hooks });
    expect(result.counts).toMatchObject({ complete: 1, excluded: 1 });
    expect(result.excluded[0]).toMatchObject({ reason: "bundle_pack_kit" });
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
