---
name: crawl-products
description: "在 Codex App 连接的用户本地 Chrome 里用双遍流程爬取单品营养产品并学习可复用规则：首遍通过截图和视觉操作确认完整目录族、分页/Load More、代表商品和每个请求字段（含画廊 Facts 图片），第二遍从入口重放并把整条旅程映射成 DOM selector、目录覆盖、字段展开规则、网络请求和高清图证据，再持久化无字段值的站点 profile；默认排除 Bundle/Pack/Kit 和非 Nutrition 商品，支持基于页面证据派生 form、health_function、main_ingredients，输出 Supply Smart product/enrich 接口可直接消费的数据，也支持经视觉验证的母公司→直属 Brand 一层组合和品牌目录→第三方商品详情链接。适用于抓品牌站/商城营养品、保健品 Facts 图片、产品用途语义、建立产品库、竞品选品和批量商品 URL 提取。"
---

# 爬取产品目录

这个 skill 把 `browserbase-worker` 的确定性爬取引擎放进 Codex App 连接的用户本地 Chrome 运行。核心原则是：

1. **首轮严格走两遍**：第一遍只靠截图和视觉操作，先确认完整目录族和分页，再走到代表商品上的每个请求字段；第二遍回到入口正向重放，才读取 DOM、selector、Network 和 pageAssets。
2. **整条路线包括字段**：路线不是“到达详情页”就结束。标题、价格、描述、图片、成分、事实表在哪里，是否要滚动、切 tab 或展开 accordion，都是视觉路线的一部分。
3. **没有未知站点自动发现**：执行层不再提供首页词表、sitemap、平台接口或 store-root 自动试探。没有有效 profile 时，必须先完成视觉路线；`crawlSite` 会硬性拒绝未映射路线。
4. **视觉先证明，数据能力再解释**：第一遍不调用 DOM snapshot、locator、`evaluate`、CDP、sitemap 或平台枚举。截图坐标只在第二遍映射时临时使用，不能持久化。
5. **后续只回放 profile**：直接复用分类族、商品卡、详情字段、字段展开、图片和已验证 CDP 规则；只做廉价模板校验，不重新视觉探索。v3 profile 只复用导航/列表部分，并对代表详情页补做 v4 字段质量复核。
6. **规则与值分离**：profile 只存方法，不存商品字段值、响应体、请求头、Cookie 或会话信息。
7. **非空不等于正确**：价格、图片和页面类型必须通过质量门；规格数字、错误页标题、图标或跟踪图不能因为“有值”就算成功。
8. **超时后隔离 tab**：总预算和单次 browser/CDP 操作分别限时。出现 `discardTab` 的超时后立即关闭旧 tab、从同一 Chrome 绑定新建 tab；不能让上一站未结束的导航污染下一站。
9. **组合站只展开一层**：入口是母公司/集团时抓其视觉确认的直属 Brand 商品；Brand 的官方商城接力仍属该 Brand，但不得继续进入 Brand 下面的子品牌或第二层 portfolio。
10. **提取与推断分层**：原始字段来自页面；Facts 图片必须读取图片内容确认；`form`、`health_function`、`main_ingredients` 等派生字段可以综合页面信息推断，但必须保存 evidence、basis、rationale 和 confidence。
11. **默认只收单品营养产品**：候选 URL 先排除明显 Bundle/Pack/Kit，详情页再用标题、分类、形态、用法和 Facts 证据确认；护肤、美妆、家清、器械、配件以及没有营养证据的商品不进入结果，但必须保留排除原因。

确定性抽取规则在 `lib/engine.mjs`；浏览器编排在 `lib/crawl.mjs`。不要自己用 locator 遍历商品卡或逐字段抄页面。

## Browser 选择和能力

默认必须先遵循当前 `chrome:control-chrome` skill，连接用户正在使用的本地 Chrome，并读取该浏览器的完整文档。即使用户只给了目标 URL，也要显式选择 Chrome；不要调用 `getDefault()` 或 `getForUrl()`，不要静默创建 Codex in-app Browser，也不要改用外部 Playwright 或独立浏览器服务。

首次选择 Chrome 时使用独立持久绑定：

```js
if (globalThis.chrome == null) {
  globalThis.chrome = await agent.browsers.get("extension");
  nodeRepl.write(await chrome.documentation());
}
globalThis.crawlBrowser = globalThis.chrome;
```

连接后立即按当前 Chrome 文档给会话命名。后续轮次复用 `chrome`；tab 丢失或已关闭时只新建 tab，不重新选择浏览器。若扩展未安装、未连接或通信失败，先按 `chrome-troubleshooting` 恢复；仍失败就请用户在目标 Chrome profile 连接扩展。不要自动回退到内置浏览器。

