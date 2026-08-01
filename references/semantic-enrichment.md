# Facts 图片与产品语义派生

本规则只用于商品详情页已经完成视觉定位和结构化抽取之后。原始字段继续以页面为真值；`form`、`health_function`、`main_ingredients` 等派生字段必须明确标注依据，不写入 value-free profile。

推断由模型完成，不由正则或脚本硬编码。可以先调用 `buildSemanticEvidenceBrief(record)` 生成有界证据包，模型结合标题、分类、描述、Directions、成分区、Facts 图片和包装视觉作出判断；再用 `normalizeProductSemanticEnrichment()` 校验结果。脚本没有产出语义字段时，表示仍需模型处理，不表示字段为空。

## 目录

- Facts 图片
- `form`
- `health_function`
- `main_ingredients`
- 输出结构

## Facts 图片

对每个商品的真实画廊图片执行以下顺序：

1. 先扫描画廊缩略图并选择疑似表格、背标或成分标签的图片。不能只检查第一张图；站内 Zoom/modal 点不开时标记 `sourceKind: "gallery_image"`，不要停止路线。
2. 用 `classifyFactsImageCandidate()` 读取 `alt`、`title`、资源名和画廊位置：
   - 明确写出 `Supplement Facts`、`Nutrition Facts`、`Drug Facts` 或 `Product Facts` 时可直接分类。
   - `Ingredients`、`Label`、`Back panel`、`Composition`、空标签的第二/后续图片只作为候选，必须视觉复核。
3. 优先加载画廊取得的直接 CDN/原图 URL 并截图读取内部标题；网页放大控件只作可选辅助。视觉确认后调用 `finalizeFactsImageReview()`。
4. 图片内容没有 Facts 标题时传 `isFactsImage:false`。`Ingredients` 标签本身不能证明它是 Facts。
5. 同一图片可以同时保留在普通商品画廊和 `facts_images`，除非用户明确要求把标签图从普通图片中排除。
6. 请求 `main_ingredients` 时不能停在标题识别：继续读取面板内的主要/活性成分行和可见剂量，并调用 `finalizeFactsIngredientReview()`。
7. 全部画廊候选处理完后调用 `finalizeGalleryReview(images, reviews)`；每个最终图片 URL 都必须有 `reviewedVisually:true` 与明确 Facts 判定。该函数生成 `_meta.galleryReview.status: "visual_complete"`、复核 URL 清单和 Facts 结论；不要手写状态绕过逐图检查。

例：页面把第二张图的 `alt` 写成 `Activate Ingredients`，但放大后图片内部标题是 `Supplement Facts`。它应进入 `facts_images`，类型为 `Supplement Facts`，分类依据为 `visual_content`。

## `form`

`form` 表示产品的物理/剂型形态，使用简短、可跨站复用的值，例如：

- `capsule`、`softgel`、`tablet`、`gummy`、`chewable`
- `powder`、`liquid`、`drops`、`spray`
- `cream`、`gel`、`lotion`、`serum`、`oil`
- `bar`、`tea`、`device`、`kit`

包装方式另存 `form_presentation`，例如 `single-serving packets`、`bottle`、`sachets`。

证据优先级：

1. 标题或页面明确文本；
2. Directions / Serving Size / Facts；
3. 包装正面或背标的视觉文字；
4. 多条页面信息组合后的合理推断。

直接写明也要保存证据；推断值还必须保存 rationale。只有 `high` 或 `medium` 置信度可以输出，低置信度省略。

## `health_function`

`health_function` 是宽泛的产品用途分类，不是医学诊断或疗效结论。输出支持型名词短语，例如：

- `digestive health support`
- `immune support`
- `energy and metabolism support`
- `healthy weight management support`
- `joint and mobility support`
- `skin health support`
- `sleep and relaxation support`
- `cleanse/detox support`

可以综合标题、描述、分类、用法、成分和 Facts 做推断。若页面没有直接写用途，但成分、剂型和上下文共同支持一个宽泛类别，可标为 `inferred` + `medium`；不能仅凭常识把单个成分升级为治疗或疾病预防声称。

