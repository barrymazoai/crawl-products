/**
 * Mechanical harvest engine (references/harvest-architecture.md §4).
 *
 * Fixed lifecycle, no discretion: INIT → ENUMERATE (to fixpoint) → EXTRACT
 * (drain queue) → FINALIZE. It refuses invalid plans, checkpoints as it goes,
 * and can only exit with one of three values: complete, incomplete (with a
 * resumable checkpoint) or terminal. Watchdogs turn stalls and exhausted
 * budgets into incomplete — never into a fake success and never into a hang.
 *
 * The model never sits inside this loop. It fills in the HarvestPlan before,
 * awaits this call, and gets evidence packages after.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HARVEST_FILE_LAYOUT,
  HARVEST_STATES,
  normalizeEvidencePackage,
  validateHarvestPlan,
} from "./harvest-plan.mjs";
import {
  collectProductUrls,
  extractProductsBatch,
  mergeProductRecords,
  upgradeProducts,
} from "./crawl.mjs";
import { isHeadingOnlyDetailValue } from "./engine.mjs";
import { classifyFactsImageCandidate } from "./product-semantics.mjs";
import {
  classifyNutritionProductUrl,
  filterHarvestStageRecords,
} from "./product-scope.mjs";

const PAGE_TEXT_SEARCH_TERMS = Object.freeze([
  "ingredients",
  "supplement facts",
  "nutrition facts",
]);

/**
 * Environment-level death signals. A URL that fails with one of these did
 * not fail because of its page — the browser lease itself is gone. Such URLs
 * must never receive a terminal `failed` state: the run aborts to
 * incomplete+checkpoint so a resume (with a rebuilt binding) retries them.
 * Page-level signals (timeouts, target closed on one page) are NOT listed
 * here on purpose; they stay per-URL failures after their retry ladder.
 */
const BINDING_LOST_PATTERN =
  /browser is not available|browser_unavailable|binding (?:lost|closed)|native pipe is closed|extension disconnected|operation_timeout/i;

function nowMs(opts) {
  return typeof opts.now === "function" ? opts.now() : Date.now();
}

/**
 * Idle (no-progress) timeout for a single hook call. A hung browser call (a
 * goto that never returns, a dead binding that never rejects) can freeze the
 * loop where the between-products watchdog never fires — but a plain total-
 * duration ceiling would also kill legitimately slow work (a chunk covers up
 * to five heavy pages; 40-60s/page is normal). So the deadline resets on
 * every progress signal (log/onProgress from inside the hook): slow-but-
 * alive work pings and lives, a genuine hang emits nothing and is aborted.
 * The timeout surfaces as a binding-lost-class error, which the extract/
 * upgrade paths turn into a resumable incomplete abort.
 */