只有用户在当前任务中明确要求 in-app Browser，或在 Chrome 不可用后明确同意切换，才遵循 `browser:control-in-app-browser` 建立独立 `iab` 绑定，并将 `crawlBrowser` 指向 `iab`。浏览器选择在整个任务内保持不变，不能因为登录、challenge 或访问失败自行换浏览器。

本 skill 会按实际能力自动降级：

- screenshot/CUA：首遍唯一的路径发现手段；用于识别正常店铺、国家选择页、单页目录、停放域名、错误页和弹层，并连续走到目标。
- DOM/Playwright：第二遍把已经走通的视觉动作映射成稳定 selector；不用它猜首遍路线。
- `cdp`：第二遍重放时启用 Network，读取点击/导航触发的事件，并用 `Network.getResponseBody` 取得未被客户端输出截断的 Document 或已学习产品接口响应。
- `pageAssets`：盘点当前页面实际加载过的图片，并可打包与当前商品画廊匹配的资源。
- DOM 也是 CDP 被拒绝或不可用时的稳定数据回退；不把截图/OCR 当批量字段真值。

Full CDP 是**按 origin 授权**的。用户拒绝或能力不可用时继续走 DOM，不要绕过授权。跨到子品牌新 origin 时可能再次触发授权。

`blocked_by_browser_url_policy` 是 in-app Browser 的执行面策略失败，不是站点不可访问的证据。不要把它计入站点失败次数，不要据此保存 unavailable profile。若当前任务明确选择了 in-app Browser，报告该限制并请求用户允许切换到 Chrome；默认 Chrome 流程不应触发这类策略判断。

## 初始化

在同一个浏览器会话里复用 Chrome 绑定和专用 tab：

```js
globalThis.SKILL = "<本 skill 目录的绝对路径>";
globalThis.crawl = globalThis.crawl ?? await import(`${SKILL}/lib/crawl.mjs`);
globalThis.engine = globalThis.engine ?? await import(`${SKILL}/lib/engine.mjs`);
globalThis.crawlBrowser = globalThis.crawlBrowser ?? globalThis.chrome;
globalThis.crawlProductsTab = globalThis.crawlProductsTab
  ?? await crawlBrowser.tabs.new();
globalThis.tab = globalThis.crawlProductsTab;
globalThis.profileDir = globalThis.profileDir ?? `${nodeRepl.cwd}/.crawl-products/profiles`;
```

若 `crawlProductsTab` 已关闭、失效或不属于当前 Chrome 会话，丢弃它并从现有 `crawlBrowser` 新建 tab。不要为恢复 tab 再调用 `agent.browsers.get*`。

切换到另一个 origin 前，清空上一站临时的 `profile`、`imageProfile`、`cdpProfile` 和 `sample`；持久化规则由 `profileDir` 按 origin 加载，不能复用上一站内存变量。profile 是运行目录里的本地学习资产，不随 skill Git 仓库自动同步；换电脑复用时复制对应 origin 的 profile 或设置同步的 `profileDir`，否则按未知站点重新学习。

浏览器操作抛错后先判断 tab 是否已污染；需要隔离时必须替换变量：

```js
if (crawl.shouldDiscardBrowserTab(error)) {
  const recovery = await crawl.replaceTaintedTab(crawlBrowser, tab, error);
  globalThis.crawlProductsTab = recovery.tab;
  globalThis.tab = recovery.tab;
}
```

只替换本任务创建或控制的 tab。标签页隔离不等于重选浏览器，也不能把该错误保存成站点不可用。

只有准备开始第二遍重放时才检查 tab 可以提供什么证据；视觉首遍不要调用：

```js
console.log(await crawl.inspectEvidenceCapabilities(tab));
```

如果 Full CDP 被拒绝，告诉用户授权该 origin，并继续用 DOM；不要换来源绕过。如果 Chrome 页面本身出现访问错误，先在同一 Chrome 新 tab 重试一次并截图分类，再用 `crawl.classifyBrowserAccessError(...)` 区分 timeout、connection closed、TLS、challenge 和浏览器执行面错误。只有页面错误或 challenge 才算站点证据；工具策略、扩展断连和 tab 失效都属于浏览器执行面错误，不能保存为站点不可用。TLS 错误不绕过。

## 1. 明确字段、数量和站点作用域

