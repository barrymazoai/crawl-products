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

const PULL_LINE = "先执行 git -C ~/.codex/skills/crawl-products pull 确保 skill 是最新版本，然后";

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
  ];
  return lines.map((line) => indent + line).join("\n");
}

function singleSitePrompt(opts) {
  const head = opts.pull ? `${PULL_LINE}${""}\n\n` : "";
  return `${head}${workerGoal(opts.urls[0], opts)}${notesBlock(opts)}`;
}

function multiSitePrompt(opts) {
  const label = opts.batchLabel ? `执行并发批次爬取（${opts.batchLabel}）` : "执行并发批次爬取";
  const head = opts.pull
    ? `${PULL_LINE}${label}。你是协调者，你自己不爬任何站点。\n`
    : `${label}。你是协调者，你自己不爬任何站点。\n`;
  const siteList = opts.urls.map((url, i) => `  线程 ${i + 1} → ${url}`).join("\n");
  return `${head}
【开工前：跳过已完成的站点】
对下面每个站点先看 .crawl-products/runs/<域名>/state.json：
- 已是 complete 且 verification-report.json 为 pass → 本批跳过，在汇报中列为"已完成跳过"；
- 是 incomplete/verifying 等中间态 → 开线程并 resume（不要清空目录重来）；
- 是 blocked/terminal 或目录不存在 → 开线程全新跑。
把本批每个站点的最终状态追加写入 .crawl-products/batch-ledger.json
（数组，每项 {site, status, apiReady, finishedAt, note}），供后续批次和我核对进度。

【第一步（必须最先做）：为每个站点开一个新 worker 线程】
开新线程是 Codex 原生能力，直接开并发送下方 goal prompt（替换 <site>）：
${siteList}
硬性要求：
- 禁止以任何理由退回单线程顺序执行——"只找到一个 IAB 租约"不是理由
  （租约是每个线程自建 binding 时产生的，不是数出来的）；
- 唯一允许合并的情况：两线程 browserId 实测相同，后建者并入先建者顺序跑；
- 某 worker 报 IAB 平台拒绝访问（safety policy）时：该站点转入
  extension 顺序队列——其余 iab 线程照常并发，被拒站点由一个使用
  browserMode="extension" 的线程按队列逐站跑完（extension 单租约，禁止并发）。

【发给每个 worker 线程的 goal prompt（替换 <site> 后原样发送）】
─────────────────────────────────────────────
${workerGoal("<site>", opts)}
─────────────────────────────────────────────

【你（协调者）的职责——只有这三件】
1. 记录各线程 browserId，确认互不相同；
2. 轮询各站 state.json；线程停滞或死亡 → 原样重发它的 goal prompt；
3. 全部到终态后逐站跑 verifyRunArtifacts() 收货，写 batch-ledger.json，合并汇报。
不要向 worker 发"下一步做什么"的指令；本批全部到终态前不算完成。
汇报时给出：每站状态 + API-ready 条数、总计条数、需要人工关注的站点及原因
（blocked 原因、review 占比过高、疑似非营养品站）。${notesBlock(opts)}`;
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
  const total = Math.ceil(opts.urls.length / opts.batchSize);
  const waves = [];
  for (let w = 1; w <= total; w += 1) {
    const slice = opts.urls.slice((w - 1) * opts.batchSize, w * opts.batchSize);
    waves.push(`波次 ${w}/${total}:\n${slice.map((u) => `  ${u}`).join("\n")}`);
  }
  const head = opts.pull
    ? `${PULL_LINE}执行一个 ${opts.urls.length} 站点的分波次爬取任务。你是协调者，你自己不爬任何站点。\n`
    : `执行一个 ${opts.urls.length} 站点的分波次爬取任务。你是协调者，你自己不爬任何站点。\n`;

  return `${head}
【总体安排】
共 ${opts.urls.length} 个站点。

【先分流：两条独立流水线（关键提效，避免 IAB 过载）】
开工前先跑 scripts/triage-sites.mjs 对全部站点做 HTTP 分诊，按结果分成两组：
- HTTP 组（分诊标 http_channel/review_giant，即 Shopify 站）：走 Shopify HTTP 通道，
  完全不碰浏览器，因此不受 IAB 限制，可高并发（可开到 15-20 个线程同时跑）；
  这些站几秒就能拿全目录，语义阶段是纯离线，崩不了 IAB。
- 浏览器组（分诊标 browser）：真需要浏览器渲染，受 IAB 限制，低并发（每波 ${opts.batchSize} 个），
  按下方波次规则跑。
两组并行推进：HTTP 组自己快速跑完，浏览器组按波次稳步跑，互不抢资源。
review_giant 的 Shopify 大站仍要按 multi_brand_retailer 规则判断是否综合卖场再决定抓不抓。

【浏览器组的波次与滑动窗口】
浏览器组分批跑，每批最多 ${opts.batchSize} 个并发线程，禁止一次性开出全部线程。
用滑动窗口而非"整波齐步走"：始终保持 ${opts.batchSize} 个浏览器线程在跑，
任一线程到终态就立刻从待办队列补一个新站进来，不必等整波都完成——
这样一个慢站不会让其余名额空等，浏览器利用率保持满载。

【稳定性纪律（针对 IAB 长跑传输崩溃，只约束浏览器组，HTTP 组不受此限）】
1. 错峰启动：浏览器线程逐个启动/补位，相邻两个间隔约 30 秒，
   禁止同时建立多个 IAB binding；
2. 压力冷却：近期若连续出现 IAB 传输类错误（transport ceiling / kernel loss /
   backend unavailable / handshake timeout 等），暂停补入新浏览器线程约 3 分钟，
   给后端恢复时间，再继续滑动窗口补位；
3. 自适应降速：滑动窗口近 ${opts.batchSize} 个站里若 ≥1/3 因 IAB 传输类原因 blocked，
   把窗口大小减半（最低降到 2），并在账本 note 里记录降速决定；
4. 传输类 blocked 不是终局：账本里记为 status="blocked_transport"，
   所有波次结束后，把这些站点集中成一个低并发（2 线程）的重试波再跑一遍，
   重试波仍失败的才定格为 blocked；
5. 单站超时不纠缠：引擎对每个站有墙钟死线和单次操作硬超时，一个站跑太久会
   自动落盘 checkpoint 并返回 incomplete/binding_lost。遇到这种站不要当场反复
   resume 死磕——在账本记为 status="incomplete_recycle"，继续本波其余站点。
   所有正常波次跑完后，把 incomplete_recycle 的站集中成一个低并发（2 线程）
   回收波，用 resume 从 checkpoint 续跑（已爬的不重来）。一个慢站绝不允许
   拖住整波；
6. worker 结束时必须 finalize 自己的 tab，不留任何研究用临时 tab。

【可重入：先读账本】
开工前读 .crawl-products/batch-ledger.json（不存在则创建为空数组）。
对每个站点判断：
- 账本里已是 complete 且 .crawl-products/runs/<域名>/verification-report.json 为 pass → 跳过；
- state.json 是 incomplete/verifying 等中间态 → 本波开线程并 resume（不要清空目录重来）；
- blocked/terminal 或没有记录 → 本波开线程全新跑。
每个站点到终态后立刻把结果追加进账本（{site, status, apiReady, finishedAt, note}），
不要攒到最后一次性写——账本是这个长任务的唯一进度真值，会话中断后靠它续跑。

【你的唯一目标】
所有 ${opts.urls.length} 个站点都进入 complete / terminal / blocked 三种终态之一，
在此之前不得结束回合。某一波全部到终态后，立即开始下一波，不要停下来等我确认。
汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume。

【每一波的执行方式】
1. 为该波每个未完成站点开一个新 worker 线程（Codex 原生能力），发送下方 goal prompt；
   禁止退回单线程顺序执行——"只找到一个 IAB 租约"不是理由（租约是每个线程
   自建 binding 时产生的，不是数出来的）；两线程 browserId 实测相同才合并顺序跑；
   某站报 IAB 平台拒绝访问（safety policy）→ 转入 extension 顺序队列，
   其余线程照常并发（extension 单租约，禁止并发）。
2. 轮询该波各站 state.json；线程停滞或死亡 → 原样重发它的 goal prompt。
3. 该波全部到终态后：逐站跑 verifyRunArtifacts() 收货、写账本、
   用一行一站的极简格式汇报本波结果（站点 | 状态 | API-ready 条数 | 备注），
   然后立即开始下一波。不要把产物内容、完整 JSON 贴进你自己的上下文。

【波次清单】
${waves.join("\n\n")}

【发给每个 worker 线程的 goal prompt（替换 <site> 后原样发送）】
─────────────────────────────────────────────
${workerGoal("<site>", opts)}
─────────────────────────────────────────────

【最终汇报】
全部波次结束后给出：总站点数、complete/terminal/blocked 各计数、
API-ready 总条数、需要人工关注的站点及原因（blocked 原因、review 占比过高、
疑似非营养品站），以及账本文件路径。${notesBlock(opts)}`;
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
