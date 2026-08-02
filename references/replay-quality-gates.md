# 重放映射质量门

第二遍不是把任意唯一 DOM 节点保存成规则。它必须证明该 selector 指向视觉首遍确认的那类字段或商品入口。

## 商品卡和目录

列表→详情动作优先保存 `repeated_cards`：

1. 从视觉点击的商品链接向上最多检查 6 层祖先；
2. 祖先必须具有 product/card/item/tile 等稳定结构信号；
3. `祖先 selector + 后代链接 selector` 必须命中至少 2 个可见链接；
4. 命中链接必须包含至少 2 个不同 href；
5. 组合 selector 必须覆盖视觉首遍点击的那个商品。

不能证明重复卡片时，不得把普通导航类名伪装成商品卡 selector。若视觉已经证明目录只有一个商品，可以保存唯一精确链接并标记 `listingMode: "single_product"`。同页多个商品没有独立详情 URL 时使用 `inline_catalog`。

### 目录闭环和分页证明

映射成功不等于本轮耗尽。批量前 `catalogCoverage` 必须同时具有：

- `closure.status:"complete"`、`verifiedVisually:true` 和合法 `basis`；
- 全部视觉确认的 listing seeds；
- 每个 seed 的 `paginationMode:"none|link|click|scroll"` 和 `verifiedVisually:true`；
- sibling 目录族的完整 selector/URL 集合。

运行后 `collectProductUrls().coverage.seedReports[]` 必须逐 seed 为 `complete`。只有视觉证明为 `none` 才能以单页结束；点击型分页必须有映射动作并看到控件耗尽；滚动型分页必须连续稳定。`max_items_reached`、`max_pages_reached`、`pagination_mapping_missing`、`listing_fetch_failed`、循环 URL 和滚动上限均为可恢复的 incomplete，不能晋级 profile 或结束任务。

## 字段 selector

每个非 `not_present` 字段都要保存无字段值的 `quality`：

```json
{
  "valid": true,
  "score": 12,
  "tagName": "h1",
  "selectorCount": 1,
  "textLength": 24,
  "imageCount": 0,
  "videoCount": 0,
  "semanticSignals": ["heading", "title_marker"],
  "reasons": []
}
```

门槛：

- selector 必须唯一命中；
- `title`/`name` 要有 heading、title/name 标记和合理文本长度；
- `price` 要有 price/amount 语义或货币文本，不能指向整个商品头；
- `description` 要有 description/details 语义或合理叶子文本块，拒绝过宽父容器；
- `ingredients`、`supplement_facts` 要有对应标签、结构或表格信号；
- `images` 必须包含真实 `img`、`picture source` 或 CSS 背景图；video-only 容器无效；
- 揭示控件必须是 button、summary、link 或相应 role；
- 不同标量字段不能共用同一 selector，只有 `title` 与 `name` 作为别名可共享。

任何字段只要 selector 存在但 `quality.valid !== true`，整条路线仍是未映射，不能进入批量。

### 图片型 Facts 例外

`supplement_facts` 只存在于商品画廊图片时，checkpoint 使用 `sourceKind: "gallery_image"`。此时映射目标是稳定的商品画廊 selector，不是图片里的文字，也不把画廊 selector 写成 `selector_text`：

- 画廊 selector 必须唯一且 `quality.imageCount >= 1`；
- Facts 缩略图选择或 Zoom/modal 失败不终止重放，执行层继续读取渲染画廊、Document/CDP 图片映射和 `pageAssets`；
- 网页放大控件不是必需规则，不能作为批量回放依赖；
- 直接图片 URL 取得后仍必须截图读取内部 Facts 标题，才能生成 `facts_images`；请求 `main_ingredients` 时还必须读完主要/活性成分行；
- 若既没有稳定画廊映射，也没有可绑定当前商品的图片资源，仍按 `visual_field_target_not_mapped:supplement_facts` 失败。

## 性能边界

- 导航重放和字段展开默认不读取 gallery/pageAssets；
- 同页揭示动作不等待 URL 变化或 document load；
- 所有字段映射完成后只在最终详情页取一次图片证据；
- pageAssets 默认 2.5 秒硬超时，超时记 `page_assets_timeout` 并继续 DOM/响应证据；
- 整条代表路线默认 90 秒预算；超过预算失败并局部排查，不无限等待。