- `fields` 默认 `["title","price","description","images","ingredients","supplement_facts"]`。`facts_images` 由画廊视觉复核产生；需要接口完整产品语义时再加 `form`、`health_function`、`main_ingredients`，三者属于证据驱动的派生字段。
- `maxItems` 默认 200。
- `productScope` 默认 `"nutrition_single_products"`：只保留单个营养/膳食补充产品，排除 Bundle、Pack、Kit、Stack、Set、Collection、Regimen、Duo/Trio、Multi-pack，以及护肤、美妆、家清、器械、配件等非 Nutrition 商品。只有用户明确要求完整商品目录时才传 `"all_products"`。
- 普通品牌站默认 `scopeMode: "same_site"`。
- 只有用户明确要“母公司旗下所有品牌/所有店铺”时，才用 `scopeMode: "verified_brand_sites"`。
- 用户给了明确域名清单时可用 `scopeMode: "explicit_allowlist"` + `allowedOrigins`。
- 品牌官网的商品卡逐项链接到第三方详情页，且用户要抓这些商品时，用 `followVerifiedExternalProductLinks: true`。它只跟随商品卡里已经出现的精确详情 URL，不递归第三方导航或整店目录。

跨域不是自动递归。母公司页面只负责提名候选；候选必须同时通过官网链接证据和店铺/商品目录验证。社交网站、Marketplace、新闻、招聘、隐私和投资者链接都排除；深度默认 1，origin 数量有上限。每个子品牌保存独立 profile，绝不共享 selector 或 CDP 规则。

第三方商品链接与母公司组合不同：只有稳定商品卡容器里的明确购买/详情链接才可启用，品牌集合页、分类页、Marketplace 和外域根路径必须排除。外域 origin 会随 listing profile 保存，复跑时仍只重放已验证的精确商品链接。

产品范围采用两层闸门：候选 URL 阶段只拒绝名称明确的组合装或非营养商品，避免浪费详情页访问；详情记录阶段再综合标题、URL、分类、`productForm`、描述/服用方式和 Supplement/Nutrition Facts 做最终判断。包装词 `packet/packets`（例如 single-serving packets）不是组合装证据，不能仅凭它排除。规则、证据优先级、排除原因和覆盖方式见 [nutrition-product-scope.md](references/nutrition-product-scope.md)。

## 2. 先检查已有 profile

```js
globalThis.loaded = await crawl.loadSiteProfile(profileDir, startUrl, { fields });
console.log(loaded ? {
  valid: loaded.validation.valid,
  reasons: loaded.validation.reasons,
  path: loaded.filePath,
} : { valid: false, reasons: ["not_found"] });
```

如果 profile 有 `discovery.sampleProductUrl`，对一个样本做廉价模板校验：

```js
globalThis.check = loaded?.profile?.discovery?.sampleProductUrl
  ? await crawl.captureLearningPage(tab, loaded.profile.discovery.sampleProductUrl, {
      fields,
      cdpProfile: loaded.profile.cdpProfile,
    })
  : null;
globalThis.replayValidation = loaded
  ? crawl.validateSiteProfile(loaded.profile, {
      startUrl,
      fields,
      templateFingerprint: check?.templateFingerprint,
    })
  : { valid: false, reasons: ["not_found"] };
console.log(replayValidation);
```

判断方式：

- 校验通过：直接进入第 5 步，`crawlSite` 会回放路径和规则。
- 只有 `fields_not_covered`：入口/列表路径仍可复用，但必须对新增字段补做视觉定位和第二遍映射。
- `template_changed`：入口/列表路径仍可复用，但重新视觉确认详情字段并映射字段、图片和 CDP 规则。
- `legacy_profile_quality_revalidation_required`：这是 v3→v4 迁移；复用 discovery、listing、导航 steps 和窄 CDP 规则，只在代表详情页重新视觉确认字段/图片并生成质量证据。
- `version_mismatch`、`origin_mismatch`、`wrong_kind`：整个 profile 不可复用，重新发现。

不要打印 `check.html` 全文，只看缺失字段和紧凑证据摘要。

## 3. 第一遍：纯视觉走完整旅程

没有可复用 profile 时，先导航到入口并截图：

```js
await tab.goto(startUrl);
globalThis.shot = await crawl.captureVisualScreenshot(tab, { timeoutMs: 10_000 });
if (!shot.ok) {
  const recovery = await crawl.replaceTaintedTab(crawlBrowser, tab, shot.error);
  globalThis.crawlProductsTab = recovery.tab;
  globalThis.tab = recovery.tab;
  throw shot.error;
}
await nodeRepl.emitImage(shot.bytes);
globalThis.visualRoute = {
  version: 3,
  status: "incomplete",
  targetRole: "detail",
  requestedFields: fields,
  steps: [],
  fieldJourney: {
    status: "incomplete",
    fields: [],
  },
};
```

根据截图使用 `tab.cua.click({x, y})`、滚动和新的截图连续前进，直到到达：

- 一个代表商品详情页；或
- 一个已经在同页完整展示多个商品的 `inline_catalog`；或
- 明确的 `portfolio` 国家/品牌选择页、停放域名、不可用页面或 challenge。

