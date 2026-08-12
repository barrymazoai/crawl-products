# Supply Smart 商品补全接口输出

最终落盘必须通过 `lib/enrich-product-output.mjs`，不要直接把爬虫内部 record 当成接口参数。

## 目录

- 接口契约
- 成分 taxonomy
- 语义字段
- 落盘文件

## 接口契约

- 方法：`POST {BASE_URL}/rpc/product/enrich`
- `Content-Type: application/json`
- HTTP body 外层必须是 `{"json": input}`。
- skill 只生成请求文件；除非用户明确要求提交，否则不得调用接口。

`input` 字段：

| 字段 | 必需 | 来源 |
|---|---:|---|
| `domain` | 是 | 明确覆盖值，或商品来源的公司可注册域名；如 `us.shaklee.com` → `shaklee.com` |
| `productName` | 是 | 母商品名 `fields.title`；每个变体行共用同一母商品名，不拼变体后缀 |
| `productUrl` | 是（Skill 严格模式） | **变体自己的**详情 URL（带 `?variant=`）；一变体一行 |
| `productGroupId` | 是 | 母商品关联键 = 去掉 `?variant=` 的母商品基础 URL；同一母商品的所有变体行共享它，下游 `GROUP BY productGroupId` 聚合回母商品 |
| `sku` | 否 | 变体自己的 SKU（`variant.sku` → `fields.sku`）；一变体一 SKU |
| `variantId` | 否 | 变体 ID（有变体时带上） |
| `variantOptions` | 否 | 变体的选项组合对象，如 `{ "Saveur": "Neutre", "Quantité": "1 BOITE" }` |
| `images` | 否 | 变体有专属图（`variant.imageUrl`）时它排首位，其余继承母商品画廊；无专属图则全部继承母商品 |
| `healthFunctions` | 否 | **对齐受控词表**：模型产出的短语经 `health-function-vocab` 匹配到 658 词表，输出 `[{id, name}]`；没对上词表的进 review，不硬塞 |
| `mainIngredients` | 否 | 有证据的 `fields.main_ingredients`；Skill 严格模式要求每项都是完整 taxonomy 对象 |
| `productForm` | 否 | 有证据的 `fields.form` |
| `updateExisting` | 否 | 默认且显式输出 `false`；补已有产品关系/图片时设为 `true` |
| `processedAt` | 否 | 本次导出时间，ISO 字符串 |
| `error` | 否 | 上游显式错误信息 |
| `price` | 是（Skill 严格模式） | `fields.price` → `retail_price` → 默认可售变体价；原始字符串（含币种/格式）原样保留，接口侧归一。缺失进 error/review 队列。可传 `requirePrice:false` 放宽 |
| `supplementFactsOCR` | 否 | 接口目前接收但不落库，默认不导出（需 `includeNonPersistedFields:true`） |

`domain` 默认压缩为公司可注册域名。接口按数据库公司域名匹配；若数据库确实保存 `shop.example.com` 等特殊值，用显式 `domain` 或 `domainByOrigin` 覆盖。`domain` 不能代替 `productUrl`，后者始终保留完整详情地址。

变体不是 Skill 的丢弃项：原始 record 的 `_meta.variant` 保存 `variantId`、SKU、选项组合、默认状态和状态来源，`productUrl` 保留实际变体状态 URL，图片/Facts 仍按变体独立复核。下游 enrich 接口负责变体关联和落库；Skill 不擅自改写基础 `productName` 或拼接名称来模拟接口字段。

## 成分 taxonomy

接口 Schema 为兼容旧调用方仍支持字符串，但 Skill 的 API-ready 严格模式不允许字符串。每项必须包含 `name`、`substance`、`category`；存在具体化学/制备形态时再提供 `form`：

