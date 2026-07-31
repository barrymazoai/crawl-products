# crawl-products

一个面向 Codex App 的电商营养产品爬取 Skill。

它在用户连接的本地 Chrome 中工作，先通过截图完成视觉侦查，再把已验证的首页 → 分类 → 商品详情 → 字段路径映射为可复用的 DOM、CDP、Network 和高清图片规则。后续运行会直接回放已保存的站点 Profile。

## 主要能力

- 视觉优先的双遍路径学习
- 分类页、商品详情页和字段级路线持久化
- Supplement Facts / Nutrition Facts 画廊图片识别
- 高清原图恢复与多图采集
- `productForm`、`healthFunctions`、`mainIngredients` 语义派生
- Supply Smart `product/enrich` 接口数据导出
- 母公司 → 直属 Brand 一层组合站支持
- 默认排除 Bundle、Pack、Kit 和非 Nutrition 商品

完整行为和使用流程见 [SKILL.md](SKILL.md)。

## 安装

```bash
git clone https://github.com/barrymazoai/crawl-products.git \
  ~/.codex/skills/crawl-products
```

重启或重新加载 Codex 的 Skill 列表后，即可在任务中要求 Codex 使用 `crawl-products`。

## 前置条件

- Codex App
- 已连接 Codex Chrome 扩展的本地 Chrome Profile
- Node.js 20 或更高版本（仅运行测试时需要）

## 测试

```bash
pnpm install
pnpm test
```

## 数据范围

默认 `productScope` 为 `nutrition_single_products`，只输出单品营养产品。若明确需要完整目录，可传：

```js
productScope: "all_products"
```

范围判断细节见 [references/nutrition-product-scope.md](references/nutrition-product-scope.md)。