到达代表详情页后**不要停**。继续截图、滚动并安全点击 tab/accordion/read-more，逐个确认 `fields`。每个字段必须归为：

- `present_visible`：截图上直接可见；
- `present_hidden`：经过视觉确认的滚动、tab 或折叠操作后可见；
- `not_present`：已经视觉检查详情页和相关安全折叠区，确认该模板不提供；
- `uncertain`：还没看清；这种状态不能进入批量。

把当次屏幕位置临时记录到字段旅程，指向**字段内容本身**；隐藏字段同时记录揭示控件。不要把商品标题、价格、成分值等具体值写进路线：

```js
visualRoute.fieldJourney = {
  status: "visual_complete",
  pageUrl: await tab.url(),
  fields: [
    { field: "title", availability: "present_visible", target: { x: 420, y: 180 } },
    { field: "price", availability: "present_visible", target: { x: 430, y: 260 } },
    {
      field: "ingredients",
      availability: "present_hidden",
      revealAction: { action: "click", text: "Ingredients", x: 450, y: 690 },
      target: { x: 480, y: 730 },
    },
    { field: "supplement_facts", availability: "not_present" },
  ],
};
visualRoute.status = "visual_complete";
```

导航既记录 URL 前进，也记录同页菜单展开和分页状态变化。每个动作必须标明 `actionKind`：`navigation_reveal`、`catalog_entry`、`product_entry` 或 `pagination`。目录入口若截图上存在兄弟项，再标 `catalogCoverage: "siblings"`；真正只有一个入口才标 `"single"`。目录动作形状为 `{actionKind:"catalog_entry", catalogCoverage:"siblings", text, targetUrl}`。

首页大类、展开后的子分类族都要各留一个代表动作；不能在 `Best Sellers` 等单页上看到商品就宣告目录完成。同页 `Load More` 用重复 URL 的相邻 `listing` step 和 `actionKind: "pagination"` 记录。跨 origin 时还要记录 `relationType`：`official_store_handoff`、`portfolio_brand_site` 或 `external_product_detail`。这一遍仍禁止 DOM snapshot、locator、`evaluate`、CDP、sitemap、平台枚举或 pageAssets；坐标在第二遍映射后丢弃。

视觉路线至少包含入口、列表、代表商品和全部请求字段。点击只用于导航、滚动、展开或查看详情；不要点击加入购物车、结账、提交表单等有状态动作。

请求 `facts_images` 时，字段视觉路线还包括画廊：扫描全部缩略图，打开疑似表格、背标、Ingredients/Label 及无标签的后续图片，读到图片内部的 Facts 标题才算完成。若站内 Zoom/modal 点不开，不得把它当成字段失败或继续依赖屏幕位置；把 checkpoint 标为 `sourceKind: "gallery_image"`，视觉定位缩略图/主画廊后进入第二遍，映射画廊 selector 并从 DOM、CDP、Document 和 `pageAssets` 取得直接图片 URL，再直接加载该资源截图复核。不能因为 Zoom 失效或 DOM `alt` 没写 Facts 就判定不存在。

截图调用超时、`Page.captureScreenshot` 失败或成功截图大面积异常空白，都属于浏览器执行面问题，不是站点访问失败。超时立即隔离 tab；异常空白只允许在页面 URL/title 已稳定且没有超时的情况下短等后重截一次。第二次仍空白就记为 `screenshot_render_blank`。若此前尚未用视觉证明目录/详情路径，停止并汇报；若视觉已经走到明确的 listing、detail 或 `inline_catalog`，第二遍可继续用 DOM/CDP 映射已经证明的路线，但不能倒退成 DOM 自动探索。

## 4. 第二遍：回到入口，带观测正向重放

不要使用浏览器 Back 采集网络：BFCache 可能不重新发请求。把第一遍路线交给重放器，它会从入口开始，先把视觉动作映射到稳定 DOM selector，再在点击前启用 Network：

```js
globalThis.replay = await crawl.replayVisualRoute(tab, visualRoute, {
  networkEventTimeoutMs: 5_000,
  replayBudgetMs: 90_000,
  operationTimeoutMs: 15_000,
  navigationOperationTimeoutMs: 15_000,
  fieldOperationTimeoutMs: 8_000,
  imageOperationTimeoutMs: 10_000,
  pageAssetsTimeoutMs: 2_500,
});
globalThis.visualRoute = replay.visualRoute;
globalThis.listingProfile = replay.listingProfile;
globalThis.profile = replay.detailProfile;
globalThis.imageProfile = replay.imageProfile;
console.log({
  checkpoints: replay.checkpoints,
  fieldCheckpoints: replay.fieldCheckpoints,
  networkCandidates: replay.networkCandidates,
  listingProfile,
  mappedFields: replay.visualRoute.fieldJourney.fields.map((item) => ({
    field: item.field,
    availability: item.availability,
    mapped: item.availability === "not_present" || Boolean(item.targetSelector),
  })),
});
```

