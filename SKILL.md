---
name: crawl-products
description: "用视觉优先的三步 preflight（站点判定 → 路径探索 → 终止契约）加机械收割脚本，在本地 Chrome 或 Codex In-App Browser 中抓取品牌官网/自营商城的营养品目录：脚本收齐证据包与图片落盘，模型离线推断 form/healthFunctions/mainIngredients，三层验证后严格导出 Supply Smart product/enrich 请求。适用于品牌站营养品目录、Facts 图片读取、语义补全、完整商品 URL 和批量产品数据抓取。"
---

# 自适应爬取营养产品

分工原则：**动态判断归模型，机械执行归脚本**。模型做站点判定、路径探索、终止契约、语义推断和验证判定；`runHarvest()` 脚本做枚举、提取、落盘、重试和看门狗。完整架构见 [harvest-architecture.md](references/harvest-architecture.md)。

## 硬约束

**数据真实性**

- 每个最终产品必须来自真实 HTTP(S) 详情 URL；列表页或合成 URL 只能作为待补库存。
- “发现了 N 个”与“完整提取了 N 个”分开统计；标题加缩略图是 partial。
- API-ready 每条必须有 `productUrl`、`productName`、完整画廊复核、`productForm`、`healthFunctions`、`mainIngredients`；缺项进 review/error 队列，不得空数组静默通过。

**验证痕迹（通则）**

- 任何结论——找到了、没有、通过、不通过——必须带痕迹：`method`（怎么验的）、`surface`（在哪验的：local_file / dom_snapshot / live_site / artifacts）、`evidence`（看了什么）、`verifier`（谁验的）。无痕迹 = 未验证。
- “没找到”不是失败，是待证明的主张：`not_present` 必附覆盖清单，由 Tier 1 审计对账（见「语义队列」）。

**画廊与 Facts**（→ [semantic-enrichment.md](references/semantic-enrichment.md)）

- 画廊逐图检查，保留最佳直接 CDN/原图 URL；同资产去重，推测原图先验证 MIME 与尺寸。
- 疑似 Facts/Ingredients/Label/背标及无标签后续图必须读取图片内容（收割后读本地落盘文件），不能只看 alt 或文件名。
- 折叠标题（`Ingredients`、`Supplement Facts` 等）不是字段内容；只有标题视为缺失。

**语义**（→ 「语义队列」）

- `productForm`、`healthFunctions`、`mainIngredients` 由模型推断，脚本只验证证据、置信度、taxonomy 和医疗声称安全。
- 严格输出的每个 `mainIngredients` 项必须是 `{name, substance, form?, category}` 对象。
- 语义回合每条记录强制执行；`inventory_partial` 不豁免。

**范围**（→ [nutrition-product-scope.md](references/nutrition-product-scope.md)、[site-outcomes-and-handoffs.md](references/site-outcomes-and-handoffs.md)、[variant-enumeration.md](references/variant-enumeration.md)）

- 默认排除 Bundle/Pack/Kit/Stack/Set/Regimen/Duo/Trio/Multi-pack 及非营养商品，排除保留原因。
- 变体逐一记录，身份按 `variantId`/SKU → 选项组合 → 变体 URL。
- 综合多品牌卖场在 Preflight A 归类为 `multi_brand_retailer` 并终止；只有用户识别结果后明确要求才一次性覆盖。
- 入口官网无目录但有直属官方 Brand 时自动展开一层 portfolio，不递归子品牌。

**完成判定**

- worker 无权自我宣告 complete；**complete = 通过 `verifyRunArtifacts()` Tier 1 审计**。
- `incomplete` 不是合法回合终点；它的唯一合法动作是 resume（必要时先重建 binding）。合法终点只有三种：complete、有证据的 terminal、点名具体阻塞物的 blocked。
- 每条记录必达终态：`ok` / `excluded`(原因) / `review`(完整尝试史+原因)；运行级 complete 不要求 review 为空，但 review 每条必须有原因。
- 防循环四道闸（尝试签名 / 三级预算 / 干轮检测 / review 终态）见 [harvest-architecture.md](references/harvest-architecture.md) §8。

**持久化与导出**

- 写盘为准：state.json、HarvestPlan、checkpoint、证据包、队列全部落盘；线程死了重入线程从磁盘继续。
- profile/HarvestPlan 只存可复用方法，不存 Cookie、请求头、响应体或商品字段值。
- 最终接口数据必须由 `lib/enrich-product-output.mjs` 生成，符合 [enrich-product-output.md](references/enrich-product-output.md)。

