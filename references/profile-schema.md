# detail-extraction profile 规范

这里的 detail profile 描述**怎么从这个模板的 HTML/已验证产品响应里取字段**，不描述某个具体商品的值。基础字段 selector、字段可得性和展开动作由完整视觉旅程的第二遍映射生成；模型只在限量验证失败时修正规则，不能跳过视觉字段定位自行猜测。字段 selector 的 v4 语义证明见 `replay-quality-gates.md`；外层 site profile、CDP 规则和 portfolio 关系见 `browser-evidence-and-site-profiles.md`。

detail profile 只能在截图首遍已经走到代表商品、视觉确认每个请求字段，并完成第二遍 DOM/Network 映射后学习。不要在未知站点首页直接用 CDP 猜详情规则；完整的“入口→列表→商品→字段→揭示动作”保存在外层 `visualRoute`，这里保存由它生成的执行规则。

若代表详情存在口味、规格或颜色选择器，外层 `visualRoute` 还应保存不含具体商品值的 `variantProfile`，使复跑可以重新枚举当前可售状态而不是只读取默认变体：

```json
{
  "variantProfile": {
    "optionGroupSelectors": ["[data-option-group='flavor']", "select[name='size']"],
    "optionSelectors": ["[data-variant-id]", "select[name='size'] option"],
    "selectedStateSelectors": ["[data-selected-variant]", "[data-sku]"],
    "settleMs": 800,
    "maxStates": 48
  }
}
```

只保存 selector、等待和上限等方法；不要保存本次运行的 Chocolate、30 capsules 等具体商品值。每次运行根据截图和当前 DOM/Network 重新生成 `_meta.variant`，并单独复核该状态的图片和 Facts。

`engine.normalizeDetailExtractionProfile(obj)` 会做归一化并丢弃非法内容，所以永远先过一遍它再用。裁剪规则：每字段最多 8 条规则、正则最长 800 字符、`factLabels`/`tableKeywords` 最多 20 项、`interactionHints` 最多 12 条。被丢掉的内容不会报错，只是静默消失 —— 归一化后打印一下 `Object.keys(profile.fieldRules ?? {})` 确认规则还在。

## 结构

```jsonc
{
  "version": 1,
  "kind": "detail-extraction",
  "name": "acme-supplement-detail",          // 可选，便于排查
  "fieldRules": {                            // 首选：结构化规则
    "<field>": [ { "mode": "...", ... } ]
  },
  "fieldRegexes": {                          // 兼容写法，等价于 mode:"regex_text"
    "<field>": ["<正则>"]
  },
  "imageRegexes": ["<正则>"],                // 补充商品图来源
  "factLabels": ["Ingredients", "成分"],      // 折叠区/标签块的标签名
  "tableKeywords": ["Supplement Facts"],     // 需要整表抓取的表格关键词
  "fieldPolicy": { "<field>": { ... } },     // 字段可得性策略
  "interactionHints": [ { ... } ]            // 抽取前需要的展开动作
}
```

## 三种规则模式

按稳定性从高到低选，优先前面的。

### `label_following_text` —— 最稳，首选

取标签后面紧跟的文本。适合"成分 / Ingredients / Suggested Use"这类**标签 + 内容**结构，因为它不依赖 class 名，改版后仍然成立。

```json
{ "mode": "label_following_text", "labelAliases": ["Ingredients", "Active ingredients", "成分"] }
```

多写几个同义词和语言变体，命中一个即可。

### `selector_text` —— 次选

按 CSS selector 取文本。适合有稳定语义 class 的站点。

```json
{ "mode": "selector_text", "selectors": [".product-price .money", "[data-price]"] }
```

不要用 `div > div:nth-child(3)` 这种位置选择器，翻页或 A/B 分流就会失效。

价格 selector 必须指向当前商品的价格节点，不能指向整个商品头部或包含规格的父容器。价格值为 `0` 时会被执行层视为缺失；无货币的正数只在明确价格节点/已学规则中接受，通用全文兜底不会把 `908g` 之类规格当价格。

### `regex_text` —— 兜底

对 HTML 原文跑正则，**必须恰好一个捕获组**，取的是组内容。

```json
{ "mode": "regex_text", "patterns": ["<h1[^>]*class=\"product-title\"[^>]*>([\\s\\S]*?)</h1>"] }
```

注意 JSON 里反斜杠要双写：`[\\s\\S]`、`\\d`、`\\b`。

## fieldPolicy：字段可得性

告诉执行层"这个字段该不该期待它出现"。**没写策略的请求字段默认是必需的**，缺了就会触发单商品浏览器升级（慢）。所以确认某字段该站根本没有时，一定要显式标 `allow_missing`，否则会为一个不存在的字段把全站商品都重开一遍。

```json
{
  "supplement_facts": {
    "availability": "present_hidden",
    "missingBehavior": "require_fallback",
    "interactionHints": [{ "labelPattern": "Supplement Facts", "action": "click" }]
  },
  "brand": { "availability": "not_present", "missingBehavior": "allow_missing",
             "reason": "单品牌站，详情页不标品牌" }
}
```