`replayBudgetMs` 是整条路线总预算；其余 `*OperationTimeoutMs` 是单次 RPC/导航/映射的硬上限。任一单操作超时会抛出带 `discardTab: true` 的浏览器执行错误。捕获后用 `replaceTaintedTab` 换新 tab，再决定是否从入口完整重放一次；禁止在旧 tab 上继续下一字段或下一站。

`replayVisualRoute` 会：

1. 用动作文字和已知目标 URL 找回对应元素；
2. 分开映射目录族、分页和商品卡：`listing→listing` 的分类动作不会再被当成商品卡；兄弟目录 URL 写入 `catalogCoverage.listingSeeds`，Load More 写入 `paginationActions`；
3. 重放详情页滚动、tab 和 accordion，把 DOM 字段内容映射成 `targetSelector`；图片型 Facts 保存 `sourceKind: "gallery_image"` 并映射商品画廊，不要求 Zoom/modal 可用；同时保存 tag、唯一命中数、文本/图片/视频计数和语义信号；
4. 由完整字段旅程生成 `detailProfile.fieldRules`、`fieldPolicy`、`interactionHints` 和图片 gallery hint；
5. 在真实导航和关键揭示动作前开启 CDP Network，捕获导航、XHR 和 Fetch；字段映射阶段不反复读取图片资源；
6. 为每个页面角色保存结构指纹；
7. 全部字段映射完成后只在最终详情页读取一次 gallery/pageAssets 高清图证据；图片型 Facts 直接加载候选 CDN/原图 URL 做截图复核，网页放大控件只是可选辅助；
8. 丢弃截图坐标，只保存无字段值规则；网络响应体也不写进视觉路线。

任何请求字段仍是 `uncertain`、缺稳定映射、缺有效 `quality`，图片 selector 不含真实图片，标量字段错误共用同一 selector，或 DOM 隐藏字段缺揭示 selector 时，`replayVisualRoute` 必须失败。唯一例外是 `sourceKind: "gallery_image"`：它必须映射到含真实图片的商品画廊，但不要求 Facts 文本 selector 或可用的 Zoom 揭示控件；后续图片内容视觉复核仍是硬门槛。完整规则见 [replay-quality-gates.md](references/replay-quality-gates.md)。

若 visual route 是单页目录，第二遍到达 `inline_catalog` 后再检查重复商品容器；不要为了制造详情 URL 去点击“加入购物车”。若是国家/品牌选择页，先汇报 `portfolio`，只有用户明确要求跨站时才继续选择子站。

从第二遍已经确认的列表页收集少量商品：

```js
globalThis.listingSeeds = replay.visualRoute.catalogCoverage?.listingSeeds
  ?? visualRoute.steps.filter((step) => ["listing", "inline_catalog"].includes(step.pageRole)).map((step) => step.url);
globalThis.listing = await crawl.collectProductUrls(tab, listingSeeds, {
  maxItems,
  ...(listingProfile || {}),
});
globalThis.productUrls = listing.productUrls;
globalThis.inlineRecords = listing.inlineRecords;
```

然后用渲染 DOM 学一个代表商品；未提供 `useCdp: true` 或已验证 `cdpProfile` 时，`captureLearningPage` 不会启动 CDP：

```js
globalThis.sample = productUrls[0]
  ? await crawl.captureLearningPage(tab, productUrls[0], {
      fields,
      profile,
      imageProfile,
    })
  : null;
console.log(sample && {
  baselineFields: sample.baselineFields,
  missingFields: sample.missingFields,
  templateFingerprint: sample.templateFingerprint,
});
```

这里的 `captureLearningPage` 只是验证已映射字段路线，不负责猜字段。只在 `replay.networkCandidates` 已经出现与当前商品明确相关的窄接口时创建 `cdpProfile`，再显式复采：

```js
globalThis.cdpProfile = {
  responseRules: [{
    name: "product-detail-api",
    urlIncludes: "/api/product/",
    resourceTypes: ["XHR", "Fetch"],
  }],
};
globalThis.apiSample = await crawl.captureLearningPage(tab, productUrls[0], {
  fields,
  profile,
  imageProfile,
  useCdp: true,
  cdpProfile,
});
```

CDP 规则最多 12 条；不能保存 `"/api/"`、域名根路径等宽规则，也不能保存响应体、请求头或字段值。详情规则仍用 `engine.normalizeDetailExtractionProfile(...)` 归一化。

强制质量门：

