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
| `domain` | 是 | 明确覆盖值，或商品字段来源/商品 URL 的 hostname；小写并去掉 `www.` |
| `productName` | 是 | `fields.title` |
| `images` | 否 | 商品画廊图与已确认的 Facts 图片合并、去重 |
| `healthFunctions` | 否 | 有证据的 `fields.health_function` |
| `mainIngredients` | 否 | 有证据的 `fields.main_ingredients`；字符串和 taxonomy 对象可混用 |
| `productForm` | 否 | 有证据的 `fields.form` |
| `updateExisting` | 否 | 默认且显式输出 `false`；补已有产品关系/图片时设为 `true` |
| `processedAt` | 否 | 本次导出时间，ISO 字符串 |
| `error` | 否 | 上游显式错误信息 |
| `price` | 否 | 接口目前接收但不落库，默认不导出 |
| `supplementFactsOCR` | 否 | 接口目前接收但不落库，默认不导出 |

`domain` 不要擅自压缩成可注册根域名。接口可能按 `shop.example.com` 等公司域名匹配。跨域商城或第三方商品详情必须使用已经验证的商品字段来源；如数据库公司域名与来源 hostname 不同，用显式 `domain` 或 `domainByOrigin` 映射。

## 成分 taxonomy

`mainIngredients` 支持：

```jsonc
[
  "Resveratrol",
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
- `substance`：数据库物质层；只有提供它，新成分才能进入分类树。
- `form`：形态层，提供时必须同时有 `substance`。
- `category`：固定分类 slug。提供 `category` 时也必须有 `substance`。

允许的分类：`vitamins`、`minerals`、`amino_acids_peptides`、`herbs_botanicals`、`mushrooms`、`fatty_acids_lipids`、`probiotics_prebiotics`、`enzymes`、`antioxidants_polyphenols`、`hormones_precursors`、`fibers_carbs`、`proprietary_blends_other`。

taxonomy 必须来自成分原文和可靠归类知识。无法可靠判断 `substance/form/category` 时只输出字符串；禁止为了提高分类覆盖率猜测。

## 语义字段

`healthFunctions`、`mainIngredients`、`productForm` 是数据库词表。只输出 high/medium confidence 且有 evidence 的值：

- `mainIngredients` 必须来自图片优先的视觉复核；有 Facts/Ingredients 图时不能用固定词表或正文正则绕过看图。
- 不得把整段 `ingredients` 原文作为一个词条，也不得按逗号盲拆。
- `healthFunctions` 不得产生治疗、治愈、诊断或预防疾病声称。
- 全小写词条会在接口导出时转成 Title Case；已有混合大小写或缩写保持原样。
- 推断证据继续保存在原始 record 的 `_meta.semanticInferences`，接口输入只放最终值。

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
    // domain: "example.com",
    // domainByOrigin: { "shop.example.com": "example.com" },
  },
);
```

固定产物：

- `products.json`：API 内层 `input[]`，作为主要最终数据。
- `product-enrich-requests.jsonl`：每行一个完整 `{"json": input}` HTTP body。
- `crawl-records.json`：原始爬虫 records、字段来源和语义证据。
- `products.csv`：API 字段的便览。
- `product-enrich-errors.json`：无法生成有效接口输入的记录；主要是缺 `domain` 或 `productName`。
- `enrich-export-report.json`：收到、可提交和失败条数。

默认不导出当前不会落库的 `price` 与 `supplementFactsOCR`。用户明确需要兼容字段时传 `includeNonPersistedFields: true`，并清楚说明接口当前不会持久化它们。

`updateExisting:false` 命中同名+同公司产品时直接跳过；需要给已有产品补关系、taxonomy 或图片时显式传 `updateExisting:true`。

提交前必须满足：

1. `inputsReady + errors === recordsReceived`。
2. `product-enrich-errors.json` 为空，或失败记录已经单独解释。
3. 每个 `domain` 是目标数据库中的公司匹配域名。
4. `images` 包含经视觉确认的 Facts 图片，不只是一张封面图。
5. 有 `facts_images` 的 record 已写入 `factsIngredientReview.status: "visual_complete"`；否则适配器会把它列入导出错误。
6. taxonomy 对象的 `category` 属于固定 12 类，`form/category` 都有 `substance`。
7. 只有用户明确授权提交时，才逐行 POST `product-enrich-requests.jsonl`。
