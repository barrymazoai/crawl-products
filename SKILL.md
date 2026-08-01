---
name: crawl-products
description: "在 Codex App 连接的用户本地 Chrome 中，由模型用视觉优先的自适应循环发现并验证完整营养品目录、详情字段、全部画廊与 Facts 图片，再按需映射 DOM/CDP/Network 规则并持久化复用；默认排除 Bundle/Pack/Kit 与非营养商品，支持母公司到直属 Brand 一层、证据驱动的 form/healthFunctions/mainIngredients 推断，以及 Supply Smart product/enrich 严格格式导出。适用于品牌站、商城、营养品目录、Facts 图片、语义补全、完整商品 URL 和批量产品数据抓取。"
---

# 自适应爬取营养产品

这个 Skill 的执行者是模型，脚本是可组合的取证、提取、校验和持久化工具。不要把某个脚本成功等同于任务完成，也不要因为预设流程失效就停止使用模型的观察、判断和变通能力。

## 不可协商的结果约束

以下是硬约束；达到它们的方法由模型按站点实时决定：

1. 每个最终产品必须来自真实 HTTP(S) 详情 URL；列表页或 `#inline-product=` 合成 URL 只能作为待补库存，不能进入 API-ready 输出。
2. “发现了 N 个商品”与“完整提取了 N 个商品”分开统计。标题加缩略图是 partial，不是完整详情。
3. 请求 API 完整产品时，每条必须有 `productUrl`、`productName`、完整画廊检查、`productForm`、`healthFunctions` 和 `mainIngredients`；缺一项进入 review/error 队列，不能用空数组静默通过。
4. 画廊必须逐图检查，并保留每个资产能取得的最佳直接 CDN/原图 URL；缩略图或列表卡片图不能冒充完成数据。图片代理、缓存和尺寸变体按原始资产身份去重，替换成推测原图前必须在真实浏览器验证图片 MIME 与尺寸。疑似 Supplement Facts、Nutrition Facts、Drug Facts、Product Facts、Ingredients、Label、背标和无标签后续图必须读取图片内容；不能只看第一张图或 `alt`。
5. Facts/Ingredients 图片存在时，`mainIngredients` 优先从图片中读；网页 Zoom 点不开时，直接从 DOM、Network、CDP 或 page assets 取得图片资源后打开复核，不能因此终止产品。
6. `productForm`、`healthFunctions` 和 `mainIngredients` 由模型结合页面证据推断；脚本只验证证据、置信度、taxonomy 和医疗声称安全，不用固定词表替代模型判断。严格输出里的每个 `mainIngredients` 项必须是 `{name, substance, form?, category}` 对象：`category → substance → form? → name`。纯字符串只能留在 partial 证据中，不能进入 API-ready 数据。
7. 默认排除 Bundle、Pack、Kit、Stack、Set、Regimen、Duo/Trio、Multi-pack 及非 Nutrition 商品。排除必须保留原因。
8. 母公司可展开到直属 Brand 一层；Brand 的官方商城接力仍属于同一层，不继续递归 Brand 下面的子品牌。
9. profile 只保存可复用方法，不保存 Cookie、请求头、响应体或商品字段值。失败的假设不能保存成已验证规则。
10. 最终接口数据必须使用 `lib/enrich-product-output.mjs` 生成，并符合当前 [enrich-product-output.md](references/enrich-product-output.md)。

## 浏览器

默认使用 `chrome:control-chrome` 连接用户已打开的本地 Chrome。先完整读取该 Skill 的 `SKILL.md`，再建立独立绑定：

```js
if (globalThis.chrome == null) {
  globalThis.chrome = await agent.browsers.get("extension");
  nodeRepl.write(await chrome.documentation());
}
globalThis.crawlBrowser = globalThis.chrome;
globalThis.crawlProductsTab ??= await crawlBrowser.tabs.new();
globalThis.tab = globalThis.crawlProductsTab;
```

不要静默改用 Codex in-app Browser、外部 Playwright 或独立浏览器服务。只有用户明确选择 in-app Browser，或 Chrome 不可用后明确同意切换，才使用 `browser:control-in-app-browser`。

Full CDP 按 origin 授权；被拒绝时继续使用截图和 DOM，并说明需要授权的能力。`blocked_by_browser_url_policy` 是浏览器执行面限制，不是站点不可访问证据。

浏览器超时、扩展断连、截图异常空白或 `discardTab` 属于执行面问题。换同一浏览器绑定下的新 tab 后重试；不能把它保存成站点 unavailable：

