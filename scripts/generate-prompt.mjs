#!/usr/bin/env node
/**
 * Generate a robust crawl prompt for Codex.
 *
 * 单站 → worker goal prompt；多站 → 协调者 prompt（含并发 spawn 指令和
 * 内嵌的 worker goal 模板）。规则背景见 SKILL.md 与
 * references/harvest-architecture.md；本脚本只负责把每次运行的意图
 * （站点、数量、浏览器、导出模式）拼进固定骨架。
 *
 * 用法：
 *   node scripts/generate-prompt.mjs <url...> [选项]
 *   node scripts/generate-prompt.mjs --csv sites.csv --batch 3 [选项]
 *
 * 选项：
 *   --csv <file>     从 CSV 读站点（首列或名为 url/domain/site/website 的列）
 *   --batch-size <N> 每批线程数（默认 10）
 *   --batch <N>      输出第 N 批（1 起）；不传则列出批次计划
 *   --waves          输出一份覆盖全部站点的协调者 prompt，由 Codex 自己
 *                    按 batch-size 分波次跑完（你只需发一次）
 *   --max <N>        数量上限；不传 = 全量
 *   --browser <m>    iab（默认，公开站）| extension（需登录态/代理）
 *   --export <m>     api（默认，正式 API-ready 导出）| partial（只要 inventory_partial）
 *   --no-pull        省略开头的 git pull 行（代码稳定后可用）
 *   --note <text>    附加说明，原样放在 prompt 末尾（可多次）
 */

import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`generate-prompt: ${message}`);
  console.error("用法: node scripts/generate-prompt.mjs <url...> | --csv <file> [--batch N] [--batch-size N] [--max N] [--browser iab|extension] [--export api|partial] [--no-pull] [--note <text>]");
  process.exit(1);
}

/**
 * Minimal CSV reader: takes the column named url/domain/site/website when a
 * header row is present, otherwise the first column. Blank lines, comments
 * and quoted fields are handled; anything unparseable as a URL is reported
 * rather than silently dropped, so a 100-site list can't lose entries.
 */
function readCsvSites(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`无法读取 CSV: ${error.message}`);
  }
  const rows = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
  if (rows.length === 0) fail("CSV 为空");

  const header = rows[0].map((cell) => cell.toLowerCase());
  const named = header.findIndex((cell) => ["url", "domain", "site", "website", "网址", "域名"].includes(cell));
  const looksLikeHeader = named >= 0
    || header.some((cell) => ["name", "brand", "note", "备注", "品牌"].includes(cell));
  const column = named >= 0 ? named : 0;
  return rows
    .slice(looksLikeHeader ? 1 : 0)
    .map((row) => row[column])
    .filter(Boolean);
}

function parseArgs(argv) {
  const opts = {
    urls: [], max: null, browser: "iab", export: "api", pull: true, notes: [],
    batchSize: 10, batch: null, fromCsv: false, waves: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--csv") {
      const file = argv[++i];
      if (!file) fail("--csv 需要文件路径");
      opts.fromCsv = true;
      for (const value of readCsvSites(file)) argv.push(value);
    } else if (arg === "--batch-size") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fail("--batch-size 需要正整数");
      opts.batchSize = n;
    } else if (arg === "--batch") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fail("--batch 需要正整数");
      opts.batch = n;
    } else if (arg === "--waves") {
      opts.waves = true;
    } else if (arg === "--max") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fail("--max 需要正整数");
      opts.max = n;
    } else if (arg === "--browser") {
      const mode = argv[++i];
      if (mode !== "iab" && mode !== "extension") fail("--browser 只能是 iab 或 extension");
      opts.browser = mode;
    } else if (arg === "--export") {
      const mode = argv[++i];
      if (mode !== "api" && mode !== "partial") fail("--export 只能是 api 或 partial");
      opts.export = mode;
    } else if (arg === "--no-pull") {
      opts.pull = false;
    } else if (arg === "--note") {
      const note = argv[++i];
      if (!note) fail("--note 需要内容");
      opts.notes.push(note);
    } else if (arg.startsWith("--")) {
      fail(`未知选项 ${arg}`);
    } else {
      try {
        const url = new URL(arg.includes("://") ? arg : `https://${arg}`);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
        opts.urls.push(url.href);
      } catch {
        fail(`无法解析 URL: ${arg}`);
      }
    }
  }
  if (opts.urls.length === 0) fail("至少需要一个站点 URL");
  opts.urls = [...new Set(opts.urls)];
  return opts;
}