## 浏览器

`browserMode` 默认 `"extension"`（本地 Chrome）；公开站点的多任务并发可显式选择 `"iab"`。用户明确选择的浏览器是硬约束，不得静默换成另一种模式；**同模式重建断掉的 binding 不算切换，是 incomplete 恢复的标准动作**。

唯一的例外（用户长期授权）：**IAB 平台层拒绝访问站点**（如 `iab_site_safety_policy_rejected_navigation`）时，降级为 `extension` 继续，降级原因写入 worker-notes 并在汇报中说明。此例外只覆盖 IAB 自身的访问策略拒绝；站点侧的 challenge、登录墙、TLS 错误不适用，仍按原分类处理。extension 是单租约：批次中多个站点需要它时，只能排队顺序执行，禁止并发。

外部 Chrome 先完整读取 `chrome:control-chrome` 的 `SKILL.md`；In-App Browser 先完整读取 `browser:control-in-app-browser` 的 `SKILL.md`。建立绑定：

```js
if (globalThis.crawlBrowser == null) {
  const binding = await agent.browsers.get(browserMode); // "extension" 或 "iab"
  await binding.nameSession("🔎 crawl-products <site>");
  nodeRepl.write(await binding.documentation());
  globalThis.crawlBrowser = binding;
}
globalThis.crawlProductsTab ??= await crawlBrowser.tabs.new();
globalThis.tab = globalThis.crawlProductsTab;
```

- tab 污染（超时、断连、截图空白、`discardTab`）：`crawl.replaceTaintedTab(crawlBrowser, tab, error)` 换新 tab，写回 `crawlProductsTab` 和 `tab`。
- **binding 丢失**（`tabs.new()` 也失败）：置 `globalThis.crawlBrowser = null`，重新执行上面的绑定块，然后 `resume`。binding 丢失是执行面问题，不是站点终态，也不是"待复核"。
- **单页 target 反复崩溃**（某个商品页连续几次关闭/超时）：换 tab 重试一次，仍失败就把**该 URL** 记 `failed` 终态（带尝试史），继续其余商品。这是记录级执行故障，禁止据此判整站 terminal。
- **能力差异不是错误**：iab 没有 `browser.tabs.content()` 批量接口属正常，`runHarvest()` 会自动降级为逐页顺序提取；发现某接口缺失时不判 terminal、不换浏览器模式。
- Full CDP 按 origin 授权；被拒时继续用截图和 DOM。`blocked_by_browser_url_policy` 是执行面限制，不是站点不可访问证据。

## 初始化

```js
globalThis.SKILL = "<本 Skill 目录绝对路径>";
globalThis.crawl = globalThis.crawl ?? await import(`${SKILL}/lib/crawl.mjs`);
globalThis.harvest = globalThis.harvest ?? await import(`${SKILL}/lib/run-harvest.mjs`);
globalThis.harvestPlan = globalThis.harvestPlan ?? await import(`${SKILL}/lib/harvest-plan.mjs`);
globalThis.verify = globalThis.verify ?? await import(`${SKILL}/lib/verify-run-artifacts.mjs`);
globalThis.semanticQueue = globalThis.semanticQueue ?? await import(`${SKILL}/lib/semantic-queue.mjs`);
globalThis.productSemantics = globalThis.productSemantics
  ?? await import(`${SKILL}/lib/product-semantics.mjs`);
globalThis.productOutput = globalThis.productOutput
  ?? await import(`${SKILL}/lib/enrich-product-output.mjs`);
globalThis.browserMode ??= "extension";
globalThis.outDir ??= `${nodeRepl.cwd}/.crawl-products/runs/<site>`;
```

开始前明确：入口 URL（一个或多个）、数量上限、是否要 API-ready、商品范围。默认字段：

```js
globalThis.sourceFields = [
  "title", "price", "description", "images", "ingredients", "supplement_facts",
  "sku", // 可选字段：页面/JSON-LD/变体有就抓，缺失不算 partial
];
```

## 生命周期与状态机

每个站点一个输出目录，`<outDir>/state.json` 是唯一的进度真值。任何回合开始先读它，从对应状态继续：

```
missing        → 执行 Preflight A/B/C，合成并校验 HarvestPlan
plan_ready     → await harvest.runHarvest(...)（长调用，等它返回）
harvest_done   → 验证①查漏 → 构建语义队列并处理
incomplete     → 重建 binding（若断）→ runHarvest(..., { resume: true })
semantic_done  → Tier 1+2+3 验证
verifying      → 按四道闸打回或通过
verified       → 严格导出，写 state=complete
complete       → 结束
```

