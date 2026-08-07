/**
 * Tier 1 mechanical audit (references/harvest-architecture.md §6).
 *
 * Pure bookkeeping over a harvest output directory: it never opens a browser
 * and never judges content. It answers one question — do the artifacts on
 * disk actually support what the state file and the records claim? A worker
 * has no authority to self-declare "complete"; complete means this audit
 * passes. The coordinator runs it before accepting any worker result.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  HARVEST_FILE_LAYOUT,
  HARVEST_STATES,
  evidenceCoverageGaps,
  normalizeEvidencePackage,
  validateVerificationTrace,
} from "./harvest-plan.mjs";

/**
 * Which artifacts each claimed state requires on disk. A state claiming more
 * than its artifacts can prove is reported as a lie, not an error to retry.
 */
const REQUIRED_FILES_BY_STATE = Object.freeze({
  plan_ready: ["plan"],
  harvest_done: ["plan", "result", "evidenceRecords"],
  incomplete: ["plan", "checkpoint"],
  semantic_done: ["plan", "result", "evidenceRecords", "semanticQueue"],
  verifying: ["plan", "result", "evidenceRecords", "semanticQueue"],
  verified: ["plan", "result", "evidenceRecords", "semanticQueue", "verificationReport"],
  complete: ["plan", "result", "evidenceRecords", "semanticQueue", "verificationReport"],
});