- 通用价格兜底必须带货币符号/代码；只有明确的价格节点或已学 selector 才能接受 `44,80` 这类无货币文本。
- `0`、负数和空值都视为缺失，必须进入浏览器升级；标题里的 `908g` 等规格不能作为价格。
- `ingredients` 与 `supplement_facts` 分开。只有营养/补充剂事实表或明确标签才写入 `supplement_facts`。
- `Access denied`、`There was a problem loading this website`、404/5xx 等错误文档直接拒收，不能保存成商品。

图片默认同时合并：

- 渲染画廊里所有图片；
- Document 响应中的 `thumb/img/full/zoom/original` 映射；
- `pageAssets` 实际观察到且能与当前画廊绑定的图片；
- Magento、WooCommerce、Shopify、BigCommerce、Cloudinary、ImageKit 等 CDN 的原图候选。
- `thumb.php` / `image.php` 等带 `img` 或 `image` 参数的图片代理，以及 `foto-grande` / `foto-*-piccola` 等本地化画廊结构。
- Next.js `/_next/image?url=...` 代理保留为页面证据；只有底层原图通过真实浏览器 MIME 和像素验证后才替换。

高分辨率候选必须先与**当前渲染画廊/选中变体**绑定，避免把其他规格或推荐商品混入。候选原图还要在真实浏览器验证 MIME 和像素尺寸，失败就保留页面原值。

图片结果还必须：

- 按原始资源身份去重，HTTP/HTTPS、缩略图/原图变体只保留更优的一张；
- 图片代理按其 `img`/`image` 指向的底层资源去重，并优先保留画廊父链接里的大尺寸版本；
- 排除购物车/电话/社交图标、认证徽章、跟踪像素和 logo；营养表/成分表从营销图集合分流到 Facts 候选，不能静默丢弃；
- Shopify 等 CDN 的尺寸后缀只能在真实浏览器验证原图后替换，不能靠字符串猜测直接改写结果。

规则完整格式见 [profile-schema.md](references/profile-schema.md)，站点/CDP/profile 见 [browser-evidence-and-site-profiles.md](references/browser-evidence-and-site-profiles.md)，站点终态和跨域关系见 [site-outcomes-and-handoffs.md](references/site-outcomes-and-handoffs.md)。

### Facts 图片视觉复核与语义派生

请求 `facts_images`、`form`、`health_function` 或 `main_ingredients` 时，必须读取 [semantic-enrichment.md](references/semantic-enrichment.md)，并加载校验器：

```js
globalThis.productSemantics = globalThis.productSemantics
  ?? await import(`${SKILL}/lib/product-semantics.mjs`);
```

Facts 图片采用“元数据筛选 → 视觉确认”：

1. 对真实商品画廊的每张图调用 `classifyFactsImageCandidate()`。
2. 明确 Facts 标签可直接分类；`Ingredients`、`Label`、背标、空标签的后续图片必须截图复核。站内放大不可用时直接加载画廊/CDN 原图，不得停止商品路线。
3. 从直接图片资源内部读到 `Supplement Facts`、`Nutrition Facts`、`Drug Facts` 或 `Product Facts` 后，调用 `finalizeFactsImageReview()`；没读到就传 `isFactsImage:false`。
4. `alt` 只是候选信号，不是图片内容真值。`Ingredients` 既可能是普通配料图，也可能实际包含 Supplement Facts。
5. 请求 `main_ingredients` 时继续在放大图上逐行读取主要/活性成分及剂量，再调用 `finalizeFactsIngredientReview()`；只确认 Facts 标题不算完成成分字段。

`main_ingredients` 必须图片优先：有 Facts/Ingredients 图时禁止用固定词表、正文正则或 `alt` 代替看图；没有可读图片才视觉展开页面 Ingredients/Key Ingredients 区域，标题/描述只作最后兜底。用 `normalizeProductSemanticEnrichment()` 校验、`mergeProductSemanticEnrichment()` 合并；低置信度不输出。视觉成分复核见 [semantic-enrichment.md](references/semantic-enrichment.md)，taxonomy 与接口映射见 [enrich-product-output.md](references/enrich-product-output.md)。

如果用户要求“全部画廊图片”，Facts 图片同时保留在 `images` 和 `facts_images`；如果用户只要营销图，则从 `images` 排除、但仍必须保留在 `facts_images`。

商品输出会在 `_meta.fieldSources` 为每个字段保存实际 `sourceUrl`、`sourceOrigin`、提取层和已验证的跨域 `relationType`。同一商品出现不同价格/币种时保留首个字段值，并把各来源观测写入 `_meta.fieldConflicts`；不能用经销商价格静默覆盖品牌目录价格，也不能反过来覆盖。该来源信息属于本次商品结果，不进入 value-free profile。

## 5. 单站批量抽取并保存 profile

首轮把学习结果和模板指纹传入；复跑时只给 `profileDir` 即可自动加载：