**汇报 incomplete 后停下是违规**。脚本运行期间线程阻塞在 `await` 上，不需要也不允许把控制权交出去等待指令。

**`state.json` 由引擎独占写入**，固定 schema `{state, updatedAtMs}`；harvest 之后的状态推进只能用 `harvest.updateRunState(outDir, state, notes)`——它会把 notes 追加到 `worker-notes.json`。禁止手写或改造 `state.json` 结构（自定义结构会直接导致 Tier 1 审计 fail，视为谎报）。resume 原因、决策记录等叙述性内容一律进 `worker-notes.json`。

## Preflight 三步（模型 + 浏览器）

**A. 要不要做** → `entry-decision.json`
截图判定站点身份（`crawl.classifySiteOutcome()`，规则见 [site-outcomes-and-handoffs.md](references/site-outcomes-and-handoffs.md)）：
- `multi_brand_retailer` → 立即以 `multi_brand_retailer_excluded` 终止，0 条记录；
- `portfolio` → 视觉验证直属 Brand，每个 Brand 站各自走完整生命周期（深度 1，不递归）；
- `storefront` / `official_store_handoff` → 继续 B。
判定必须带截图证据引用。

**B. 路怎么走** → `route-plan.json`
视觉首遍连续走通：完整目录族 → listing/分页 → 代表详情 → 每个源字段 → 全部画廊/Facts 候选 → 变体选择器每个可售状态（[variant-enumeration.md](references/variant-enumeration.md)）→ 明确不存在的字段留 `not_present` 证据。走通后回入口重放，把路线固化为 seeds、分页动作、detail/image/variant profile（schema 见 [profile-schema.md](references/profile-schema.md)，质量门见 [replay-quality-gates.md](references/replay-quality-gates.md)：至少 2 个真实详情样本通过，单商品目录允许 1 个）。坐标不持久化，只存稳定 selector 和动作语义。

**C. 怎么算结束** → `termination-contract.json`
探索时顺手回答每个 seed"我怎么知道翻完了"：
- 耗尽信号：`next_link_absent` / `button_gone` / `no_new_urls_after_clicks:N` / `no_new_cards_after_scrolls:N` / `single_page_confirmed`（必须与分页方式匹配，校验器会查）；
- 对账 oracle：sitemap 计数、列表页声明计数（"200 products"）、Shopify `products.json`；
- 预算：maxItems / maxPagesPerSeed / wallClockMinutes / stallMinutes / retryPerUrl。

## HarvestPlan 与机械收割

三份产物合成 HarvestPlan，校验通过才能启动：

```js
const { valid, errors, plan } = harvestPlan.validateHarvestPlan({
  site: { origin, entryUrl, browserMode },
  decision: { kind: "storefront", evidence: ["screenshot:entry.png"] },
  route: { listingSeeds, detailProfile, imageProfile, variantProfile, expandActions },
  termination: { perSeed, oracles, budgets, retryPerUrl },
});
if (!valid) throw new Error(errors.join(","));   // 缺终止契约=回 Preflight C，不是硬闯

globalThis.result = await harvest.runHarvest(crawlBrowser, tab, plan, {
  outDir,
  fields: sourceFields,
  // 用户明确只要前 N 个（成本封顶）时才传；命中 maxItems 会以
  // complete + oracle "capped" + result.productLimit.accepted 诚实收尾
  // acceptProductLimit: true,
});
globalThis.tab = result.activeTab ?? tab;   // 运行中换过污染 tab 时同步回来
```

**引擎产物只能由引擎写**：`harvest-result.json`、`checkpoint.json`、`evidence/` 禁止手改。封顶运行想要 complete，唯一合法途径是 `acceptProductLimit: true`——手改 oracle 状态或 counts 属于谎报，审计会核对 `capped` 与 `productLimit.accepted` 的一致性。同理，本地 patch 引擎源码属于禁止行为：引擎缺能力时记录 blocked/incomplete 并在汇报中说明，由维护者修引擎。

`runHarvest()` 固定生命周期：枚举到不动点（零增长收敛 + oracle 对账）→ 提取到队列排空（每 URL 终态：complete/failed/excluded，方法阶梯 batch_content → rendered_upgrade，binding 无批量接口时自动全走顺序渲染路径，尝试史落盘）→ 平台变体展开与 SKU 回填（`/products/<handle>.json` 探测，详见 [variant-enumeration.md](references/variant-enumeration.md)）→ 证据包与全部画廊图片落盘 → 看门狗兜底。**收割期 scope 只做 URL 级排除**（显式 bundle/非营养 URL），营养证据判定推迟到语义阶段——没有 ingredients/facts 的记录此时必须保留。