禁止输出 `treats`、`cures`、`prevents`、`diagnoses` 等医疗结论。页面自己的营销说法也要归一化为支持型分类，并在 evidence 中保留原始短句，而不是把营销声明当独立医学事实。

## `main_ingredients`

`main_ingredients` 是供数据库词表和三层 taxonomy 使用的一组主要成分。每项都必须能由 Facts/Ingredients 图片、页面成分区、标题或描述单独证明。

- **图片优先是硬门槛**：商品有 Facts/Ingredients 图时，逐张打开、放大并截图读取。只确认图片类型、不读取成分行，字段仍未完成。
- 从图里选择有独立行、有用量或被标为 active/key 的成分。OCR 可以辅助定位，但截图视觉确认才是证据。
- 没有可读成分图时，才视觉展开页面 Ingredients/Key Ingredients 区域并在第二遍映射 DOM。
- 页面成分区也不存在时，标题/描述只能作为最后兜底，并且必须明确点名该配方包含该成分。
- 普通配料原文继续保留在 `ingredients`；不得把整段原文塞成一个 `main_ingredients` 值。
- 不得按逗号、分号或换行盲拆，因为复合配方、括号和来源说明会被错误拆分。
- 禁止用固定站点词表或已知成分字典决定“有没有成分”；词表只能在看见原文后规范名称。
- 使用可跨商品去重的规范名称，不附带剂量、百分比、商标符号或营销描述。

视觉复核示例：

```js
const enrichment = productSemantics.finalizeFactsIngredientReview(factsImage, {
  reviewedVisually: true,
  visibleHeading: "Supplement Facts",
  ingredients: [
    {
      name: "White Kidney Bean Extract",
      visibleText: "White Kidney Bean Extract",
      substance: "White Kidney Bean",
      category: "herbs_botanicals",
      confidence: "high",
    },
    {
      name: "Hibiscus Flower Extract",
      visibleText: "Hibiscus Flower Extract",
      substance: "Hibiscus",
      category: "herbs_botanicals",
      confidence: "high",
    },
  ],
});
record = productSemantics.mergeProductSemanticEnrichment(record, enrichment);
```

`name` 是图片实际成分名；`substance` 是数据库物质层，`form` 是形态层，`category` 只能用接口固定分类。只有分类证据可靠时才附加 taxonomy；不确定时输出名称字符串，不要猜分类。

## 输出结构

```jsonc
{
  "fields": {
    "form": "powder",
    "form_presentation": "single-serving packets",
    "health_function": [
      "digestive health support",
      "cleanse/detox support"
    ],
    "main_ingredients": [
      "Vitamin C",
      {
        "name": "Green Tea Extract",
        "substance": "Green Tea",
        "form": "Green Tea Extract",
        "category": "herbs_botanicals"
      }
    ]
  },
  "_meta": {
    "semanticInferences": {
      "form": {
        "value": "powder",
        "basis": "inferred",
        "confidence": "high",
        "rationale": "Serving size and package text identify a powdered packet.",
        "evidence": [
          {
            "source": "supplement_facts_image",
            "excerpt": "Serving Size 1 Packet (9 g)"
          }
        ]
      },
      "health_function": [
        {
          "value": "digestive health support",
          "basis": "inferred",
          "confidence": "high",
          "rationale": "The product description centers the cleanse on digestive energy.",
          "evidence": [
            {
              "source": "description",
              "excerpt": "ignite your digestive energy"
            }
          ]
        }
      ],
      "main_ingredients": [
        {
          "value": "Vitamin C",
          "basis": "explicit",
          "confidence": "high",
          "evidence": [
            {
              "source": "supplement_facts_image",
              "excerpt": "Vitamin C 500 mg"
            }
          ]
        }
      ]
    },
    "factsIngredientReview": {
      "status": "visual_complete",
      "image_url": "https://cdn.example/facts.jpg",
      "visible_heading": "Supplement Facts",
      "ingredient_count": 2
    }
  }
}
```