```js
globalThis.result = await crawl.crawlSite(crawlBrowser, tab, startUrl, {
  fields,
  maxItems,
  productScope: "nutrition_single_products",
  profileDir,
  visualRoute: globalThis.visualRoute,
  listingProfile: globalThis.listingProfile ?? undefined,
  profile: globalThis.profile ?? undefined,
  imageProfile: globalThis.imageProfile ?? undefined,
  cdpProfile: globalThis.cdpProfile ?? undefined,
  templateFingerprint: globalThis.sample?.templateFingerprint
    ?? globalThis.check?.templateFingerprint,
});
console.log(crawl.summarize(result));
```

`crawlSite` 会：

1. 验证 v4 `visualRoute.status === "mapped"`，并确认每个请求字段都有完整 checkpoint 和有效语义质量证据；
2. 先使用已映射 `catalogCoverage` 的全部目录 seed，再回放分页/Load More 和商品卡 selector 收集产品；旧 profile 才用首页分类 selector 兼容扩展；
3. 在候选 URL 阶段排除明显组合装和显式非营养商品；
4. 后台批量抽取，并只按已学字段展开规则做慢速补采；
5. 首轮未学 CDP 规则时只用 DOM 升级；复跑或显式启用后才执行已验证 CDP 规则；
6. 合并 CDP、DOM、画廊和原图证据，再做详情记录范围判断；
7. 原子写入 value-free site profile。

不要在未知站点上一上来调用 `crawlSite` 代替视觉首遍。执行层没有自动发现兜底：只有已有有效 v4 profile，或已经完成 `replayVisualRoute`，才能进入批量阶段。v3 只能作为局部迁移输入，不能直接批量。`forceDiscovery` 已移除；不要再传。

fast path 只要已有 URL+标题或有效商品图，就保留 partial record 并同时进入慢速补采，不能因缺少某个请求字段把整条商品删除。慢速补采的连续失败只熔断相同缺失字段/图片签名；没有 fast baseline 的 URL 必须逐个尝试，其他模板继续运行。`minImagesBeforeGalleryUpgrade` 可调整图片升级门槛，`resolveOriginalImages: false` 可关闭原图恢复。

只打印 `crawl.summarize(result)`，绝对不要打印 `result.records`。

## 6. 母公司/子品牌组合站

若用户给出的入口经截图确认是母公司、集团或品牌组合页，而商品实际位于其直属 Brand，则把这些直属 Brand 的商品纳入本次结果。组织层级固定为 `母公司(depth 0) → 直属 Brand(depth 1)`；不需要再让用户重复批准这个一层接力。

```js
globalThis.result = await crawl.crawlPortfolio(crawlBrowser, tab, startUrl, {
  fields,
  maxItems,
  maxItemsPerSite: 200,
  profileDir,
  scopeMode: "verified_brand_sites",
  maxOrigins: 12,
  maxDepth: 1,
});
console.log(crawl.summarize(result));
```

首轮必须用截图视觉确认“母公司 → 直属官方 Brand”关系，并把 `parentOrigin`、`depth: 1`、Brand 的 `origin/url` 和证据作为 `verifiedSites` 交给 `crawlPortfolio`；每个 Brand 还必须有自己的 mapped visual route（首轮按 Brand 或商城入口放进 `sitePlans`，复跑从独立 profile 加载）。以后直接从 parent portfolio profile 回放。

`maxDepth` 在执行层固定为 `1`。Brand 跳到自己的官方商城可用 `official_store_handoff`，商品卡跳到精确外部详情可用 `external_product_detail`；二者都不是新的组织层级。Brand 路线再次出现 `portfolio` 页面角色或 `portfolio_brand_site` 时立即报 `portfolio_depth_exceeded`，不进入孙级品牌、经销商集合或下一层组合站。

执行层不使用 DOM 自动扫描母公司链接、平台枚举或递归发现。首轮用截图识别直属 Brand 并逐个验证商品目录；`forcePortfolioDiscovery` 已移除。品牌关系变化时重新视觉确认并更新 `verifiedSites`。

若用户只给一个普通商品站，不要因为页脚出现兄弟品牌就扩大范围；可以汇报发现了候选，但不导航外域。

## 7. 可选：打包当前商品资源

仅在用户需要下载图片文件、审计资源或确认页面实际加载版本时：

```js
globalThis.evidence = await crawl.captureBrowserEvidence(tab, productUrl, { cdpProfile });
globalThis.bundle = await crawl.bundleObservedProductAssets(tab, evidence, { maxAssets: 80 });
console.log(bundle.summary ?? bundle);
```

`pageAssets` 打包的是页面实际观察到的资源，不等于可以忽略商品画廊绑定和原图验证。

## 8. 落盘和质量判断