```js
if (crawl.shouldDiscardBrowserTab(error)) {
  const recovery = await crawl.replaceTaintedTab(crawlBrowser, tab, error);
  globalThis.crawlProductsTab = recovery.tab;
  globalThis.tab = recovery.tab;
}
```

## 初始化与任务契约

```js
globalThis.SKILL = "<本 Skill 目录绝对路径>";
globalThis.crawl = globalThis.crawl ?? await import(`${SKILL}/lib/crawl.mjs`);
globalThis.engine = globalThis.engine ?? await import(`${SKILL}/lib/engine.mjs`);
globalThis.productSemantics = globalThis.productSemantics
  ?? await import(`${SKILL}/lib/product-semantics.mjs`);
globalThis.productOutput = globalThis.productOutput
  ?? await import(`${SKILL}/lib/enrich-product-output.mjs`);
globalThis.profileDir ??= `${nodeRepl.cwd}/.crawl-products/profiles`;
```

开始前明确：入口 URL、数量上限、是否要 API-ready、站点范围、是否允许一层 portfolio。营养品 API 任务默认：

```js
globalThis.sourceFields = [
  "title", "price", "description", "images", "ingredients", "supplement_facts",
];
globalThis.maxItems = 200;
globalThis.productScope = "nutrition_single_products";
```

`facts_images`、`form`、`health_function`、`main_ingredients` 是详情取证后的视觉/语义阶段，不要把它们当成普通 DOM 字段盲跑。

## 核心循环：观察 → 判断 → 行动 → 验证 → 学习

每个未知点都走这个循环。对未知站点，首遍必须先用截图和视觉操作把“完整目录族 → 商品 → 详情字段 → 画廊”连续走通；这一遍不穿插 DOM、CDP、Network、`pageAssets` 或旧自动发现。视觉路线完整后回到入口正向重放，第二遍才用这些能力解释结构并固化规则。已有且通过代表样本校验的 profile 可以直接重放，不需要重复首遍。

### 1. 观察

- 导航入口并截图，识别店铺、目录、国家选择、母公司、单页目录、challenge、错误页和弹层。
- 用视觉找到完整目录族、分类层级、分页/Load More、代表商品、详情全部区域和画廊。
- 不要因为 `Best Sellers`、单一分类或当前可视的 20 个卡片就宣布完整目录。
- 首遍某一步看不清时，继续通过截图、滚动、关闭遮罩、切换可见 tab/accordion 或更换干净 tab 判断；不能提前用 DOM/CDP 猜出一条路线再把它包装成视觉发现。

### 2. 判断

模型根据当前证据选择下一步，而不是机械执行固定序列：

- 路径清晰且 profile 有效：快速重放。
- 页面结构变动、字段覆盖异常、批量失败同质化、只有缩略图或语义为空：暂停批量，重新截图定位代表模板。
- 同站有多种产品模板/分类族：按差异选多个代表样本，不局限一个商品。
- 列表没有真实详情页：确认它确实是 inline catalog 后保留 inline 记录；若卡片含 href，必须先把 href 当详情候选。
- 模型可以调整批次大小、等待方式、重试策略、是否替换 tab、是否启用 CDP/Network，以及要检查多少代表样本。

### 3. 行动

可按情况组合以下原语，不要求必须调用某个黑盒：

- `captureVisualScreenshot()`：视觉侦查和异常复核。
- `replayVisualRoute()`：把视觉走通的动作倒映射为 selector、字段展开、画廊和网络规则。
- `collectProductUrls()`：在已确认 listing seeds 上回放卡片和分页规则。
- `extractProductsBatch()`：批量获取详情页面证据。
- `upgradeProducts()`：对缺字段/缺画廊的 URL 逐页补采；默认不会因前三个同类失败而静默跳过余下产品。
- `collectRenderedProductImageUrls()` / `captureBrowserEvidence()`：恢复真实画廊和直接资源。
- `finalizeGalleryReview()`：验证每个最终图片 URL 都有逐图视觉判定。
- `buildSemanticEvidenceBrief()`：给模型生成有限、可审查的单品语义证据包。
- `normalizeProductSemanticEnrichment()`：校验模型产出的推断。
- `writeEnrichProductExport()`：严格导出。

脚本返回 partial、skip、timeout 或空字段时，模型要阅读有界的 record/error 样本并决定恢复动作。可以打印 `crawl.summarize(result)`，也可以检查少量目标 record；不要输出全部大记录污染上下文。

### 4. 验证