function batchPlan(opts) {
  const total = Math.ceil(opts.urls.length / opts.batchSize);
  const lines = [
    `# ${opts.urls.length} 个站点，每批 ${opts.batchSize} 个 → 共 ${total} 批`,
    "",
  ];
  for (let b = 1; b <= total; b += 1) {
    const slice = opts.urls.slice((b - 1) * opts.batchSize, b * opts.batchSize);
    lines.push(`批次 ${b}/${total}（${slice.length} 站）:`);
    for (const url of slice) lines.push(`  ${new URL(url).hostname.replace(/^www\./, "")}`);
    lines.push("");
  }
  lines.push("取某一批的 prompt：加 --batch <N>");
  return lines.join("\n");
}

const PULL_LINE = "开工前先拉取最新的 crawl-products Skill，然后";

function domainOf(url) {
  if (url === "<site>") return "<site 域名>";
  return new URL(url).hostname.replace(/^www\./, "");
}

function quantityLines(opts) {
  if (opts.max == null) {
    return [
      "- 数量：全量。目录必须跑到耗尽信号 + oracle 对账通过；",
      "  命中任何页数/条数上限都只能是 incomplete，继续 resume 直到真正抓完。",
    ];
  }
  return [
    `- 数量：maxItems = ${opts.max}，runHarvest 传 acceptProductLimit: true`,
    "  ——命中上限时引擎会以 complete + oracle \"capped\" 诚实收尾，",
    "  这是封顶运行唯一合法的 complete 途径，禁止手改产物凑数。",
  ];
}

function exportLines(opts) {
  if (opts.export === "api") {
    return [
      "- 导出：要正式 API-ready 导出。前提是 state=verified 且",
      "  verification-report.json 为 pass；严格门拒绝的记录留在 error/review，",
      "  除非我明确授权，只生成请求文件，不调用接口。",
    ];
  }
  return [
    "- 导出：本次只要 inventory_partial 落盘，不做正式 API 导出、不调用任何接口。",
  ];
}

function browserLines(opts) {
  if (opts.browser === "iab") {
    return [
      "- browserMode = \"iab\"，自建 binding，browserId 写入 preflight。",
      "  IAB 平台层拒绝访问本站（safety policy）时，已获长期授权降级为",
      "  browserMode=\"extension\"（本地 Chrome）继续；降级写入 worker-notes",
      "  并在汇报中说明。extension 单租约：若被其他任务占用则排队等待。",
    ];
  }
  return [
    "- browserMode = \"extension\"（本地 Chrome，保留登录态/代理）。",
    "  同一 extension 实例只能顺序执行，不得多线程共享。",
  ];
}

function workerGoal(url, opts, { indent = "" } = {}) {
  const domain = domainOf(url);
  const lines = [
    `使用 crawl-products skill（完整读取 SKILL.md）。`,
    ``,
    `你的唯一目标：让 ${url} 达到三种终态之一，在此之前不得结束回合：`,
    `  complete —— 通过 verifyRunArtifacts() Tier 1 审计`,
    `  terminal —— 带截图证据的站点级终态`,
    `  blocked  —— 点名具体阻塞物（需登录/challenge/需人决策）`,
    `汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume`,
    `（tab 污染换 tab；binding 断了重建 binding，都按 SKILL.md 配方）。`,
    `单页 target 反复崩溃 = 该 URL 记 failed 终态后继续，不是整站 terminal。`,
    ``,
    `参数：`,
    ...browserLines(opts),
    `- 输出目录 .crawl-products/runs/${domain}/（已有旧目录先改名存档）。`,
    ...quantityLines(opts),
    ...exportLines(opts),
    ``,
    `纪律：禁止手改引擎产物、禁止本地 patch 引擎源码（缺能力记 blocked 并汇报）、`,
    `state.json 只能由引擎和 harvest.updateRunState() 写入。`,
    ``,
    `先探 Shopify HTTP 通道：probeShopifyCatalog(entryUrl) 非 null 就用`,
    `createShopifyHarvestHooks 注入 hooks 跑 runHarvest（零浏览器，几秒拿全目录），`,
    `跳过浏览器化 Preflight B/C；探不到才走浏览器路径。`,
    `完整生命周期：Preflight A/B/C（或 Shopify HTTP 通道）→ runHarvest（结束后`,
    `globalThis.tab = result.activeTab ?? tab）→ 查漏抽查 →`,
    `语义队列排空（范围终判在此）→ Tier 1 审计 + Tier 2/3 抽查 → 按导出模式落盘。`,
    `证据落盘后，如有可用并发槽位，创建一个 model=gpt-5.6-luna、`,
    `reasoning_effort=high 的数据子代理，处理本地文本提取、图片读取和语义候选。`,
    `子代理不得操作 browser/tab 或写 state/引擎产物/正式导出；你负责检查证据引用、`,
    `用正式语义队列接口合并，并完成全部验证门。`,
  ];
  return lines.map((line) => indent + line).join("\n");
}