**目录口径**：目录 = 站点导航视觉可见的商品。平台数据端点只用于已发现商品的变体/SKU 补全；端点独有、导航点不进去的隐藏商品**默认不属于目录、不追加、不算漏抓**，端点总数也不作为 oracle 期望值。退出只有三值：

```js
switch (result.status) {
  case "complete":   /* → 验证①查漏，然后语义队列 */ break;
  case "incomplete": /* → 修复 binding/tab 后必须 resume：*/
    globalThis.result = await harvest.runHarvest(crawlBrowser, tab, plan, {
      outDir, fields: sourceFields, resume: true,
    });
    break;
  case "terminal":   /* → 带证据报告 */ break;
}
```

产物（全部在 outDir）：`state.json`、`harvest-plan.json`、`checkpoint.json`、`harvest-result.json`、`evidence/records.json`（证据包）、`evidence/img/`（落盘图片）、`evidence/field-presence-stats.json`（字段出现率先验）。

## 语义队列（模型，无浏览器）

收割完成后先做**验证①查漏**（见「验证」），再构建队列：

```js
const packages = JSON.parse(await fs.readFile(`${outDir}/evidence/records.json`, "utf8"));
globalThis.queue = semanticQueue.buildSemanticQueue(packages);   // 证据有洞的自动进 needs_browser
const priors = semanticQueue.computeFieldPresencePriors(packages);
```

对每个 `pending` 条目执行强制语义回合（细则见 [semantic-enrichment.md](references/semantic-enrichment.md)）。**范围终判也在这里**：收割期只按 URL 排除了显式 bundle，此时结合读到的证据做完整判定（`classifyNutritionSingleProduct` 规则），bundle/非营养的记录写 `status:"excluded"` + 原因，是合法语义终态之一：

1. `brief = productSemantics.buildSemanticEvidenceBrief(record)`；Facts 候选图用 `gallery[].localPath` 直接 Read 本地文件，逐张判定并 `productSemantics.finalizeFactsImageReview()` / `finalizeFactsIngredientReview()`；`finalizeGalleryReview()` 后用 `finalizeFactsSourceReview()` 封存页面元素+画廊双来源检查。
2. 推断 `form`、至少一个宽泛 `health_function`（页面有用途文案时不得留空）、可证明的 `main_ingredients`；每个值带 basis/confidence/evidence，inferred 带 rationale。`normalizeProductSemanticEnrichment()` → `mergeProductSemanticEnrichment()` → `semanticCompletion()`。
3. 某字段没找到时**不消耗重试**，走判定：

```js
const verdict = semanticQueue.adjudicateNotFound("facts_image", pkg, priors);
// fill_gaps          → 只补列出的洞（定向），回到第 1 步
// second_look        → 重看本地证据一次（惊讶度触发），然后带 secondLookDone 重判
// accept_not_present → 记 not_present + 覆盖清单 + 验证痕迹，终态
```

4. 写回终态（校验器强制 review/needs_browser 带原因、enriched 带痕迹）：

```js
const { applied, errors, entry } = semanticQueue.applySemanticOutcome(queueEntry, {
  status: "enriched",   // 或 "review" / "needs_browser"
  trace: { verdict: "enriched", method: "visual_image_read", surface: "local_file",
           evidence: ["evidence/img/abc.jpg"], verifier: "semantic:enrich" },
}, pkg);
```

队列排空（`semanticQueue.semanticQueueSummary(queue).drained === true`）才算 `semantic_done`。`needs_browser` 条目是收敛的小尾巴：模型+浏览器按 gaps 定向补证据后送回队列。队列进度随时落盘 `semantic-queue.json`。

**review 的合法性边界**：review 表示"证据在手但确实推断不出"，原因必须**具体到该记录**（缺哪个字段、看了哪几张图、为何建不了 taxonomy）。证据完整却成批塞 review 是变相跳过强制语义回合，属于谎报——Tier 1 审计会拦截：≥80% 的 review 共用同一原因 = fail；review 占比超过 `reviewAlertRatio`（默认 20%）时禁止写 verified/complete，必须以 blocked 上报并点名原因分布。

## 验证

