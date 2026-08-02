# Browser 证据与持久化 profile

本参考描述 `crawl-products` 的浏览器证据层、站点 profile 和母公司/子品牌 profile。详情字段规则本身见 `profile-schema.md`。

## 目录

- [证据优先级](#证据优先级)
- [CDP responseRules](#cdp-responserules)
- [site profile](#site-profile)
- [首轮与复跑](#首轮与复跑)
- [portfolio profile](#portfolio-profile)
- [安全和持久化边界](#安全和持久化边界)

## 证据优先级

未知站点先走视觉路线，已到达目标后才进入证据合并。首遍顺序是：

1. screenshot 判断页面角色和下一步；
2. CUA 点击/滚动走到列表和代表商品；
3. 继续用截图定位每个请求字段，以及让字段出现所需的滚动、tab 或 accordion；
4. 临时记录 URL、页面角色、可见动作名称和字段屏幕位置。

第二遍从入口正向重放，再按下面顺序合并数据证据：

1. 已走通分类/商品动作对应的 DOM selector 和页面结构指纹；
2. 视觉字段目标对应的 DOM selector，以及字段揭示控件对应的 interaction hint；
3. 展开折叠区、滚动懒加载后的 DOM 与紧凑字段投影；
4. 点击前启动 CDP 后观察到的 Document、XHR 和 Fetch；
5. 已学习窄规则匹配的响应正文；
6. 全部字段映射完成后，最终详情页一次性读取的 gallery/`pageAssets` 资源。

Document 响应解决客户端或工具输出被截断的问题；DOM 解决交互后才出现的内容；XHR/Fetch 解决客户端二次加载字段；`pageAssets` 用于确认页面实际加载过哪些图片。导航和逐字段映射不反复调用 pageAssets；只在最终详情页调用一次，默认 2.5 秒超时后继续其他证据。

若 `Network.getResponseBody` 失效且完整 DOM 输出在约 200 KB 处截断，执行层会单独投影可见的标题、价格、描述、详情和表格节点。已学 `selector_text` 也会加入该投影，因此不应因为完整 HTML 截断而退回标题中的规格数字。

截图不参与批量机械抽取。它用于首遍路线发现，以及复跑规则失效时重新判断：

- 正常店铺、portfolio、inline catalog、停放域名或错误页分类；
- 视觉导航到列表和代表商品；
- 定位每个请求字段并确认隐藏/缺失状态；
- 画廊、选中变体、弹层或模板变化判断。

不要在视觉首遍交错执行 DOM/CDP 检查。第二遍也不要依赖浏览器 Back；BFCache 可能不会重发网络请求，应从入口带观测正向重放。

截图必须通过 `captureVisualScreenshot` 的外层硬超时调用。截图超时、CDP `Page.captureScreenshot` 失败或截图异常空白都属于浏览器执行证据，`persistable: false`，不能解释成站点不可用。超时后旧 tab 标为污染并用 `replaceTaintedTab` 替换；成功但异常空白只允许短等后重截一次。若视觉尚未证明路径就停止，若已证明 listing/detail/inline catalog 才允许第二遍映射该已知路线。

`replayVisualRoute` 同时使用总预算和单操作预算。导航证据、动作映射、点击证据、字段揭示、字段 selector 映射和最终图片证据各自受硬上限保护；任一上限触发都会抛出 `discardTab: true`，调用者必须换新 tab 后从入口重放，不能继续使用旧页面状态。

## CDP responseRules

`cdpProfile` 只保存网络响应的匹配规则：

```json
{
  "responseRules": [
    {
      "name": "product-detail-api",
      "urlIncludes": "/api/product/",
      "resourceTypes": ["XHR", "Fetch"]
    },
    {
      "name": "graphql-product",
      "urlPattern": "/graphql(?:\\?|$)",
      "resourceTypes": ["Fetch"]
    }
  ]
}
```

每条规则必须有 `urlIncludes` 或 `urlPattern`。优先用稳定且足够窄的 `urlIncludes`。如果多个业务共用 `/graphql`，仅靠 URL 无法证明它是产品响应，不应创建宽泛规则。

限制：

- 最多 12 条规则；
- 默认资源类型为 `XHR`、`Fetch`；
- 每页默认最多读取 8 个匹配响应；
- 每个正文默认最多保留 2,000,000 字符用于当页抽取；
- base64 响应不读；
- 获取失败时回退到 Document/DOM。

运行时证据形状：

```json
{
  "network": {
    "responseCount": 74,
    "truncated": false,
    "responseBodies": [
      {
        "name": "product-detail-api",
        "url": "https://shop.example/api/product/abc",
        "type": "XHR",
        "mimeType": "application/json",
        "status": 200,
        "body": "{...}",
        "bodyBytes": 4210,
        "truncated": false
      }
    ]
  }
}
```

`body` 是临时运行证据，不进入 site profile，也不应打印到对话。

## site profile

新规则只能在代表详情真实通过后晋级为可复用 profile：通常至少验证 2 个真实商品详情；经完整目录证明全站确实只有 1 个商品时验证该 1 个即可。0 商品、错误页、inline 占位记录、字段缺失或 completion 为 partial 的样本都不能计入，也不能保存或覆盖正式 profile。portfolio 父 profile 适用同一门槛，不能因为识别到 Brand 链接就在子站抓取全失败时保存。

`profile-store.mjs` 当前版本是 `4`，`visualRoute` 版本是 `3`。v4 在 v3 的完整字段旅程上增加字段 selector 的语义质量证据、商品目录模式和跨 origin 关系。v3 的 discovery、listing 和导航 steps 可以局部迁移，但必须重新验证代表详情页字段/图片：

```json
{
  "version": 4,
  "kind": "crawl-products-site-profile",
  "site": {
    "startUrl": "https://shop.example/",
    "origin": "https://shop.example",
    "hostname": "shop.example"
  },
  "fields": ["description", "images", "price", "title"],
  "templateFingerprint": "f7d9c5...",
  "discovery": {
    "strategy": "visual_route",
    "listingSeeds": ["https://shop.example/collections/all"],
    "storefrontOrigins": ["https://shop.example"],
    "sampleProductUrl": "https://shop.example/products/example"
  },
  "listingProfile": {
    "categoryLinkSelectors": ["header .catalog-link"],
    "productLinkSelectors": ["a.product-item-link"],
    "paginationActions": [
      { "action": "click", "selector": "button.load-more", "text": "Load more" }
    ],
    "listingMode": "repeated_cards",
    "scrollListings": true,
    "listingScrollScreens": 10,
    "followVerifiedExternalProductLinks": false
  },
  "visualRoute": {
    "version": 3,
    "status": "mapped",
    "targetRole": "detail",
    "requestedFields": ["description", "images", "price", "title"],
    "steps": [
      {
        "pageRole": "home",
        "url": "https://shop.example/",
        "templateFingerprint": "a1b2c3...",
        "action": {
          "actionKind": "catalog_entry",
          "catalogCoverage": "siblings",
          "text": "Shop",
          "targetUrl": "https://shop.example/collections/all",
          "selector": "header a[href='/collections/all']",
          "generalSelector": "header .catalog-link",
          "generalSelectorSource": "repeated_navigation"
        }
      },
      {
        "pageRole": "listing",
        "url": "https://shop.example/collections/all",
        "templateFingerprint": "d4e5f6...",
        "action": {
          "actionKind": "product_entry",
          "text": "Example product",
          "targetUrl": "https://shop.example/products/example",
          "selector": "a[href='/products/example']",
          "generalSelector": ".product-card a",
          "generalSelectorSource": "repeated_ancestor"
        }
      },
      {
        "pageRole": "detail",
        "url": "https://shop.example/products/example",
        "templateFingerprint": "f7d9c5..."
      }
    ],
    "catalogCoverage": {
      "status": "mapped",
      "listingSeeds": [
        "https://shop.example/collections/all",
        "https://shop.example/collections/vitamins"
      ],
      "listings": [
        {
          "url": "https://shop.example/collections/all",
          "paginationMode": "click",
          "verifiedVisually": true
        },
        {
          "url": "https://shop.example/collections/vitamins",
          "paginationMode": "none",
          "verifiedVisually": true
        }
      ],
      "families": [
        {
          "sourceUrl": "https://shop.example/",
          "sourcePageRole": "home",
          "selector": "header .catalog-link",
          "coverage": "siblings",
          "listingUrls": [
            "https://shop.example/collections/all",
            "https://shop.example/collections/vitamins"
          ]
        }
      ],
      "closure": {
        "status": "complete",
        "verifiedVisually": true,
        "basis": "navigation_exhausted"
      }
    },
    "fieldJourney": {
      "status": "mapped",
      "pageUrl": "https://shop.example/products/example",
      "fields": [
        {
          "field": "title",
          "availability": "present_visible",
          "targetSelector": "main h1",
          "quality": {
            "valid": true,
            "score": 12,
            "tagName": "h1",
            "selectorCount": 1,
            "textLength": 15,
            "imageCount": 0,
            "videoCount": 0,
            "semanticSignals": ["heading", "title_marker"],
            "reasons": []
          }
        },
        {
          "field": "price",
          "availability": "present_visible",
          "targetSelector": "[data-product-price]",
          "quality": {
            "valid": true,
            "score": 11,
            "tagName": "span",
            "selectorCount": 1,
            "textLength": 7,
            "imageCount": 0,
            "videoCount": 0,
            "semanticSignals": ["price_marker", "currency_text"],
            "reasons": []
          }
        },
        {
          "field": "description",
          "availability": "present_hidden",
          "targetSelector": "#description-panel",
          "quality": {
            "valid": true,
            "score": 10,
            "tagName": "section",
            "selectorCount": 1,
            "textLength": 320,
            "imageCount": 0,
            "videoCount": 0,
            "semanticSignals": ["description_marker", "description_length"],
            "reasons": []
          },
          "revealAction": {
            "action": "click",
            "text": "Description",
            "selectorHint": "button[data-tab='description']"
          }
        },
        {
          "field": "images",
          "availability": "present_visible",
          "targetSelector": "[data-product-gallery]",
          "quality": {
            "valid": true,
            "score": 14,
            "tagName": "div",
            "selectorCount": 1,
            "textLength": 0,
            "imageCount": 4,
            "videoCount": 1,
            "semanticSignals": ["gallery_marker", "real_image_descendant"],
            "reasons": []
          }
        }
      ]
    }
  },
  "detailProfile": {
    "version": 1,
    "kind": "detail-extraction"
  },
  "imageProfile": null,
  "cdpProfile": {
    "responseRules": []
  },
  "portfolio": null,
  "learnedAt": "2026-07-27T00:00:00.000Z",
  "updatedAt": "2026-07-27T00:00:00.000Z",
  "validation": {
    "lastValidatedAt": null,
    "successCount": 0,
    "failureCount": 0
  }
}
```

文件名由 hostname 和 origin hash 组成，避免不同端口/协议互相覆盖。保存采用临时文件 + rename，避免中途退出留下半个 JSON。

### 校验原因

| 原因 | 可复用内容 | 动作 |
|---|---|---|
| `fields_not_covered` | discovery、已有字段规则 | 只学习新增字段 |
| `template_changed` | discovery | 重学详情、图片和 CDP |
| `visual_route_not_mapped` | 无 | 从入口重放并映射完整路线 |
| `field_journey_not_mapped` / `field_journey_incomplete` | 导航部分 | 视觉定位缺失字段，再映射字段和揭示控件 |
| `field_selector_collision` | 导航部分 | 重映冲突字段，选择字段内容叶子节点 |
| `product_link_selector_missing` | 导航部分 | 从视觉点击链接向上找重复商品卡；小目录可标 `single_product` |
| `catalog_family_missing` | 详情字段和已完成动作 | 回到对应截图状态，映射该级目录族 selector |
| `catalog_sibling_coverage_incomplete` | 详情字段和已完成动作 | 截图显示有兄弟目录但只映射到一个 URL，不能开始批量 |
| `catalog_coverage_not_mapped` / `catalog_closure_not_proven` | 详情字段与已有入口 | 回到入口用截图确认完整目录边界；不能把单个 Best Sellers 页当全站 |
| `catalog_listing_seeds_missing` | 详情字段 | 补齐全部 listing seed；只有视觉证明的单产品目录可没有 listing |
| `catalog_listing_pagination_unverified` | 已映射入口与详情字段 | 逐 seed 视觉确认 `none/link/click/scroll`；“没找到分页”不能直接填 `none` |
| `pagination_selector_missing` | 目录和详情规则 | 重新映射视觉确认过的分页/Load More 控件 |
| `cross_origin_relation_missing` | 各 origin 独立规则 | 视觉确认并标记跨域关系类型 |
| `legacy_profile_quality_revalidation_required` | v3 discovery、listing、steps、窄 CDP 规则 | 只重映代表详情页字段/图片质量，升级为 v4 |
| `version_mismatch` | 无 | 重新学习 |
| `origin_mismatch` | 无 | 不跨 origin 套规则 |
| `wrong_kind` / `read_failed` | 无 | 忽略损坏 profile |

template fingerprint 会移除脚本、样式、字段值、URL 和数字，只比较结构摘要；它不是页面内容缓存。

## 首轮与复跑

首轮：

```text
截图/CUA 纯视觉确认每级目录族、分页，再走到详情和全部请求字段
→ 回入口
→ 带 DOM/CDP 观测正向重放完整旅程
→ 学目录覆盖/分页/商品/字段/展开/网络/图片规则
→ 限量验证
→ 全量
→ 保存
```

复跑：

```text
加载 profile → 代表商品结构校验 → 回放 selector/URL/CDP 规则 → 全量
```

局部重学：

```text
保留已映射导航 → 视觉定位异常字段 → 重放并更新对应字段/图片/CDP 规则 → 覆盖保存
```

未知站点自动发现和 `forceDiscovery` 已移除。`reuseProfile: false` 表示明确放弃旧 profile，但随后仍必须先完成视觉旅程，不能直接进入 `crawlSite`。

## portfolio profile

母公司 profile 的 `portfolio` 只保存已验证的品牌关系：

```json
{
  "version": 2,
  "kind": "crawl-products-portfolio-profile",
  "parentSite": "https://group.example/",
  "parentOrigin": "https://group.example",
  "scopeMode": "verified_brand_sites",
  "maxDepth": 1,
  "directBrandOnly": true,
  "sites": [
    {
      "origin": "https://brand-a.example",
      "brandOrigin": "https://brand-a.example",
      "brandUrl": "https://brand-a.example/products",
      "finalOrigin": "https://shop.brand-a.example",
      "entryUrl": "https://brand-a.example/products",
      "parentOrigin": "https://group.example",
      "depth": 1,
      "label": "Brand A",
      "relation": "official_brand",
      "confidence": 0.91,
      "evidence": [
        "parent_site_link",
        "product_catalog",
        "verified_redirect"
      ],
      "profileRef": null
    }
  ],
  "learnedAt": "2026-07-27T00:00:00.000Z"
}
```

缺少 `depth`/`parentOrigin` 的旧 v1 site entry 按直属 Brand 迁移；显式 `depth > 1` 或 parent 不匹配的 entry 拒绝。`maxDepth` 无论调用参数如何都固定为 `1`。

母公司关系不使用 DOM 自动扫描。首轮只接受截图视觉确认后传入的直属 `verifiedSites`，每个 Brand 同时提供自己的 mapped route；复跑才读取 parent/brand profiles。用户给出的入口若无自有商品却有 Brand 候选，必须继续视觉验证这些候选；确认后自动进入一层 portfolio，无需用户再次授权，不能把父站的 0 商品当终态。Brand 的 route 可以通过 `official_store_handoff` 进入自己的商城，也可以通过 `external_product_detail` 到精确商品详情，但不得再次出现 `portfolio` 页面角色或 `portfolio_brand_site`。因此技术上跨多个 origin 仍可能是同一个 Brand 的商品路线，组织层级不会超过一层。

作用域模式：

- `same_site`：默认，只允许同一 registrable domain，包括 `shop.example.com`。
- `verified_brand_sites`：允许视觉确认的外域品牌，但必须二次验证商品目录/店铺导航。
- `explicit_allowlist`：只允许 `allowedOrigins` 中的外域。

入口为无商品母公司且 `verifiedSites` 含外域直属 Brand 时，`crawlTarget()` 自动选择 `verified_brand_sites`；这不是无限扩域许可。`maxOrigins` 只是本轮成本上限，若还有确认 Brand 因上限未处理，结果必须为 `incomplete/portfolio_brand_limit_reached`，提高上限后从 checkpoint 继续。

`followVerifiedExternalProductLinks` 不会把外域升级成可递归店铺。它只允许列表商品卡中已经出现、经过商品卡 selector 约束的精确外域详情 URL；外域根路径、品牌集合、分类页、Marketplace 和普通页脚链接继续排除。适用于品牌目录把每个“购买”按钮托管到同一第三方商店的情况。

候选关系和 Brand 抽取规则必须分开保存。每个 Brand/官方商城 origin 使用独立 site profile，防止品牌 A 的 selector、图片或接口规则泄漏给品牌 B。

重定向只接受从已允许候选出发并经过店铺验证后的 `finalOrigin`。不能把一次跳转当成无限扩域许可。

## 安全和持久化边界

允许写入 profile：

- 入口策略和列表 URL；
- 视觉路线的页面角色、URL、动作类型、目录覆盖、DOM selector 和结构指纹；
- 每个请求字段的可得性、字段 selector 和安全揭示控件 selector；
- 分类族、商品卡、分页/Load More selector 和列表滚动规则；
- 官方品牌 origin 关系及其证据摘要；
- selector、label alias、regex；
- 图片容器/排除规则；
- CDP URL 匹配规则；
- template fingerprint 和统计时间。

禁止写入 profile：

- 商品标题、价格、描述、成分等字段值；
- Document、XHR、Fetch 响应正文；
- 请求/响应 headers；
- Cookie、localStorage、token；
- 浏览器历史、账号或其他会话信息；
- screenshot 像素或 OCR 文本。
- 视觉点击坐标。

运行日志也只保留紧凑摘要。需要落商品数据时，写入用户指定的 JSON/CSV 输出目录，不混入 profile 目录。