function singleSitePrompt(opts) {
  const head = opts.pull ? `${PULL_LINE}${""}\n\n` : "";
  return `${head}${workerGoal(opts.urls[0], opts)}${notesBlock(opts)}`;
}

function coordinatorPrompt(opts, label) {
  const head = opts.pull
    ? `${PULL_LINE}${label}。你是协调者，你自己不爬任何站点。\n`
    : `${label}。你是协调者，你自己不爬任何站点。\n`;
  const siteList = opts.urls.map((url, i) => `  ${i + 1}. ${url}`).join("\n");
  return `${head}
【站点清单】
${siteList}

【硬性并发架构】
1. 输入包含多个网站，必须为每个网站建立一个独立的顶层 Codex Thread/worker goal；
   一站一线程、一份 state、一套 outDir。禁止由协调者在当前会话内依次爬完整批次，
   Shopify HTTP 站也由自己的站点 worker 执行，只是该 worker 内部走 HTTP 通道。
2. 同时最多运行 ${opts.batchSize} 个站点 worker；槽位释放后立即补入下一站，直到清单排空。
   槽位不足只能分批接续，不能把多个网站合并到同一个 worker。
3. 每个站点 worker 自己完整读取 crawl-products/SKILL.md，自建所选 browser binding/tab，
   使用独立 .crawl-products/runs/<域名>/；不得接收父线程的 browser/tab 对象。
4. 每个站点 worker 在证据落盘后，如有可用槽位，可创建一个 model=gpt-5.6-luna、
   reasoning_effort=high 的数据子代理，处理本地文本、图片和语义候选。站点 worker
   负责合并、验证和完成判定；Luna 子代理不得操作浏览器或写引擎独占产物。

【可重入与账本】
开工前读 .crawl-products/batch-ledger.json（不存在则创建空数组），并逐站检查 state.json：
- complete 且 verification-report.json 为 pass → 跳过并记“已完成跳过”；
- incomplete/verifying 等中间态 → 在该站独立 worker 中 resume，不清空目录；
- blocked/terminal 或目录不存在 → 在该站独立 worker 中按 Skill 重新判定或全新跑。
每站到终态立即追加 {site, status, apiReady, finishedAt, note}，不要攒到最后。

【发给每个站点 worker 的 goal prompt（替换 <site> 后原样发送）】
─────────────────────────────────────────────
${workerGoal("<site>", opts)}
─────────────────────────────────────────────

【协调者职责】
1. 启动站点 worker 并在槽位释放后补位；
2. 轮询各站 state.json；某 worker 停滞或死亡，就用同一站点 goal 新建 worker 从磁盘续跑；
3. 全部到终态后逐站运行 verifyRunArtifacts() 收货、写账本并合并汇报。
不要向 worker 发“下一步做什么”的临时指令；下一步由 state.json 决定。
全部站点到终态前不得结束。最终汇报每站状态、API-ready 条数、总计条数及人工关注原因。${notesBlock(opts)}`;
}

function multiSitePrompt(opts) {
  const label = opts.batchLabel ? `执行并发批次爬取（${opts.batchLabel}）` : "执行并发批次爬取";
  return coordinatorPrompt(opts, label);
}

/**
 * One prompt for the whole list, run in waves by the coordinator itself.
 *
 * The ledger makes this re-entrant: if the coordinator session dies halfway
 * through wave 6, re-sending this exact prompt resumes from the ledger
 * instead of redoing waves 1-5. Per-wave reporting is deliberately terse so
 * a long run does not drown the coordinator's own context.
 */
function wavesPrompt(opts) {
  return coordinatorPrompt(
    opts,
    `执行一个 ${opts.urls.length} 站点的滑动窗口爬取任务（并发上限 ${opts.batchSize}）`,
  );
}

function notesBlock(opts) {
  if (opts.notes.length === 0) return "";
  return `\n\n【附加说明】\n${opts.notes.map((note) => `- ${note}`).join("\n")}`;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.waves) {
  console.log(wavesPrompt(opts));
} else if (opts.batch != null) {
  const total = Math.ceil(opts.urls.length / opts.batchSize);
  if (opts.batch > total) fail(`只有 ${total} 批，--batch ${opts.batch} 超出范围`);
  const all = opts.urls;
  opts.urls = all.slice((opts.batch - 1) * opts.batchSize, opts.batch * opts.batchSize);
  opts.batchLabel = `第 ${opts.batch}/${total} 批`;
  console.log(opts.urls.length === 1 ? singleSitePrompt(opts) : multiSitePrompt(opts));
} else if (opts.fromCsv || opts.urls.length > opts.batchSize) {
  console.log(batchPlan(opts));
} else {
  console.log(opts.urls.length === 1 ? singleSitePrompt(opts) : multiSitePrompt(opts));
}
