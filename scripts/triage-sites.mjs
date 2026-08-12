#!/usr/bin/env node
/**
 * Pre-crawl triage: probe every site over plain HTTP before any browser is
 * opened, so the wave plan knows which sites can skip the browser entirely
 * (platform data endpoints), which are genuinely browser-only, which are
 * giants that need a human decision, and which are dead.
 *
 * No browser, no IAB — just HTTP. Runs the whole list in a few minutes.
 *
 * 用法：
 *   node scripts/triage-sites.mjs <url...>
 *   node scripts/triage-sites.mjs --csv sites.csv [--concurrency 12] [--out report.csv]
 *
 * 输出：一张体检表（stdout 表格 + 可选 CSV），每站给出 platform / 存活 /
 * 目录规模 / 建议（http_channel | browser | review_giant | dns_dead）。
 *
 * 重要：本脚本只信正向信号。成功拿到 /products.json 才标 http_channel（不会
 * 误报）；HTTP 探测失败可能只是本机网络/地域/反爬限制，绝不据此判站点死亡——
 * 一律回退 browser 交给真实浏览器确认。只有 DNS 无法解析才标 dns_dead。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { vendorDiversity, isMultiBrandRetailer } from "../lib/shopify-http.mjs";

const GIANT_THRESHOLD = 600;   // 超过此规模建议人工确认（可能是综合卖场）
const REQUEST_TIMEOUT_MS = 12_000;

function fail(msg) {
  console.error(`triage-sites: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { urls: [], concurrency: 12, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--csv") {
      opts.urls.push(...readCsv(argv[++i]));
    } else if (arg === "--concurrency") {
      opts.concurrency = Math.max(1, Number(argv[++i]) || 12);
    } else if (arg === "--out") {
      opts.out = argv[++i];
    } else if (arg.startsWith("--")) {
      fail(`未知选项 ${arg}`);
    } else {
      opts.urls.push(arg);
    }
  }
  if (opts.urls.length === 0) fail("需要站点（位置参数或 --csv）");
  opts.urls = [...new Set(opts.urls.map(normalizeDomain).filter(Boolean))];
  return opts;
}

function readCsv(file) {
  if (!file) fail("--csv 需要文件路径");
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { fail(`读不到 CSV: ${e.message}`); }
  const rows = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  const header = rows[0].map((c) => c.toLowerCase());
  const col = header.findIndex((c) => ["domain", "url", "site", "website"].includes(c));
  const hasHeader = col >= 0 || header.some((c) => ["name", "brand"].includes(c));
  return rows.slice(hasHeader ? 1 : 0).map((r) => r[col >= 0 ? col : 0]).filter(Boolean);
}

function normalizeDomain(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; crawl-products-triage)" },
      ...opts,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeShopify(origin) {
  try {
    const res = await fetchWithTimeout(`${origin}/products.json?limit=250`);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!/json/i.test(ct)) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.products)) return null;
    return {
      count: body.products.length,
      vendors: vendorDiversity(body.products),
      retailer: isMultiBrandRetailer(body.products),
    };
  } catch {
    return null;
  }
}

async function triageOne(domain) {
  const row = {
    domain,
    finalUrl: "",
    status: 0,
    platform: "-",
    productCount: "",
    recommendation: "dead",
    note: "",
  };
  let origin = `https://${domain}`;
  let homeReached = false;
  try {
    const res = await fetchWithTimeout(`${origin}/`);
    row.status = res.status;
    row.finalUrl = res.url;
    origin = new URL(res.url).origin;   // 跟随重定向后的真实 origin
    homeReached = true;
    if (!res.ok) {
      // 4xx/5xx/202：本机拿不到，但站点大概率活着（反爬/地域）。仍探 Shopify，
      // 探不到就回退浏览器，绝不标死。
      row.note = `home ${res.status}（本机受限，回退浏览器）`;
    }
  } catch (e) {
    // DNS 解析失败才是真死；超时/连接重置只是本机网络限制。
    const code = e?.cause?.code || e?.code || "";
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
      row.note = `DNS 无法解析（${code}）`;
      row.recommendation = "dns_dead";
      return row;
    }
    row.note = `本机探测失败（${e.name === "AbortError" ? "timeout" : code || "fetch"}），回退浏览器`;
    row.recommendation = "browser";
    // 仍尝试 Shopify 端点：有时首页超时但 CDN 上的 products.json 能通。
  }

  const shop = await probeShopify(origin);
  if (shop != null) {
    row.platform = "shopify";
    row.productCount = shop.count >= 250 ? "250+" : String(shop.count);
    row.vendors = shop.vendors.distinct;
    // Multi-brand retailer: many unrelated vendors, none dominating. These are
    // out of scope (third-party brands aren't the site's own products), so
    // flag rather than crawl — this is the check the HTTP channel used to skip.
    if (shop.retailer) {
      row.recommendation = "multi_brand_retailer";
      row.note = `疑似综合卖场：${shop.vendors.distinct} 个 vendor，最大占比 ${(shop.vendors.topShare * 100).toFixed(0)}%`;
    } else if (shop.count >= 250) {
      row.recommendation = "review_giant";
      row.note = `规模大(${shop.vendors.distinct} vendor)，大站批处理`;
    } else {
      row.recommendation = "http_channel";
    }
    return row;
  }

  // 首页通了但不是 Shopify → 自建站，需浏览器。首页没通已在上面置为 browser。
  if (homeReached && row.status >= 200 && row.status < 400) {
    row.platform = "custom";
    row.recommendation = "browser";
  }
  return row;
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function pull() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      process.stderr.write(".");
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pull));
  process.stderr.write("\n");
  return results;
}

function pad(s, n) { return String(s).padEnd(n); }

function render(rows) {
  const lines = [
    `${pad("站点", 32)}${pad("状态", 6)}${pad("平台", 9)}${pad("规模", 7)}${pad("建议", 15)}备注`,
  ];
  for (const r of rows) {
    lines.push(
      pad(r.domain, 32) + pad(r.status || "-", 6) + pad(r.platform, 9)
      + pad(r.productCount || "-", 7) + pad(r.recommendation, 15) + r.note,
    );
  }
  const by = (k) => rows.filter((r) => r.recommendation === k).length;
  lines.push("");
  lines.push(`总计 ${rows.length}：`
    + `http_channel ${by("http_channel")}（可免浏览器）｜`
    + `review_giant ${by("review_giant")}（Shopify 大站→大站批）｜`
    + `multi_brand_retailer ${by("multi_brand_retailer")}（疑似卖场→排除）｜`
    + `browser ${by("browser")}（需浏览器/本机受限）｜`
    + `dns_dead ${by("dns_dead")}（域名无法解析）`);
  lines.push("注：multi_brand_retailer 按 vendor 多样性判定（≥6 个 vendor 且最大占比<60%），"
    + "第三方品牌非本站自有商品，应排除；review_giant 是自有大目录，走大站批。");
  return lines.join("\n");
}

function toCsv(rows) {
  const header = ["domain", "final_url", "status", "platform", "product_count", "vendors", "recommendation", "note"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [header.join(","), ...rows.map((r) =>
    [r.domain, r.finalUrl, r.status, r.platform, r.productCount, r.vendors ?? "", r.recommendation, r.note]
      .map(esc).join(","))].join("\n") + "\n";
}

const opts = parseArgs(process.argv.slice(2));
process.stderr.write(`探测 ${opts.urls.length} 个站点（并发 ${opts.concurrency}）`);
const rows = await runPool(opts.urls, triageOne, opts.concurrency);
console.log(render(rows));
if (opts.out) {
  writeFileSync(opts.out, toCsv(rows));
  console.log(`\nCSV 已写入 ${opts.out}`);
}