function createIdleTimeout(ms, label) {
  if (!ms || ms <= 0) {
    return { promise: new Promise(() => {}), ping() {}, clear() {} };
  }
  let timer;
  let rejectFn;
  const promise = new Promise((_, reject) => { rejectFn = reject; });
  const arm = () => {
    timer = setTimeout(() => {
      rejectFn(Object.assign(new Error(`operation_timeout:${label}`), {
        code: "operation_timeout",
      }));
    }, ms);
    if (typeof timer?.unref === "function") timer.unref();
  };
  arm();
  return {
    promise,
    ping() { clearTimeout(timer); arm(); },
    clear() { clearTimeout(timer); },
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function imageFileName(url, mime) {
  const hash = createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
  const ext = /png/i.test(mime) ? "png"
    : /webp/i.test(mime) ? "webp"
      : /gif/i.test(mime) ? "gif"
        : "jpg";
  return `${hash}.${ext}`;
}

/**
 * Platform product-data probe (currently Shopify-shaped stores).
 *
 * Variant enumeration used to be interactive-only model work; on platform
 * stores every sellable state (variants, SKUs, per-variant prices/images) is
 * one public JSON request away, so the mechanical phase captures it. Catalog
 * scope is unchanged: this only enriches products already discovered through
 * the site's visible navigation — endpoint-only products stay out of scope.
 */
function platformProductDataUrl(productUrl) {
  try {
    const url = new URL(productUrl);
    const match = /^(.*\/products\/)([^/?#]+)/.exec(url.pathname);
    if (!match) return null;
    return `${url.origin}${match[1]}${match[2]}.json`;
  } catch {
    return null;
  }
}

async function defaultFetchProductData(productUrl) {
  const dataUrl = platformProductDataUrl(productUrl);
  if (!dataUrl) return null;
  try {
    const response = await fetch(dataUrl, {
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object" ? body.product ?? body : null;
  } catch {
    return null;
  }
}

function normalizePlatformVariants(product, productUrl) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const optionNames = (Array.isArray(product?.options) ? product.options : [])
    .map((option) => (typeof option === "string" ? option : option?.name))
    .filter(Boolean);
  return variants.map((variant) => {
    const options = {};
    ["option1", "option2", "option3"].forEach((key, index) => {
      const value = variant?.[key];
      if (value != null && String(value).trim() !== "") {
        options[optionNames[index] || `option${index + 1}`] = String(value).trim();
      }
    });
    const id = variant?.id != null ? String(variant.id) : "";
    return {
      ...(id ? { variantId: id } : {}),
      ...(variant?.sku ? { sku: String(variant.sku).trim() } : {}),
      ...(variant?.title ? { title: String(variant.title).trim() } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(variant?.price != null ? { price: String(variant.price) } : {}),
      ...(typeof variant?.available === "boolean" ? { available: variant.available } : {}),
      ...(id ? { url: `${productUrl.split("?")[0]}?variant=${id}` } : {}),
      ...(variant?.featured_image?.src ? { imageUrl: String(variant.featured_image.src) } : {}),
    };
  }).filter((variant) => variant.variantId || variant.sku || variant.title);
}

const IMAGE_FETCH_HEADERS = Object.freeze({
  accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
});

/**
 * Default image fetcher: plain HTTP fetch of public CDN assets, but dressed
 * as a browser. Many CDNs 403 bare fetches (this is why some sites came back
 * with 0 saved images) — a browser UA, an image accept header and a same-
 * origin referer clear most of them. One retry covers transient 5xx/timeouts.
 * A genuine refusal still surfaces as image_download_failed, which flags the
 * record for the needs_browser follow-up instead of failing the harvest.
 */
export async function defaultFetchImage(url, attempt = 0) {
  let referer;
  try { referer = new URL(url).origin + "/"; } catch { referer = undefined; }
  try {
    const response = await fetch(url, {
      headers: { ...IMAGE_FETCH_HEADERS, ...(referer ? { referer } : {}) },
      redirect: "follow",
    });
    if (!response.ok) {
      if (response.status >= 500 && attempt < 1) return defaultFetchImage(url, attempt + 1);
      throw new Error(`http_${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, mime: response.headers.get("content-type") || "" };
  } catch (error) {
    if (attempt < 1 && !/^http_4/.test(String(error?.message))) {
      return defaultFetchImage(url, attempt + 1);
    }
    throw error;
  }
}

function recordImages(record) {
  const images = record?.fields?.images;
  return (Array.isArray(images) ? images : [])
    .map((image) => (typeof image === "string"
      ? { url: image }
      : { url: image?.url || image?.src || "", alt: image?.alt || "" }))
    .filter((image) => image.url);
}

function buildFlags(record) {
  const flags = [];
  const ingredients = record?.fields?.ingredients;
  if (ingredients != null && isHeadingOnlyDetailValue("ingredients", ingredients)) {
    flags.push("heading_only_ingredients");
  }
  return flags;
}

function factsRank(image, index) {
  const classified = classifyFactsImageCandidate({ ...image, index });
  if (!classified.requiresVisualReview) return null;
  return classified.reason === "explicit_metadata_candidate" ? 1 : 2;
}

/**
 * Run the mechanical harvest for one site.
 *
 * opts:
 * - outDir (required): artifact directory; all progress is persisted here.
 * - resume: continue from this directory's checkpoint instead of starting over.
 * - now / log / onProgress: instrumentation.
 * - hooks: { enumerate, extract, upgrade, fetchImage, filterScope } —
 *   injectable for tests; defaults wire to the real crawl/scope functions.
 */
export async function runHarvest(browser, tab, planInput, opts = {}) {
  const { valid, errors, plan } = validateHarvestPlan(planInput);
  if (!valid) {
    const error = new Error(`harvest_plan_invalid:${errors.join(",")}`);
    error.code = "harvest_plan_invalid";
    error.errors = errors;
    throw error;
  }
  if (typeof opts.outDir !== "string" || opts.outDir.trim() === "") {
    throw new TypeError("opts.outDir is required: harvest progress must be persistable");
  }

  const outDir = opts.outDir;
  const layout = HARVEST_FILE_LAYOUT;
  const file = (key) => path.join(outDir, layout[key]);
  const log = opts.log || (() => {});
  const acceptLimit = opts.acceptProductLimit === true;
  // Tainted-tab replacements inside upgradeProducts must propagate to every
  // later browser call, so the default hooks read the tab through this ref.
  const tabRef = { tab };
  const hooks = {
    enumerate: opts.hooks?.enumerate
      || ((seeds, enumerateOpts) => collectProductUrls(tabRef.tab, seeds, enumerateOpts)),
    extract: opts.hooks?.extract
      || (async (urls, extractOpts) => {
        if (typeof browser?.tabs?.content === "function") {
          return extractProductsBatch(browser, urls, extractOpts);
        }
        // Binding without a batch-content API (e.g. the In-App Browser):
        // route every URL to the sequential rendered path, which only needs
        // tab primitives both surfaces provide. Capability difference, not an
        // error — never classify it as a site problem.
        return { records: [], needsUpgrade: [...urls], failed: [], batchUnavailable: true };
      }),
    upgrade: opts.hooks?.upgrade
      || ((urls, upgradeOpts) => upgradeProducts(tabRef.tab, urls, { ...upgradeOpts, browser })),
    fetchImage: opts.hooks?.fetchImage || defaultFetchImage,
    fetchProductData: opts.hooks?.fetchProductData || defaultFetchProductData,
    filterScope: opts.hooks?.filterScope || filterHarvestStageRecords,
  };

  const budgets = plan.termination.budgets;
  const startedAt = nowMs(opts);
  const wallDeadline = startedAt + budgets.wallClockMinutes * 60_000;
  const stallWindowMs = budgets.stallMinutes * 60_000;
  const operationIdleMs = opts.operationIdleMs
    ?? opts.operationTimeoutMs
    ?? budgets.operationIdleMinutes * 60_000;
  let lastProgressAt = startedAt;
  const progressed = () => { lastProgressAt = nowMs(opts); };
  const budgetBreach = () => {
    const now = nowMs(opts);
    if (now > wallDeadline) return "wall_clock_budget_exhausted";
    if (now - lastProgressAt > stallWindowMs) return "stall_watchdog_tripped";
    return null;
  };

  const setState = (state, extra = {}) => writeJsonAtomic(file("state"), {
    state,
    updatedAtMs: nowMs(opts),
    ...extra,
  });
  await writeJsonAtomic(file("plan"), plan);

  // Resumable bookkeeping. `processed` maps url → terminal state.
  const checkpoint = (opts.resume && await readJsonIfExists(file("checkpoint"))) || {};
  const discovered = new Set(checkpoint.discovered || []);
  const processed = new Map(Object.entries(checkpoint.processed || {}));
  let seedReports = checkpoint.seedReports || [];
  const attemptsByUrl = new Map(Object.entries(checkpoint.attempts || {}));
  const evidencePackages = (opts.resume
    && await readJsonIfExists(file("evidenceRecords"))) || [];
  const packagesByUrl = new Map(
    evidencePackages.map((pkg) => [pkg.productUrl, pkg]),
  );

  const persistCheckpoint = () => writeJsonAtomic(file("checkpoint"), {
    discovered: [...discovered],
    processed: Object.fromEntries(processed),
    attempts: Object.fromEntries(attemptsByUrl),
    seedReports,
  });

  const finalize = async (status, reasons = []) => {
    const counts = {
      discovered: discovered.size,
      complete: [...processed.values()].filter((s) => s === "complete").length,
      failed: [...processed.values()].filter((s) => s === "failed").length,
      excluded: [...processed.values()].filter((s) => s === "excluded").length,
      remaining: [...discovered].filter((url) => !processed.has(url)).length,
    };
    const packages = [...packagesByUrl.values()];
    const presence = {
      records: packages.length,
      withIngredientsText: packages
        .filter((pkg) => pkg.fields?.ingredients_text && !pkg.flags?.includes("heading_only_ingredients"))
        .length,
      withFactsImageCandidate: packages
        .filter((pkg) => (pkg.gallery || []).some((img) => img.factsCandidateRank != null))
        .length,
      withDescription: packages.filter((pkg) => pkg.fields?.description).length,
    };
    const failedEntries = [];
    const excludedEntries = [];
    for (const [url, state] of processed) {
      const attempts = attemptsByUrl.get(url);
      if (state === "failed") {
        failedEntries.push({
          url,
          reason: attempts?.at?.(-1)?.reason || "extraction_failed",
          attempts: attempts || [],
        });
      }
      if (state === "excluded") {
        excludedEntries.push({ url, reason: attempts?.at?.(-1)?.reason || "out_of_scope" });
      }
    }

    const result = {
      status,
      reasons,
      counts,
      seedReports,
      oracle: reconcileOracles(plan, discovered.size, acceptLimit),
      ...(acceptLimit
        ? { productLimit: { accepted: true, maxItems: budgets.maxItems } }
        : {}),
      startedAtMs: startedAt,
      finishedAtMs: nowMs(opts),
      failed: failedEntries,
      excluded: excludedEntries,
    };
    await writeJsonAtomic(file("evidenceRecords"), packages);
    await writeJsonAtomic(file("fieldPresenceStats"), presence);
    await writeJsonAtomic(file("result"), result);
    await persistCheckpoint();
    await setState(status === "complete" ? "harvest_done" : status, { reasons });
    log("harvest_finalized", { status, counts });
    // Live handle only — never serialized. Callers rebind globalThis.tab from
    // it after tainted-tab replacements inside the run.
    result.activeTab = tabRef.tab;
    return result;
  };

  await setState("plan_ready");

  // -- ENUMERATE to fixpoint -------------------------------------------------
  const seedUrls = plan.route.listingSeeds.map((seed) => seed.url);
  const listingCoverage = plan.route.listingSeeds.map((seed) => ({
    url: seed.url,
    paginationMode: seed.paginationMode,
    verifiedVisually: true,
  }));
  let zeroGrowthRounds = 0;
  let enumerationIncompleteReason = null;
  while (zeroGrowthRounds < plan.termination.fixpoint.extraRoundsAfterConverge) {
    const breach = budgetBreach();
    if (breach) return finalize("incomplete", [breach]);
    const before = discovered.size;
    const round = await hooks.enumerate(seedUrls, {
      maxItems: budgets.maxItems,
      maxPagesPerSeed: budgets.maxPagesPerSeed,
      listingCoverage,
      known: [...discovered],
      listingProfile: plan.route.listingProfile || undefined,
      log,
    });
    seedReports = round.coverage?.seedReports || [];
    for (const url of round.productUrls || []) discovered.add(url);
    const growth = discovered.size - before;
    if (growth > 0) progressed();
    log("enumerate_round", { discovered: discovered.size, growth });
    await persistCheckpoint();
    if (round.coverage?.status !== "complete") {
      const incompleteSeeds = seedReports.filter((report) => report.status !== "complete");
      const onlyMaxItems = incompleteSeeds.length > 0 && incompleteSeeds
        .every((report) => String(report.endReason || "").includes("max_items"));
      if (acceptLimit && onlyMaxItems) {
        // The caller explicitly capped this run: hitting maxItems is the
        // sanctioned finish line, not incompleteness to resume or fudge.
        log("product_limit_accepted", { maxItems: budgets.maxItems });
        break;
      }
      enumerationIncompleteReason = incompleteSeeds
        .map((report) => `seed_${report.endReason || "incomplete"}:${report.seedUrl}`)
        .join(",") || "enumeration_incomplete";
      break;
    }
    if (growth === 0) zeroGrowthRounds += 1;
    else zeroGrowthRounds = 0;
  }

  // -- EXTRACT: drain the queue ---------------------------------------------
  // URL-level scope exclusion happens before any browser work: an explicit
  // bundle/non-nutrition URL never earns navigation retries.
  for (const url of discovered) {
    if (processed.has(url)) continue;
    const decision = classifyNutritionProductUrl(url);
    if (!decision.included) {
      attemptsByUrl.set(url, [
        ...(attemptsByUrl.get(url) || []),
        { method: "url_scope_filter", reason: decision.reason },
      ]);
      processed.set(url, "excluded");
    }
  }
  const queue = [...discovered].filter((url) => !processed.has(url));
  let index = 0;
  while (index < queue.length) {
    const breach = budgetBreach();
    if (breach) {
      return finalize("incomplete", [
        breach,
        ...(enumerationIncompleteReason ? [enumerationIncompleteReason] : []),
      ]);
    }
    const chunk = queue.slice(index, index + 5);
    index += chunk.length;

    let batch;
    const extractIdle = createIdleTimeout(operationIdleMs, "extract");
    try {
      batch = await Promise.race([
        hooks.extract(chunk, {
          fields: opts.fields,
          profile: plan.route.detailProfile,
          imageProfile: plan.route.imageProfile || undefined,
          log: (...args) => { extractIdle.ping(); log(...args); },
          onProgress: () => extractIdle.ping(),
        }),
        extractIdle.promise,
      ]);
    } catch (error) {
      // A throwing extract is an execution-plane event, not evidence about
      // these URLs. Abort resumable; the chunk stays unprocessed.
      return finalize("incomplete", [
        `binding_lost:extract_exception:${String(error?.message || error).slice(0, 120)}`,
        ...(enumerationIncompleteReason ? [enumerationIncompleteReason] : []),
      ]);
    } finally {
      extractIdle.clear();
    }
    if (batch.batchUnavailable !== true) {
      for (const url of chunk) {
        attemptsByUrl.set(url, [
          ...(attemptsByUrl.get(url) || []),
          { method: "batch_content", reason: null },
        ]);
      }
    }

    let records = batch.records || [];
    let bindingLost = null;
    const needsUpgrade = (batch.needsUpgrade || []).filter((url) => chunk.includes(url));
    if (needsUpgrade.length > 0) {
      let upgraded;
      const upgradeIdle = createIdleTimeout(operationIdleMs, "upgrade");
      try {
        upgraded = await Promise.race([
          hooks.upgrade(needsUpgrade, {
            fields: opts.fields,
            profile: plan.route.detailProfile,
            imageProfile: plan.route.imageProfile || undefined,
            baselineRecords: records,
            log: (...args) => { upgradeIdle.ping(); log(...args); },
            onProgress: () => upgradeIdle.ping(),
          }),
          upgradeIdle.promise,
        ]);
      } catch (error) {
        bindingLost = `upgrade_exception:${String(error?.message || error).slice(0, 120)}`;
        upgraded = { records: [], failed: [], skipped: [] };
      } finally {
        upgradeIdle.clear();
      }
      if (upgraded && typeof upgraded === "object" && upgraded.tab) {
        tabRef.tab = upgraded.tab;
      }
      records = mergeProductRecords([...records, ...(upgraded.records || [])]);
      for (const entry of upgraded.failed || []) {
        const reasonText = String(entry.reason || "upgrade_failed");
        if (BINDING_LOST_PATTERN.test(reasonText)) {
          // The lease died, not the page: leave this URL unprocessed for
          // resume instead of recording a bogus terminal failure.
          bindingLost = bindingLost || reasonText.slice(0, 120);
          continue;
        }
        const attempts = attemptsByUrl.get(entry.url) || [];
        attempts.push({ method: "rendered_upgrade", reason: reasonText });
        attemptsByUrl.set(entry.url, attempts);
      }
    }

    const scope = hooks.filterScope(records);
    for (const record of scope.excluded || []) {
      const url = record?.sourceUrl || record?.fields?.url;
      if (!url || !chunk.includes(url)) continue;
      const attempts = attemptsByUrl.get(url) || [];
      attempts.push({
        method: "scope_filter",
        reason: record?._meta?.productScope?.reason || "out_of_scope",
      });
      attemptsByUrl.set(url, attempts);
      processed.set(url, "excluded");
    }

    for (const record of scope.included || []) {
      const url = record?.sourceUrl || record?.fields?.url;
      if (!url || !chunk.includes(url)) continue;
      packagesByUrl.set(url, await buildEvidencePackage(record, url, outDir, hooks, log));
      processed.set(url, "complete");
      progressed();
    }

    // The lease died mid-chunk: keep what completed, leave the rest
    // unprocessed, and exit resumable. Never terminal-mark on a dead binding.
    if (bindingLost) {
      await persistCheckpoint();
      return finalize("incomplete", [
        `binding_lost:${bindingLost}`,
        ...(enumerationIncompleteReason ? [enumerationIncompleteReason] : []),
      ]);
    }

    // Every chunk URL must reach a terminal state — the queue always drains.
    for (const url of chunk) {
      if (processed.has(url)) continue;
      const attempts = attemptsByUrl.get(url) || [];
      if (attempts.length === 0 || attempts.at(-1)?.reason == null) {
        attempts.push({ method: "rendered_upgrade", reason: "no_record_extracted" });
        attemptsByUrl.set(url, attempts);
      }
      processed.set(url, "failed");
    }

    await persistCheckpoint();
    await opts.onProgress?.({
      phase: "extract",
      processed: processed.size,
      discovered: discovered.size,
    });
  }

  // -- FINALIZE --------------------------------------------------------------
  const reasons = [];
  if (enumerationIncompleteReason) reasons.push(enumerationIncompleteReason);
  const oracle = reconcileOracles(plan, discovered.size, acceptLimit);
  if (oracle.some((entry) => entry.status === "mismatch")) {
    reasons.push("oracle_mismatch");
  }
  const remaining = [...discovered].filter((url) => !processed.has(url)).length;
  if (remaining > 0) reasons.push("detail_queue_not_drained");

  return finalize(reasons.length === 0 ? "complete" : "incomplete", reasons);
}

function reconcileOracles(plan, discoveredCount, acceptLimit = false) {
  const maxItems = plan.termination.budgets.maxItems;
  return plan.termination.oracles.map((oracle) => {
    if (!Number.isFinite(oracle.expected)) {
      return { ...oracle, status: "unchecked" };
    }
    if (acceptLimit && oracle.expected > maxItems) {
      // Honest capped verdict: the catalog is known to be larger, and the
      // caller chose the cap. "capped" is only writable by the engine and the
      // audit cross-checks it against productLimit.accepted.
      return {
        ...oracle,
        status: discoveredCount >= maxItems ? "capped" : "mismatch",
        observed: discoveredCount,
        cappedAt: maxItems,
      };
    }
    return {
      ...oracle,
      status: discoveredCount >= oracle.expected ? "satisfied" : "mismatch",
      observed: discoveredCount,
    };
  });
}

/**
 * The only sanctioned way to advance state.json outside the engine.
 *
 * state.json has a fixed schema ({state, updatedAtMs}) owned by the engine
 * and this helper; the Tier 1 audit fails any other shape. Worker commentary
 * (resume reasons, decisions, observations) goes to worker-notes.json — it
 * must never overwrite or restructure state.json.
 */
export async function updateRunState(outDir, state, notes = null, opts = {}) {
  if (typeof outDir !== "string" || outDir.trim() === "") {
    throw new TypeError("outDir is required");
  }
  if (!HARVEST_STATES.includes(state)) {
    throw new Error(`invalid_run_state:${state}`);
  }
  const atMs = typeof opts.now === "function" ? opts.now() : Date.now();
  await writeJsonAtomic(path.join(outDir, HARVEST_FILE_LAYOUT.state), {
    state,
    updatedAtMs: atMs,
  });
  if (notes != null) {
    const notesPath = path.join(outDir, HARVEST_FILE_LAYOUT.workerNotes);
    const existing = (await readJsonIfExists(notesPath)) || [];
    existing.push({ state, atMs, notes });
    await writeJsonAtomic(notesPath, existing);
  }
}

async function buildEvidencePackage(record, url, outDir, hooks, log) {
  const gallery = [];
  const images = recordImages(record);
  const flags = buildFlags(record);

  // Platform variant expansion + SKU backfill (no browser involved).
  let variants = [];
  try {
    const platformProduct = await hooks.fetchProductData(url);
    if (platformProduct) variants = normalizePlatformVariants(platformProduct, url);
  } catch (error) {
    log("platform_data_failed", { url, error: String(error) });
  }
  const defaultVariant = variants.find((v) => v.available !== false) ?? variants[0];
  const skuBackfill = !record.fields?.sku && defaultVariant?.sku
    ? { sku: defaultVariant.sku }
    : {};
  const priceBackfill = !record.fields?.price && defaultVariant?.price
    ? { price: defaultVariant.price }
    : {};
  if (variants.length > 0) {
    log("platform_variants_captured", { url, variants: variants.length });
  }
  let saved = 0;
  for (const [index, image] of images.entries()) {
    const entry = {
      url: image.url,
      alt: image.alt || "",
      index,
      localPath: "",
      mime: "",
    };
    const rank = factsRank(image, index);
    if (rank != null) entry.factsCandidateRank = rank;
    try {
      const fetched = await hooks.fetchImage(image.url);
      const fileName = imageFileName(image.url, fetched.mime);
      const relative = path.join(HARVEST_FILE_LAYOUT.evidenceImageDir, fileName);
      await mkdir(path.join(outDir, HARVEST_FILE_LAYOUT.evidenceImageDir), { recursive: true });
      await writeFile(path.join(outDir, relative), fetched.bytes);
      entry.localPath = relative;
      entry.mime = fetched.mime;
      saved += 1;
    } catch (error) {
      flags.push(`image_download_failed:${image.url}`);
      log("image_download_failed", { url: image.url, error: String(error) });
    }
    gallery.push(entry);
  }

  const pkg = normalizeEvidencePackage({
    productUrl: url,
    fields: {
      ...record.fields,
      ...(record.fields?.ingredients ? { ingredients_text: record.fields.ingredients } : {}),
      ...skuBackfill,
      ...priceBackfill,
    },
    gallery,
    coverage: {
      gallerySaved: `${saved}/${images.length}`,
      domSectionsExpanded: ["main_content"],
      pageTextSearched: [...PAGE_TEXT_SEARCH_TERMS],
      jsonLdCaptured: true,
    },
    flags,
  });
  // normalizeEvidencePackage owns the core schema; variants ride alongside so
  // every sellable state (id/SKU/options/price/variant URL) reaches
  // crawl-records and downstream enrich without a semantic round per variant.
  if (variants.length > 0) pkg.variants = variants;
  return pkg;
}