```js
globalThis.productOutput = globalThis.productOutput
  ?? await import(`${SKILL}/lib/enrich-product-output.mjs`);
globalThis.exported = await productOutput.writeEnrichProductExport(
  outDir,
  result.records,
  {
    processedAt: new Date().toISOString(),
    updateExisting: false,
    // 数据库公司域名与商品来源不一致时显式传 domain 或 domainByOrigin。
  },
);
console.log(exported.summary);
```

`products.json` 是接口内层 input 数组，`product-enrich-requests.jsonl` 每行是可直接 POST 的 `{"json": input}`；`mainIngredients` 可混合名称字符串与 `{name, substance, form?, category?}`，并显式输出 `updateExisting`。默认只能导出 `crawlSite` 返回的 `result.records`，不要把 `result.exclusions` 或候选 URL 手工重新拼回导出数据。有确认过的 Facts 图却没有 `visual_complete` 成分复核时，导出器必须报错，不能静默输出空成分。原始 records 和证据另存为 `crawl-records.json`。除非用户明确要求提交，否则只生成文件，不调用接口。详细契约见 [enrich-product-output.md](references/enrich-product-output.md)。

汇报 `recordsReceived`、`inputsReady`、接口导出错误数、字段覆盖率、爬取失败数、店铺数、profile 是否回放/保存和耗时；还必须汇报 `productScopePolicy`、`productsExcludedByScope` 和 `scopeExclusionReasons`。排除记录是审计信息，不是失败。导出错误不能静默丢弃；必须查看 `product-enrich-errors.json`。

| 症状 | 处理 |
|---|---|
| `recordsExtracted` 为 0 | 检查入口或站点是否被拦；不要换站硬凑 |
| `productsExcludedByScope` 很高 | 查看 `scopeExclusionReasons` 和 `result.exclusions` 样本；确认不是把 single-serving packets 当成组合装 |
| 字段覆盖率低 | 选一个低覆盖商品局部重学，不重探入口 |
| 图片只有 1 张 | 确认画廊升级和 CDP 未关闭；检查 `imageEvidence` |
| 价格是 `0` 或等于标题规格 | 视为缺失，检查紧凑 DOM 字段投影，再学习稳定价格 selector |
| 图片包含购物车/徽章/跟踪图 | 不接受该样本；补 gallery 容器或 exclude 规则后重验 |
| 标题是网站错误信息 | 拒收记录并记失败；不要保存空壳商品 |
| `originalImages.groupsRejected > 0` | 候选不存在、过小或 CDN 拒绝；正常回退 |
| `profile.validation.reasons` 有 `template_changed` | 保留 discovery，只重学详情/图片/CDP |
| `legacy_profile_quality_revalidation_required` | 复用 v3 导航/列表；重映代表详情页字段和图片质量 |
| `blocked_by_browser_url_policy` / 扩展断连 | 浏览器执行错误，不记为站点失败，不保存 observation |
| `browser_operation_timeout` / replay budget exceeded | 立即隔离旧 tab，用同一 Chrome 新建 tab；最多从入口完整重放一次 |
| `Page.captureScreenshot` 超时 / 截图空白 | 浏览器执行错误；按截图规则重试或停止，不保存站点 unavailable observation |
| `ERR_TIMED_OUT` / `ERR_CONNECTION_CLOSED` / TLS | 新 tab 重试一次并分类；短期 observation 可过期，不能替代 profile |
| 跨 origin 价格不同 | 保留字段来源和 `_meta.fieldConflicts`，不要静默覆盖或合并成一个“权威价” |
| `upgrade_disabled` | 只跳过相同缺失签名的补采；partial baseline 仍保留，其他签名继续 |
| 组合站抓错外域 | 降回 `same_site`，或使用 `explicit_allowlist` |

## 边界

- 只抓公开商品目录；不抓需登录、付费墙后或 robots 明确禁止的内容。
- CAPTCHA / Cloudflare challenge 出现就停并告诉用户，不反复撞。
- 抓取只在用户给定站点及明确批准的品牌组合范围内进行。
- 不读取浏览器 Cookie、localStorage、密码或个人会话数据。
- 不把截图/OCR、平台批量接口或 sitemap 作为未经页面验证的字段真值。
- 大站分批；不要自行提高并发压站点。
- 任务结束时按当前 Chrome 文档 finalize 本任务创建的 tab；默认不保留研究 tab。finalize 必须是最后一个浏览器动作。

## 与 browserbase-worker 的关系

`lib/engine.mjs` 从 `apps/browserbase-worker/src/skill-engine.ts` 构建。worker 确定性规则变更后要重新构建，否则两边会漂移。

- 本 skill：本地真实浏览器身份、首轮交互学习、几十到几百商品、可见授权。
- worker：队列调度、代理/stealth、批量生产和无人值守长跑。
