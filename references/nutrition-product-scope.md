# 单品营养产品范围

默认策略是 `productScope: "nutrition_single_products"`。目标数据集只收可单独购买和使用的营养、膳食补充或口服健康产品。

## 收录

满足下列任一强证据，且不是组合装：

- 页面或画廊中视觉确认存在 `Supplement Facts` 或 `Nutrition Facts`；
- `productForm` 明确是 capsule、tablet、softgel、gummy、powder、drink mix、shake、tea、nutrition bar、oral drops 等口服营养形态；
- 详情说明明确要求 take、swallow、chew、drink、consume、mix 等服用动作；
- 标题、分类和详情正文明确把它描述为 dietary supplement、nutrition、vitamin、mineral、protein、probiotic、omega-3、botanical、meal replacement 或 electrolyte 产品。

商品即使位于 Beauty 分类，只要 Facts、口服形态或服用方式能证明它是营养产品，仍应收录。

## 排除

- 组合装：Bundle、Pack、Kit、Stack、Set、Collection、Regimen、Duo、Trio、Multi-pack、Variety Pack、Starter Set 等；
- 非营养商品：护肤、美妆、洗护、家清、洗衣、器械、配件，以及不属于人类口服营养的 pet/equine 商品；
- `Drug Facts` 明确标识的 OTC/药品；它不是 Nutrition 产品；
- 详情页没有任何可信营养证据的模糊商品。

`packet` 或 `packets` 描述单份袋装剂型，不等于 Pack 组合装。不要只凭这个词排除。

## 两层判断

1. 候选 URL 层只排除 URL 已经明确表明组合装或非营养商品的项目，避免无意义的详情页访问。
2. 详情记录层综合标题、URL、分类、形态、描述/用法和 Facts 证据做最终判断。详情证据可以纠正分类误导，例如 Beauty 分类下的口服胶原蛋白。

默认保守处理：证据不足时排除并记为 `nutrition_evidence_missing`，不要猜测收录。

## 审计输出

`crawlSite` 的结果包含：

- `stats.productScopePolicy`
- `stats.productsExcludedByScope`
- `stats.scopeExclusionReasons`
- `exclusions` 样本，含 `reason`、`evidence`、`title` 和 `url`

`bundle_or_pack`、`non_nutrition_product` 和 `nutrition_evidence_missing` 是范围排除，不计入爬取失败。接口导出只能使用过滤后的 `result.records`。

## 显式覆盖

只有用户明确要求完整商品目录（包括组合装和非营养品）时，才传：

```js
productScope: "all_products"
```

覆盖范围不降低字段质量要求：Facts 图片、成分和派生语义仍要按原流程视觉确认。
