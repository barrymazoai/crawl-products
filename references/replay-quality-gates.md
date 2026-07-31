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

## 性能边界

- 导航重放和字段展开默认不读取 gallery/pageAssets；
- 同页揭示动作不等待 URL 变化或 document load；
- 所有字段映射完成后只在最终详情页取一次图片证据；
- pageAssets 默认 2.5 秒硬超时，超时记 `page_assets_timeout` 并继续 DOM/响应证据；
- 整条代表路线默认 90 秒预算；超过预算失败并局部排查，不无限等待。