async function readJson(filePath) {
  try {
    return { value: JSON.parse(await readFile(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function counterTotal(result) {
  const counts = result?.counts || {};
  return ["complete", "failed", "excluded", "remaining"]
    .reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
}

/**
 * Audit a harvest output directory. Returns a report object; callers decide
 * whether to persist it via writeVerificationReport(). `checks` lists every
 * probe with pass/fail so the report doubles as the audit's own trace.
 */
export async function verifyRunArtifacts(outDir, options = {}) {
  if (typeof outDir !== "string" || outDir.trim() === "") {
    throw new TypeError("outDir is required");
  }
  const layout = { ...HARVEST_FILE_LAYOUT, ...(options.layout || {}) };
  const file = (key) => path.join(outDir, layout[key]);
  const checks = [];
  const problems = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass, ...(detail ? { detail } : {}) });
    if (!pass) problems.push(detail ? `${name}:${detail}` : name);
  };

  // -- state file ----------------------------------------------------------
  const stateFile = await readJson(file("state"));
  const claimedState = stateFile.value?.state;
  check("state_file_readable", stateFile.error === null, stateFile.error || undefined);
  check(
    "state_value_known",
    stateFile.error !== null || HARVEST_STATES.includes(claimedState),
    HARVEST_STATES.includes(claimedState) ? undefined : String(claimedState),
  );

  // -- claimed state vs artifacts on disk ----------------------------------
  const requiredKeys = REQUIRED_FILES_BY_STATE[claimedState] || [];
  for (const key of requiredKeys) {
    check(
      `artifact_present_for_state:${layout[key]}`,
      await fileExists(file(key)),
      `state ${claimedState} requires ${layout[key]}`,
    );
  }

  // -- harvest result bookkeeping ------------------------------------------
  const result = await readJson(file("result"));
  if (result.value) {
    const discovered = Number(result.value?.counts?.discovered);
    check(
      "counts_reconcile",
      Number.isFinite(discovered) && discovered === counterTotal(result.value),
      `discovered=${discovered} vs complete+failed+excluded+remaining=${counterTotal(result.value)}`,
    );
    for (const entry of result.value?.failed || []) {
      check(
        `failed_has_reason:${entry?.url || "unknown"}`,
        Boolean(entry?.reason),
        entry?.reason ? undefined : "failed entry without reason",
      );
    }
    for (const entry of result.value?.excluded || []) {
      check(
        `excluded_has_reason:${entry?.url || "unknown"}`,
        Boolean(entry?.reason),
        entry?.reason ? undefined : "excluded entry without reason",
      );
    }
    // Oracle verdicts are engine-only vocabulary; a "capped" verdict is valid
    // solely when the engine itself recorded the accepted product limit.
    const knownOracleStatuses = new Set(["satisfied", "mismatch", "unchecked", "capped"]);
    for (const oracle of result.value?.oracle || []) {
      check(
        `oracle_status_known:${oracle?.type || "unknown"}`,
        knownOracleStatuses.has(oracle?.status),
        knownOracleStatuses.has(oracle?.status) ? undefined : String(oracle?.status),
      );
      if (oracle?.status === "capped") {
        check(
          `oracle_capped_backed_by_accepted_limit:${oracle?.type || "unknown"}`,
          result.value?.productLimit?.accepted === true,
          result.value?.productLimit?.accepted === true
            ? undefined
            : "capped oracle without engine-recorded productLimit.accepted",
        );
      }
    }
  }

  // -- evidence packages ----------------------------------------------------
  const records = await readJson(file("evidenceRecords"));
  const packages = Array.isArray(records.value) ? records.value : [];
  let saveChecks = 0;
  for (const raw of packages) {
    const pkg = normalizeEvidencePackage(raw);
    for (const image of pkg.gallery) {
      if (!image.localPath) continue;
      saveChecks += 1;
      // Cap per-image stat noise in the report: record only failures beyond
      // the first thousand successful probes.
      const exists = await fileExists(path.join(outDir, image.localPath));
      if (!exists || saveChecks <= 1000) {
        check(
          `evidence_image_on_disk:${image.localPath}`,
          exists,
          exists ? undefined : `${pkg.productUrl} references missing file`,
        );
      }
    }

    // not_present claims must carry complete coverage and a valid trace.
    const claims = raw?.notPresent || raw?.not_present || [];
    for (const claim of Array.isArray(claims) ? claims : []) {
      const gaps = evidenceCoverageGaps(pkg);
      check(
        `not_present_coverage:${pkg.productUrl}:${claim?.field || "unknown"}`,
        gaps.length === 0,
        gaps.length > 0 ? gaps.join(",") : undefined,
      );
      const traceErrors = validateVerificationTrace(claim?.trace);
      check(
        `not_present_trace:${pkg.productUrl}:${claim?.field || "unknown"}`,
        traceErrors.length === 0,
        traceErrors.length > 0 ? traceErrors.join(",") : undefined,
      );
    }

    // Facts candidates that were confirmed must have an ingredient review.
    const factsImages = raw?.fields?.facts_images || [];
    const reviews = raw?.fields?.facts_ingredient_reviews
      || raw?.factsIngredientReviews
      || [];
    const reviewedUrls = new Set(
      (Array.isArray(reviews) ? reviews : [])
        .map((review) => review?.image_url || review?.imageUrl)
        .filter(Boolean),
    );
    for (const facts of Array.isArray(factsImages) ? factsImages : []) {
      const url = facts?.image_url || facts?.imageUrl;
      if (!url) continue;
      check(
        `facts_image_reviewed:${url}`,
        reviewedUrls.has(url),
        reviewedUrls.has(url) ? undefined : `${pkg.productUrl} facts image lacks ingredient review`,
      );
    }
  }

  // -- semantic queue terminal states ---------------------------------------
  const semanticQueue = await readJson(file("semanticQueue"));
  const queueEntries = Array.isArray(semanticQueue.value)
    ? semanticQueue.value
    : Array.isArray(semanticQueue.value?.queue)
      ? semanticQueue.value.queue
      : [];
  for (const entry of queueEntries) {
    const status = entry?.status;
    const terminal = ["enriched", "review", "needs_browser", "excluded"].includes(status);
    check(
      `semantic_entry_terminal:${entry?.productUrl || "unknown"}`,
      terminal || claimedState === "harvest_done" || claimedState === "incomplete",
      terminal ? undefined : `status=${status || "missing"}`,
    );
    if (status === "review" || status === "needs_browser" || status === "excluded") {
      check(
        `semantic_entry_has_reason:${entry?.productUrl || "unknown"}`,
        Boolean(entry?.reason),
        entry?.reason ? undefined : `${status} entry without reason`,
      );
    }
  }

  // -- review-dump interception ---------------------------------------------
  // "review" is a legal terminal state, but mass-dumping evidence-complete
  // records into it with a copy-pasted reason is goal-gaming, not honesty.
  const planFile = await readJson(file("plan"));
  const alertRatio = Number(
    planFile.value?.termination?.budgets?.reviewAlertRatio,
  ) || 0.2;
  const reviewEntries = queueEntries.filter((entry) => entry?.status === "review");
  if (queueEntries.length > 0) {
    if (["verified", "complete"].includes(claimedState)) {
      const ratio = reviewEntries.length / queueEntries.length;
      check(
        "review_ratio_within_threshold",
        ratio <= alertRatio,
        ratio <= alertRatio
          ? undefined
          : `review ${reviewEntries.length}/${queueEntries.length} exceeds ${alertRatio}; escalate as blocked, not ${claimedState}`,
      );
    }
    if (reviewEntries.length >= 5) {
      const reasonCounts = new Map();
      for (const entry of reviewEntries) {
        const key = String(entry?.reason || "").trim();
        reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
      }
      const [topReason, topCount] = [...reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])[0];
      check(
        "review_reasons_not_mass_duplicated",
        topCount / reviewEntries.length < 0.8,
        topCount / reviewEntries.length < 0.8
          ? undefined
          : `${topCount}/${reviewEntries.length} reviews share one reason ("${topReason.slice(0, 60)}"); reasons must be per-record specific`,
      );
    }
  }

  const failedChecks = checks.filter((entry) => !entry.pass);
  return {
    outDir,
    claimedState: claimedState ?? null,
    status: failedChecks.length === 0 ? "pass" : "fail",
    checksRun: checks.length,
    checksFailed: failedChecks.length,
    problems,
    checks,
    trace: {
      verdict: failedChecks.length === 0 ? "pass" : "fail",
      method: "artifact_audit",
      surface: "artifacts",
      evidence: Object.values(layout).map((name) => path.join(outDir, name)),
      verifier: "tier1:verifyRunArtifacts",
    },
  };
}

export async function writeVerificationReport(outDir, report, options = {}) {
  const layout = { ...HARVEST_FILE_LAYOUT, ...(options.layout || {}) };
  const target = path.join(outDir, layout.verificationReport);
  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return target;
}
