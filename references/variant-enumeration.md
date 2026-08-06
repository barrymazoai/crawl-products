# 变体枚举与记录

变体不是重复商品。列表卡片或详情选择器显示的口味、颜色、剂型、容量、份数或单个包装规格必须逐一记录为独立可售状态。多个独立商品组成的 Bundle/Pack/Kit 仍按主 Skill 的 Bundle 排除约束处理。

## 识别

- 代表商品详情必须检查是否有 variant selector（select、swatch、radio、按钮组或变体链接）；如果选择后标题、SKU、价格、库存、图片或 Facts 改变，就把每个可售状态视为独立变体并记录选择值。
- 列表出现相同基础标题/路径的多张卡片时，先比较 href 中的变体参数、SKU、卡片选择标签和图片；它们可能是不同变体，不能用基础 URL 去重后只留第一张。
- 数量输入、配送频率和加购数量不是变体。变体选择器中的“30 capsules”“Chocolate”“Unflavored”属于单品选项，应保留；标题明确为 Bundle、Starter Kit、Duo、Multi-pack 或多个独立商品一起销售的选项，才按组合装排除。

## 枚举顺序

在已确认的品牌自营详情页中，按以下顺序执行：

1. 先截图确认选择器的语义和分组（例如 Flavor、Size、Count、Color、Form）。
2. 记录默认状态，然后逐组选择每个可售组合。每次选择后等待页面完成更新，再读取当前标题、SKU/variant ID、价格、库存、canonical URL、全部画廊和 Facts 候选。
3. 选择后的状态如果改变了 URL query/path，保留显式变体参数；如果 URL 不变，必须用选项组合、SKU 或 Network/DOM 的 variant ID 生成稳定 `variantIdentity`，不能只靠数组下标。变体身份按 `variantId`/SKU → 选项组合 → 变体 URL 的顺序确定。
4. 每个状态都调用 `crawl.withVariantState()`，把状态放在原始 record 的 `_meta.variant`，并同步保留 `fields.variant_options`、`fields.variant_name`、`fields.variant_id`/`variant_sku` 和变体详情 URL。

## 验证

- 若商品有变体，每个状态都重新等待渲染并检查标题、SKU/选项、价格/库存、画廊和 Facts；不能把默认状态的详情复制给其他状态。
- 不同变体不得因共享基础路径被合并，也不得把不同变体的图片/Facts 互相混用。变体自己的图片只归该变体；相同变体从列表页和详情页重复观察时才合并图片。

## 持久化

- 若站点的视觉路线已映射变体选择器，把不含具体商品值的 `variantProfile`（选择器、分组和等待动作）随 profile 保存；复跑时先用它定位控制，再用当前页面实际呈现的状态值生成记录。某次运行的具体选项值不写进可复用 profile。
- 变体的详细状态由 Skill 原样保留在 `_meta.variant`、`fields.variant_options`、`fields.variant_name`、`fields.variant_id`/`variant_sku` 和对应图片/Facts 证据中。导出时不为了适配接口擅自改写基础 `productName` 或拼接变体后缀；下游 enrich 接口负责变体关联和落库，`crawl-records.json` 是完整详细数据源。