每次扩大批量前验证代表样本，至少覆盖已观察到的不同分类族、模板和画廊行为：

- 真实详情 URL 能重新打开；
- 标题是商品名，不是站点名或规格数字；
- 详情字段来自对应商品；
- 所有分类与分页入口有覆盖证据；
- 画廊不是只有列表缩略图，且可推导的原图已经过 MIME/尺寸验证；或已视觉确认该商品确实只有一张可用图片；
- Facts 候选已经逐张判定；
- 语义字段有 evidence、basis、confidence，推断值有 rationale；
- scope 排除与保留结果合理。

验证失败时只废弃对应假设或模板规则，保留仍成立的导航/分类证据；回到观察循环，而不是全站从头重来或强行继续。

### 5. 学习

把通过验证的导航、listing seeds、分页动作、商品卡、详情展开、字段 selector、画廊、图片资源和窄 Network 规则保存到 origin profile。profile 是“可复验的假设”，每次复跑先做廉价多样本校验。新 profile 至少要有 2 个真实详情样本通过源字段校验；只有完整目录证明确实只有 1 个商品时才允许用该 1 个样本晋级。0 商品、错误页或全是 partial 时不得保存/覆盖正式 profile。

进度要增量保存。`extractProductsBatch()` 和 `upgradeProducts()` 支持 `onProgress`；将已处理 URL、partial/complete 状态、失败和 records 写入任务 checkpoint。崩溃后从未完成 URL 恢复，不重复探索已验证路径。

换电脑时 profile 不会自动随模型记忆迁移；复制对应 origin profile、使用同步的 `profileDir`，或重新执行视觉学习。

## 路径学习：先视觉走通，再倒映射

未知站点从截图开始，连续走到：完整目录族 → listing/pagination → 代表详情 → 每个源字段 → 全部画廊/Facts 候选。视觉确认目标后，再回入口重放并记录 DOM/CDP/Network。

视觉路线不是只到详情页。它还包括：

- 分类菜单需要的展开和滚动；
- sibling category families；
- pagination / Load More；
- 商品卡到真实详情 URL；
- 详情 tab、accordion、read-more；
- 画廊缩略图、主图、直接资源和 Facts 图；
- 字段明确不存在时的 `not_present` 证据。

坐标只用于当前视觉定位，不能持久化。profile 保存稳定 selector、动作语义、结构指纹、网络规则和验证条件。完整 schema 见 [profile-schema.md](references/profile-schema.md)，重放质量门见 [replay-quality-gates.md](references/replay-quality-gates.md)。

已有 profile 校验失败时允许模型重新视觉侦查并修补 profile；“后续只回放、绝不重新看图”是错误行为。

## 目录覆盖与一层 portfolio

普通站点默认 `same_site`。只有用户要求集团/母公司产品时才展开视觉确认的直属 Brand；深度固定为 1。官网到同 Brand 官方商城是 handoff，不增加品牌层级。

第三方详情仅在品牌商品卡明确给出精确购买/详情链接时跟随；不递归第三方根目录、Marketplace 或下一层品牌。每个 origin 独立保存 profile。

完整目录的完成条件：所有视觉确认的分类族均有 listing seed，分页/Load More 已耗尽或达到用户上限，去重后的详情 URL 数稳定，并且不是只抓当前一个页面。

## 画廊、Facts 与语义

详细规则必须读取 [semantic-enrichment.md](references/semantic-enrichment.md)。关键顺序：

1. 收集真实详情页的完整画廊及 alt/title/index/最佳直接资源；同资产的缩略图/代理/原图去重，推测的原图必须先通过真实浏览器 MIME 与尺寸验证。
2. 在同一详情页视觉检查 DOM/Table/accordion/text 中是否存在 Supplement Facts、Nutrition Facts、Ingredients 或 Key Ingredients；把 found/not_present 和可见证据记录下来。不能因为画廊有 Facts 图就跳过页面元素检查。
3. `classifyFactsImageCandidate()` 只做候选分流。
4. 对明确 Facts、Ingredients/Label/背标及无标签后续图片直接打开资源并截图读取。
5. `finalizeFactsImageReview()` 记录确认结果；只靠文件名或 alt 不算视觉确认。
6. 有一张或多张 Facts 图片时逐张读主要/活性成分行，每张分别调用 `finalizeFactsIngredientReview()`；合并时必须保留所有图片的成分与证据，后一次不能覆盖前一次。
7. 调用 `finalizeGalleryReview(images, reviews)` 后，再用 `finalizeFactsSourceReview()` 同时封存“页面元素已检查”和“画廊已检查”的结果。
8. 对每个产品生成 `buildSemanticEvidenceBrief(record)`，由模型推断 form、health function 和 main ingredients。
9. 用 `normalizeProductSemanticEnrichment()` 校验，再用 `mergeProductSemanticEnrichment()` 合并。
10. `finalizeGalleryReview()` 要求每个最终图片 URL 都有 `reviewedVisually:true` 和明确 Facts 判定。不要手写完成状态绕过逐图检查。

