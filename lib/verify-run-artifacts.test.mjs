import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyRunArtifacts, writeVerificationReport } from "./verify-run-artifacts.mjs";

const tmpDirs = [];

async function makeRun(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-audit-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const trace = {
  verdict: "not_present",
  method: "visual_image_read",
  surface: "local_file",
  evidence: ["evidence/img/a1.jpg"],
  verifier: "semantic:ingredients",
};

function completeRunFiles() {
  return {
    "state.json": { state: "harvest_done" },
    "harvest-plan.json": { site: {} },
    "harvest-result.json": {
      counts: { discovered: 3, complete: 1, failed: 1, excluded: 1, remaining: 0 },
      failed: [{ url: "https://shop.test/p/b", reason: "http_404" }],
      excluded: [{ url: "https://shop.test/p/c", reason: "bundle" }],
    },
    "evidence/records.json": [{
      productUrl: "https://shop.test/p/a",
      fields: { title: "Alpha" },
      gallery: [{ url: "https://cdn.test/a.jpg", localPath: "evidence/img/a1.jpg" }],
      coverage: {
        gallerySaved: "1/1",
        domSectionsExpanded: ["Description"],
        jsonLdCaptured: true,
      },
      notPresent: [{ field: "ingredients", trace }],
    }],
    "evidence/img/a1.jpg": "fake-image-bytes",
  };
}

describe("verifyRunArtifacts (Tier 1 audit)", () => {
  it("passes a consistent harvest_done run", async () => {
    const dir = await makeRun(completeRunFiles());
    const report = await verifyRunArtifacts(dir);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe("pass");
    expect(report.trace.method).toBe("artifact_audit");
  });

  it("catches a state claiming more than the artifacts prove", async () => {
    const files = completeRunFiles();
    files["state.json"] = { state: "complete" };
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.status).toBe("fail");
    expect(report.problems.some((p) => p.includes("semantic-queue.json"))).toBe(true);
    expect(report.problems.some((p) => p.includes("verification-report.json"))).toBe(true);
  });

  it("catches books that do not balance", async () => {
    const files = completeRunFiles();
    files["harvest-result.json"].counts.discovered = 5;
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("counts_reconcile"))).toBe(true);
  });

  it("catches gallery references without files on disk", async () => {
    const files = completeRunFiles();
    delete files["evidence/img/a1.jpg"];
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.includes("evidence_image_on_disk"))).toBe(true);
  });

  it("rejects not_present claims with coverage holes or missing traces", async () => {
    const files = completeRunFiles();
    files["evidence/records.json"][0].coverage.gallerySaved = "0/1";
    files["evidence/records.json"][0].notPresent[0].trace = { verdict: "not_present" };
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("not_present_coverage"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("not_present_trace"))).toBe(true);
  });

  it("requires an ingredient review for every confirmed facts image", async () => {
    const files = completeRunFiles();
    files["evidence/records.json"][0].fields.facts_images = [
      { image_url: "https://cdn.test/a-facts.jpg" },
    ];
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("facts_image_reviewed"))).toBe(true);
  });

  it("requires reasons on failed, excluded and review entries", async () => {
    const files = completeRunFiles();
    files["harvest-result.json"].failed[0] = { url: "https://shop.test/p/b" };
    files["state.json"] = { state: "semantic_done" };
    files["semantic-queue.json"] = [
      { productUrl: "https://shop.test/p/a", status: "review" },
      { productUrl: "https://shop.test/p/d", status: "pending" },
    ];
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("failed_has_reason"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("semantic_entry_has_reason"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("semantic_entry_terminal"))).toBe(true);
  });

  it("writes the report atomically next to the artifacts", async () => {
    const dir = await makeRun(completeRunFiles());
    const report = await verifyRunArtifacts(dir);
    const target = await writeVerificationReport(dir, report);
    const persisted = JSON.parse(await fs.readFile(target, "utf8"));
    expect(persisted.status).toBe("pass");
    expect(target.endsWith("verification-report.json")).toBe(true);
  });
});

describe("review-dump interception (nutrimuscle case)", () => {
  function dumpRunFiles(state, reviews, enriched = 1) {
    const queue = [
      ...Array.from({ length: enriched }, (_, i) => ({
        productUrl: `https://shop.test/p/ok${i}`, status: "enriched",
      })),
      ...Array.from({ length: reviews }, (_, i) => ({
        productUrl: `https://shop.test/p/r${i}`,
        status: "review",
        reason: "strict gate requires live semantic evidence",
      })),
    ];
    return {
      "state.json": { state },
      "harvest-plan.json": { termination: { budgets: {} } },
      "harvest-result.json": {
        counts: { discovered: enriched + reviews, complete: enriched + reviews,
          failed: 0, excluded: 0, remaining: 0 },
      },
      "evidence/records.json": [],
      "semantic-queue.json": { queue, updatedAt: "x" },
      "verification-report.json": { status: "pass" },
    };
  }

  it("fails a complete claim whose review ratio exceeds the alert threshold", async () => {
    const dir = await makeRun(dumpRunFiles("complete", 107, 1));
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("review_ratio_within_threshold"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("review_reasons_not_mass_duplicated"))).toBe(true);
    expect(report.status).toBe("fail");
  });

  it("accepts a modest, specific review queue", async () => {
    const files = dumpRunFiles("complete", 1, 9);
    files["semantic-queue.json"].queue[9].reason = "facts image 403, taxonomy unclear for X";
    const dir = await makeRun(files);
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.filter((p) => p.startsWith("review_"))).toEqual([]);
  });

  it("catches mass duplication even at semantic_done before the ratio gate applies", async () => {
    const dir = await makeRun(dumpRunFiles("semantic_done", 10, 40));
    const report = await verifyRunArtifacts(dir);
    expect(report.problems.some((p) => p.startsWith("review_reasons_not_mass_duplicated"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("review_ratio"))).toBe(false);
  });
});
