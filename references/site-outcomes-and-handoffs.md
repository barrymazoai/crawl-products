# 站点终态和跨域接力

视觉首遍先按屏幕判断站点结果，再决定是否继续。不要把“没有找到商品”统一解释为网站不可访问。

## 站点结果

`classifySiteOutcome` 使用这些结果：

| kind | 含义 | 后续 |
|---|---|---|
| `storefront` | 有可抓商品/详情 | 继续完整视觉路线 |
| `official_store_handoff` | 品牌官网把商城放在另一个 origin | 继续同一品牌商品路线，子 origin 独立保存规则 |
| `portfolio` | 母公司/国家页指向多个品牌 | 抓取视觉确认的直属 Brand 一层，不递归下一层 |
| `manufacturer_catalog` | B2B 制造商目录，无消费者 SKU | 终止并汇报 |
| `service_or_out_of_scope` | 服务站、医疗信息或主题不符 | 终止并汇报 |
| `parked` | 停放/出售域名 | 终止并汇报 |
| `challenge` | CAPTCHA/Cloudflare 等 | 停止，不反复撞 |
| `access_error` | 页面级网络/TLS/HTTP 错误 | 新 tab 最多重试一次后分类 |

## 访问错误

使用 `classifyBrowserAccessError(error, pageEvidence)`：

- `ERR_TIMED_OUT` → `navigation_timeout`
- `ERR_CONNECTION_CLOSED` → `connection_closed`
- `ERR_CERT_*` / privacy error → `tls_certificate_error`
- HTTP 4xx/5xx → `http_error`
- CAPTCHA/Cloudflare → `challenge`
- `blocked_by_browser_url_policy`、扩展断连、tab/session closed → `browser_execution_error`
- `browser_operation_timeout`、replay budget exceeded、`Page.captureScreenshot` 超时或截图异常空白 → `browser_execution_error`

`browser_execution_error` 不是站点事实，`persistable: false`。页面级访问错误只允许保存带 TTL 的 observation，不能写成永久 site profile，也不能覆盖已学 profile。TLS 错误不绕过。

带 `discardTab: true` 的执行错误表示当前 tab 可能仍有未结束的导航/CDP 命令。必须关闭旧 tab（关闭也要限时）并从同一个 browser binding 新建 tab；不能在旧 tab 上测试下一站。单操作硬超时与整条 replay 总预算同时生效，前者防止一个 RPC 独占全部预算。

## 跨 origin 关系

任何跨 origin 的 route action 都必须有 `relationType`：

- `official_store_handoff`：一个品牌官网把官方购买流程交给另一个官方商城，例如国家站→本地官方商店；
- `portfolio_brand_site`：母公司/集团→某个独立子品牌；
- `external_product_detail`：品牌目录里的单个商品卡→外部托管的精确商品详情。

三者不能混用：

- 官方商城接力仍属于当前品牌的一条 commerce route，不自动扩成集团 portfolio；
- portfolio 从用户给出的母公司入口只展开到视觉确认的直属 Brand（depth 1）；
- external product detail 只允许已映射商品卡里的精确详情 URL，不递归外部店铺导航。

每个 origin 使用独立 site profile、selector、template fingerprint 和 CDP 授权。父路线可以引用子 origin，但不能把父 origin 的 DOM/CDP 规则套到子 origin。

直属 Brand 跳到自己的官方商城仍是 `official_store_handoff`，不增加组织深度。进入 depth 1 后，route 再出现 `portfolio` 页面角色或 `portfolio_brand_site` 就是第二层品牌展开，必须以 `portfolio_depth_exceeded` 停止；不要进入孙级品牌、经销商集合或下一层母公司。

商品结果中的字段还要保留来源：

- `_meta.fieldSources.<field>` 保存实际 `sourceUrl`、`sourceOrigin`、提取层和跨域 `relationType`；
- 同一商品的价格或币种出现冲突时，首个有效值留在 `fields`，所有冲突观测进入 `_meta.fieldConflicts`；
- 品牌目录价、官方商店价和第三方详情价不能静默互相覆盖。这些值属于商品结果，不进入 value-free site profile。