不得用成分正则、固定商品词表或标题关键词假装完成语义阶段。确定性工具可以提取原文、去重、验证格式；跨字段理解与合理推断交给模型。

## 批量、恢复与完成状态

`crawlSite()` 是已验证规则的快速组合路径，不是唯一执行方式。调用示例：

```js
globalThis.result = await crawl.crawlSite(crawlBrowser, tab, startUrl, {
  fields: sourceFields,
  maxItems,
  productScope,
  profileDir,
  visualRoute,
  listingProfile,
  profile: detailProfile,
  imageProfile,
  cdpProfile,
  requireGalleryReview: true,
  onProgress: async (progress) => persistCheckpoint(progress),
});
console.log(crawl.summarize(result));
```

`recordsExtracted` 是库存数；查看 `recordsComplete`、`recordsPartial` 和 `reviewQueue` 判断详情是否完成。不要因为 inventory 有 202 条就声称 202 条均已提取。

遇到连续失败时，先抽查错误产品截图和 DOM/Network，判断是统一模板问题、另一模板族、tab 污染、限流还是字段确实不存在。只有用户明确接受成本截断时才设置 `disableAfter`；被跳过的条目仍是 review，不是成功。

## API-ready 导出

在导出前对每条执行语义与画廊完整性检查。默认严格导出：

```js
const exported = await productOutput.writeEnrichProductExport(
  outDir,
  enrichedRecords,
  {
    processedAt: new Date().toISOString(),
    updateExisting: false,
  },
);
```

固定产物：

- `products.json`：主要最终数据，数组内每项都是完整 `{"json": input}`。
- `product-enrich-inputs.json`：仅内层 input 的调试/分析文件。
- `product-enrich-requests.json`：完整请求 envelope 数组。
- `product-enrich-requests.jsonl`：每行一个可 POST 的 envelope。
- `crawl-records.json`：原始字段与证据。
- `product-enrich-errors.json`：任何缺失项及原因。
- `enrich-export-report.json`：收到、可提交和失败数。

严格模式会拒绝缺真实 `productUrl`、图片、gallery review、DOM+画廊 Facts source review、form、health functions、main ingredients、对应的模型语义证据，或任何缺 `substance/category` 的主成分。若有多张 Facts 图，每张都必须有成分视觉复核记录。只有用户明确要求 partial/inventory 输出时才传 `allowPartial:true`，并明确标注它不能直接当成完成数据提交。

`domain` 默认使用公司可注册域名，例如 `us.shaklee.com` → `shaklee.com`；数据库使用特殊公司域名时通过 `domain` 或 `domainByOrigin` 显式覆盖。`productUrl` 始终保留完整详情 URL。

`updateExisting:false` 命中同名+同公司时接口会跳过；补已存在产品的数据时用 `updateExisting:true`。除非用户明确授权，Skill 只生成请求文件，不调用接口。

## 结果汇报

必须分别报告：

- 目录入口/分类族/分页覆盖；
- 发现的真实详情 URL 数、inline 待补数；
- 完整记录、partial、失败、scope 排除数；
- 多图覆盖、Facts confirmed/not-present/待复核数；
- 原图升级、被拒绝的原图候选及仍为缩略图的 review 数；
- form、healthFunctions、mainIngredients 覆盖；
- profile 新建/复用/修补及 checkpoint；
- API-ready 条数和具体错误原因。

不得用“抓到了”同时指代 URL discovery、列表库存和完整详情三种不同状态。

## 参考文件

- [browser-evidence-and-site-profiles.md](references/browser-evidence-and-site-profiles.md)
- [profile-schema.md](references/profile-schema.md)
- [replay-quality-gates.md](references/replay-quality-gates.md)
- [nutrition-product-scope.md](references/nutrition-product-scope.md)
- [semantic-enrichment.md](references/semantic-enrichment.md)
- [enrich-product-output.md](references/enrich-product-output.md)
- [site-outcomes-and-handoffs.md](references/site-outcomes-and-handoffs.md)
