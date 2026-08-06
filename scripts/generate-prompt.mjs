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
 *
 * 选项：
 *   --max <N>        数量上限；不传 = 全量
 *   --browser <m>    iab（默认，公开站）| extension（需登录态/代理）
 *   --export <m>     api（默认，正式 API-ready 导出）| partial（只要 inventory_partial）
 *   --no-pull        省略开头的 git pull 行（代码稳定后可用）
 *   --note <text>    附加说明，原样放在 prompt 末尾（可多次）
 */

function fail(message) {
  console.error(`generate-prompt: ${message}`);
  console.error("用法: node scripts/generate-prompt.mjs <url...> [--max N] [--browser iab|extension] [--export api|partial] [--no-pull] [--note <text>]");
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { urls: [], max: null, browser: "iab", export: "api", pull: true, notes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max") {
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
  return opts;
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
    return ["- browserMode = \"iab\"，自建 binding，browserId 写入 preflight。"];
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
    `完整生命周期：Preflight A/B/C → runHarvest（结束后`,
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
  const head = opts.pull ? `${PULL_LINE}执行并发批次爬取。你是协调者，你自己不爬任何站点。\n` : "执行并发批次爬取。你是协调者，你自己不爬任何站点。\n";
  const siteList = opts.urls.map((url, i) => `  线程 ${i + 1} → ${url}`).join("\n");
  return `${head}
【第一步（必须最先做）：为每个站点开一个新 worker 线程】
开新线程是 Codex 原生能力，直接开并发送下方 goal prompt（替换 <site>）：
${siteList}
硬性要求：
- 禁止以任何理由退回单线程顺序执行——"只找到一个 IAB 租约"不是理由
  （租约是每个线程自建 binding 时产生的，不是数出来的）；
- 唯一允许合并的情况：两线程 browserId 实测相同，后建者并入先建者顺序跑。

【发给每个 worker 线程的 goal prompt（替换 <site> 后原样发送）】
─────────────────────────────────────────────
${workerGoal("<site>", opts)}
─────────────────────────────────────────────

【你（协调者）的职责——只有这三件】
1. 记录各线程 browserId，确认互不相同；
2. 轮询各站 state.json；线程停滞或死亡 → 原样重发它的 goal prompt；
3. 全部到终态后逐站跑 verifyRunArtifacts() 收货，合并汇报。
不要向 worker 发"下一步做什么"的指令；全部到终态前批次不算完成。${notesBlock(opts)}`;
}

function notesBlock(opts) {
  if (opts.notes.length === 0) return "";
  return `\n\n【附加说明】\n${opts.notes.map((note) => `- ${note}`).join("\n")}`;
}

const opts = parseArgs(process.argv.slice(2));
console.log(opts.urls.length === 1 ? singleSitePrompt(opts) : multiSitePrompt(opts));