```jsonc
[
  {
    "name": "Resveratrol",
    "substance": "Resveratrol",
    "category": "antioxidants_polyphenols"
  },
  {
    "name": "Muscadine Grape Extract",
    "substance": "Grape",
    "category": "herbs_botanicals"
  },
  {
    "name": "Ascorbic Acid",
    "substance": "Vitamin C",
    "form": "Ascorbic Acid",
    "category": "vitamins"
  }
]
```

- `name`：图片或页面证据里的成分名称。
- `substance`：数据库物质层，严格模式必填；只有提供它，新成分才能进入分类树。
- `form`：形态层，提供时必须同时有 `substance`。
- `category`：固定分类 slug，严格模式必填。

允许的分类：`vitamins`、`minerals`、`amino_acids_peptides`、`herbs_botanicals`、`mushrooms`、`fatty_acids_lipids`、`probiotics_prebiotics`、`enzymes`、`antioxidants_polyphenols`、`hormones_precursors`、`fibers_carbs`、`proprietary_blends_other`。

taxonomy 必须来自成分原文和可靠归类知识。无法可靠判断 `substance/category` 时，把该产品留在 review/error 队列；不能退化成字符串进入最终数据，也禁止为了提高覆盖率猜测。`form` 只有在证据能区分具体化学形态、盐型、提取物或制备形态时才填写。

## 语义字段

`healthFunctions`、`mainIngredients`、`productForm` 是数据库词表。只输出 high/medium confidence 且有 evidence 的值：

- `mainIngredients` 必须来自图片优先的视觉复核；有 Facts/Ingredients 图时不能用固定词表或正文正则绕过看图。
- 不得把整段 `ingredients` 原文作为一个词条，也不得按逗号盲拆。
- `healthFunctions` 必须结合标题、分类、描述、benefit copy、Directions 和成分证据推断宽泛支持类别；不能因为页面没有名为 health function 的字段就留空。不得产生治疗、治愈、诊断或预防疾病声称。
- 全小写词条会在接口导出时转成 Title Case；已有混合大小写或缩写保持原样。
- 推断证据继续保存在原始 record 的 `_meta.semanticInferences`，接口输入只放最终值。
- 单独的 `Ingredients`/`Supplement Facts`/`Facts` section 标题不是内容；抽取值只有标题时必须回到页面展开或逐张读取图片。

调用语义校验器：

```js
const enrichment = productSemantics.normalizeProductSemanticEnrichment({
  form: {
    value: "powder",
    basis: "explicit",
    confidence: "high",
    evidence: [{ source: "title", excerpt: "Daily Powder" }],
  },
  healthFunction: [{
    value: "immune support",
    basis: "inferred",
    confidence: "medium",
    rationale: "页面用途和配方共同支持该归类。",
    evidence: [{ source: "description", excerpt: "supports immune health" }],
  }],
  mainIngredients: [{
    value: "Ascorbic Acid",
    basis: "explicit",
    confidence: "high",
    substance: "Vitamin C",
    form: "Ascorbic Acid",
    category: "vitamins",
    evidence: [{ source: "supplement_facts_image", excerpt: "Vitamin C (Ascorbic Acid) 500 mg" }],
  }],
});
record = productSemantics.mergeProductSemanticEnrichment(record, enrichment);
```

## 落盘文件

```js
const exported = await productOutput.writeEnrichProductExport(
  outDir,
  result.records,
  {
    processedAt: new Date().toISOString(),
    updateExisting: false,
    runCompletion: result.completion,
    // domain: "example.com",
    // domainByOrigin: { "shop.example.com": "example.com" },
  },
);
```

默认是严格导出：缺真实 `productUrl`、至少一张图片、`galleryReview.status:"visual_complete"`、DOM+画廊 Facts source review、`productForm`、`healthFunctions`、`mainIngredients`、对应语义证据，或存在缺 `substance/category` 的主成分时，记录进入错误文件。有多张 Facts 图时必须逐张完成成分复核。