**验证①查漏**（harvest_done 后、语义前，模型+浏览器，抽样）：不看 HarvestPlan 的 seeds 独立走一遍站点导航，随机开 `min(10, 20%)` 个商品，逐一确认在证据包里；漏一个 → 补 seed，回 harvest。早发现漏商品，别等语义做完才重爬。

**验证②**（semantic_done 后）：
- Tier 1 机械审计（全量，免费）：`const report = await verify.verifyRunArtifacts(outDir); await verify.writeVerificationReport(outDir, report);` 账目、状态-产物一致性、图片落盘、Facts 复核、not_present 覆盖、原因齐全——`report.status === "pass"` 才能进入导出。
- Tier 2 查真（抽样）：抽 K 条重开 `productUrl`，核对标题/价格/画廊数/变体数；抽样一败即升级（扩样或该维度全查）。
- Tier 3 语义对抗（main_ingredients 全量，form/health_function 抽样）：验证者只拿证据包+结论（不含推理），任务是设法推翻；refuted 打回语义队列。

打回受四道闸约束：同 (原因, 方法) 组合不重打；单记录每原因 2 次、verify→fix 整轮最多 2 轮、同族 ≥50% 同失败即熔断修 profile；净修复数为 0 立即停；预算尽头是 `review` 终态而不是继续循环。只有 review 占比 >20% 或 blocked 类原因（登录/授权/challenge）才升级给用户。

## API-ready 导出

前提：`state=verified` 且 `verification-report.json` 为 pass。导出规则不变（[enrich-product-output.md](references/enrich-product-output.md)）：

```js
const exported = await productOutput.writeEnrichProductExport(outDir, enrichedRecords, {
  processedAt: new Date().toISOString(),
  updateExisting: false,
  runCompletion: { status: "complete" },
});
```

严格模式拒绝缺 `productUrl`、`price`、图片、gallery review、双来源 Facts review、form、healthFunctions、mainIngredients、语义证据或缺 `substance/category` 的主成分。正式产物批次级全有或全无；`review` 记录单独成文件，不进 `products.json`。中间库存必须显式 `outputMode:"inventory_partial"` 并写 `semantic-review-queue.json`。`domain` 默认公司可注册域名；`price` 默认必导出（页面价 → 变体价，原样字符串），`sku` 为可选字段有值才输出。除非用户明确授权，只生成请求文件，不调用接口。

## 多站点与 worker 线程

规则详见 [multithread-browser-workers.md](references/multithread-browser-workers.md)。要点：

- **spawn 时定并发**：先验证独立浏览器 lease 数（`extensionInstanceId` / `browserId`），N 个 lease 开 N 个线程；共享 lease 的站点合进同一线程顺序跑。运行期零协调。
- **一个线程 = 一个站点 = 一个 goal**，全生命周期不换手。goal prompt 模板：

```
你的唯一目标：让 <site> 达到三种终态之一，在此之前不得结束回合：
  complete / terminal(带证据) / blocked(点名具体阻塞物)
工作方式：读 <outDir>/state.json，按 crawl-products SKILL.md 的状态机从对应状态继续。
汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume。
```

- **协调者只做两件事**：轮询各线程 state.json；发现停滞或线程死亡，把同一 goal prompt 原样重发（线程可重入，从磁盘续）。收货前必跑 `verifyRunArtifacts()`。
- 同一 tab 上永不并发操作；详情读取默认顺序。

## 结果汇报

分别报告：目录入口/seed 覆盖与耗尽信号；oracle 对账结果；发现 URL 数 vs 完整证据包数；complete/failed/excluded/review 各计数及主要原因；Facts confirmed/not_present（带覆盖）/待复核数；form、healthFunctions、mainIngredients 覆盖率；验证三层的结果与打回轮次；API-ready 条数与具体错误。不得用"抓到了"混称 URL 发现、证据包和完整语义记录三种状态。

## 参考文件

- [harvest-architecture.md](references/harvest-architecture.md) — 总架构
- [browser-evidence-and-site-profiles.md](references/browser-evidence-and-site-profiles.md)
- [profile-schema.md](references/profile-schema.md)
- [replay-quality-gates.md](references/replay-quality-gates.md)
- [nutrition-product-scope.md](references/nutrition-product-scope.md)
- [variant-enumeration.md](references/variant-enumeration.md)
- [semantic-enrichment.md](references/semantic-enrichment.md)
- [enrich-product-output.md](references/enrich-product-output.md)
- [site-outcomes-and-handoffs.md](references/site-outcomes-and-handoffs.md)
- [multithread-browser-workers.md](references/multithread-browser-workers.md)