| `availability` | 含义 |
|---|---|
| `present_visible` | 页面直接可见，初始 HTML 里就有 |
| `present_hidden` | 存在但藏在 tab / accordion / read-more 后面，需要交互 |
| `not_present` | 该模板确实没有这个字段 |
| `uncertain` | 没看清（截图没覆盖到等）—— 保守默认值 |

| `missingBehavior` | 含义 |
|---|---|
| `require_fallback` | 缺了就走浏览器升级重试 |
| `allow_missing` | 缺了直接接受，记入 `missingFields` |

fast path 缺 `require_fallback` 字段时，只要仍有 URL+标题或有效商品图，就保留 partial record 并进入浏览器升级；升级失败不能删除这条基本商品记录。连续失败熔断按相同缺失字段/图片签名隔离，不能用一个模板的失败截断其他商品族。

## interactionHints：抽取前的展开动作

只有视觉字段旅程已经确认、第二遍已经映射的控件才能列在这里。执行层不会自己去搜索或点击页面上的其他控件（商品页上乱点可能加购物车）。

```json
{ "field": "supplement_facts", "action": "click",
  "labelPattern": "Supplement Facts", "selectorHint": "[data-accordion='facts']" }
```

- `selectorHint` 优先于 `labelPattern`；两者都要**唯一命中**，`count() !== 1` 会被跳过
- `action`：`click`（默认）/ `open_details`（`<details>` 元素）/ `scroll`
- 每页最多尝试 8 个

## 字段别名

请求 `title` 时，这些 key 任一有值就算命中（`DETAIL_FIELD_ALIASES`）：

| 请求字段 | 接受的 key |
|---|---|
| `title` | title, name, productName, productTitle, product_name |
| `url` | url, productUrl, href, permalink, link |
| `price` | price, currentPrice, salePrice, regularPrice, amount |
| `description` | description, desc, details, productDescription, summary, shortDescription, longDescription |
| `images` | images, image, photos, photoUrls, gallery, media |
| `brand` | brand, manufacturer, brandName, vendor |
| `sku` | sku, productCode, itemCode, modelNumber, id |
| `availability` | availability, inStock, stockStatus, stock |
| `category` | category, categories, productType, type, tags |
| `supplement_facts` | supplement_facts, supplementFacts, nutrition_facts, nutritionFacts, nutritionalInformation, nutritional_information |
| `ingredients` | ingredients, ingredient_list, ingredientList |
| `serving_size` | serving_size, servingSize |
| `recommended_daily_intake` | recommended_daily_intake, directions, suggested_use, usage |

所以规则的 key 用哪个别名都行，不必强行统一。

## 图片

`images` 不走 `fieldRules`，由 `engine` 的图片管线处理：候选收集 → 打分排序 → 去重 → 过滤。已经内置的处理包括 srcset 取最大图、WordPress `-300x300` 缩略图后缀剥离、`thumb.php?img=...` 与 Next.js `/_next/image?url=...` 等图片代理、本地化 `foto-*` 画廊、装饰图/图标过滤。HTTP/HTTPS、图片代理尺寸变体和已知缩略图/原图变体会按同一资源身份去重，并优先保留 HTTPS、画廊大图或已验证的原图。Next.js 代理的底层原图也必须先通过真实浏览器 MIME 与尺寸验证，不能只解码查询参数就直接替换。

若 `supplement_facts` 来自画廊图片而非页面文本/Table，`visualRoute.fieldJourney` 的 checkpoint 必须保存 `sourceKind: "gallery_image"`，并把 `targetSelector` 指向含真实图片的稳定商品画廊。执行层不会为它生成 `selector_text`，也不会要求 Zoom/modal 揭示规则；它会把该 selector 加入 `ImageExtractionProfile.galleryContainerHints`，从画廊、Document/CDP 和 `pageAssets` 收集直接图片 URL。图片内容是否属于 Facts 仍由视觉复核决定，不能用这个来源标记直接断言。

只有默认管线抓不到时才补 `imageRegexes`。另可给 `ImageExtractionProfile`（`crawl` 各函数的 `imageProfile` 参数）指定 gallery 容器和排除模式：

```json
{
  "version": 1,
  "galleryContainerHints": [".product-gallery", "[data-gallery]"],
  "excludePatterns": { "url": ["/icons/", "placeholder"], "alt": ["logo"] }
}
```

成分表图片（`supplement_facts_image` / `ingredients_image`）默认从营销图 `images` 分流，但不能丢弃。请求 `facts_images` 时必须按 [semantic-enrichment.md](semantic-enrichment.md) 对画廊候选做视觉内容复核；用户要求“全部画廊图片”时，同一资源可以同时出现在 `images` 和 `facts_images`。
购物车/电话/社交图标、认证徽章、跟踪像素和本地化命名的营养表图片也会在通用层排除；站点仍有特殊命名时再用 `excludePatterns`。