正式产物采用批次级全有或全无。只有 `runCompletion.status === "complete"` 且所有输入记录均通过时才生成 `products.json`、`product-enrich-requests.*` 和 CSV。多网站任务必须传入 `crawlTargets()` 返回的整批 completion；单站 `complete` 或已保存 checkpoint 不能替代整批 completion。若整次目录/详情任务未结案、遗漏 `runCompletion` 或任一记录失败，只生成 `api-ready-candidates.json`、`crawl-records.json`、错误文件和 `enrich-export-report.json`；候选文件不是可提交结果。

`allowPartial` 已移除。用户明确要求中间库存时使用独立模式：

```js
await productOutput.writeEnrichProductExport(outDir, records, {
  outputMode: "inventory_partial",
});
```

该模式只生成 `inventory-partial.json`、原始 records、错误、`semantic-review-queue.json` 和报告，固定标记 `completionStatus:"incomplete"`，不会生成任何 API 请求文件。报告中的 `inputsReady` 只统计已通过 `semanticCompletion()` 与 gap 检查的记录；未完成的 form、healthFunctions、mainIngredients、Facts/Ingredients 读取或画廊复核，必须在 review queue 逐条列出。

整批成功时的固定产物：

- `products.json`：主要最终数据；数组内每项都是完整 `{"json": input}` envelope。
- `product-enrich-inputs.json`：API 内层 `input[]`，仅供调试或分析。
- `product-enrich-requests.json`：完整 envelope 数组。
- `product-enrich-requests.jsonl`：每行一个完整 `{"json": input}` HTTP body。
- `crawl-records.json`：原始爬虫 records、字段来源和语义证据。
- `products.csv`：API 字段的便览。
- `product-enrich-errors.json`：无法生成严格接口输入的记录及缺失字段。
- `enrich-export-report.json`：收到、可提交和失败条数。

`price` 默认导出且为严格模式必需字段：取 `fields.price` → `retail_price` → 默认可售变体价，原始字符串原样保留（多币种/多语言由接口侧归一）；缺价的记录进 error/review，不进 `products.json`。确有整站无价场景时传 `requirePrice:false` 放宽。`supplementFactsOCR` 仍默认不导出，需要时传 `includeNonPersistedFields: true`。

`updateExisting:false` 命中同名+同公司产品时直接跳过；需要给已有产品补关系、taxonomy 或图片时显式传 `updateExisting:true`。

提交前必须满足：

1. `inputsReady + errors === recordsReceived`。
2. `product-enrich-errors.json` 必须为空；失败记录只能留在 incomplete 候选导出，不能一边解释一边生成正式批次。
3. 每个 `domain` 是目标数据库中的公司匹配域名，每个 `productUrl` 是真实详情 URL。
4. `galleryReview.status` 为 `visual_complete`，且 `reviewed_image_urls` 覆盖最终 `images` 的每个 URL；`images` 包含完整画廊、可取得的最佳直接 CDN/原图和经视觉确认的 Facts 图片，推测的原图已经过真实浏览器 MIME/尺寸验证；否则 review 必须明确说明只有一张可用图或原图候选为什么被拒绝。
5. `factsSourceReview.status` 为 `complete`，并同时证明页面 DOM/Table/accordion 与画廊两种来源都已检查；二者均允许记录 `not_present`，但不能省略检查。
6. 有 `facts_images` 的 record 必须让每一个 Facts 图片 URL 都对应一条 `factsIngredientReviews[]` 的 `visual_complete` 记录；只复核第一张或只保留最后一张都不合格。
7. `productForm`、每个 `healthFunctions` 和每个 `mainIngredients` 都能在 `_meta.semanticInferences` 找到 high/medium confidence、证据、basis，以及 inferred 值所需的 rationale。
8. taxonomy 对象的 `category` 属于固定 12 类，`form/category` 都有 `substance`。
9. 只有用户明确授权提交时，才逐行 POST `product-enrich-requests.jsonl`。
10. `runCompletion.status` 为 `complete`，且其目录 seed、分页耗尽、详情队列和失败队列均已结案；不能只把通过校验的记录子集传给导出器。
