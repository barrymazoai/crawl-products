# 多线程与浏览器租约

这份参考约束 `crawl-products` 在多个 Codex 任务、多个 Chrome Profile 或另一台电脑上运行时的边界。它解决的是浏览器状态和任务生命周期，不改变“视觉首遍 → 证据映射 → 严格导出”的产品规则。

## 线程与浏览器实例

### 单站点

- 一个站点默认由当前任务直接控制一个浏览器 binding 和一个 tab。
- `agent.browsers.get("extension")` 成功后，必须立刻调用 `browser.nameSession("🔎 crawl-products <site>")`，再创建或领取 tab。
- tab 是有状态租约。不要在同一个 tab 上并发 `goto`、截图、点击、CDP 或 Network 读取；不要用 `Promise.all` 让两个动作同时改变页面。
- 每次外部 Chrome 导航、视觉侦查、画廊展开和详情语义回合按顺序完成，并在需要时写 checkpoint。

### 多站点

如果用户一次给出多个站点，先决定是在一个任务内顺序跑，还是为每站创建独立的顶层任务线程：

1. 同一个 Chrome extension instance/profile 只有一个可用浏览器租约时，必须顺序跑。`crawlTargets()` 已提供这个顺序状态机。
2. 只有存在多个独立浏览器实例（例如另一台电脑或另一 Chrome Profile 各自连接扩展）时，才允许多个顶层线程并行；每个线程必须通过自己的 `agent.browsers.get("extension")` 建立 binding，不能把父线程的 `browser` 或 `tab` 对象传给子线程。
3. 每个线程使用独立输出目录和任务 ID，写自己的 `preflight.json`、`progress/checkpoint`、`crawl-records.json`、`semantic-review-queue.json`、诊断和导出报告。协调线程只在所有线程结束后读取这些文件合并。
4. 嵌套 site-scoped subagent 不适合作为浏览器控制器：如果它在首个 URL/截图前卡住，父线程应记录诊断并回收该线程，不要让整批任务等待。离线 JSON/语义检查可以交给 subagent，但浏览器控制应留在拥有浏览器租约的顶层线程。

`extensionInstanceId` 是区分独立连接的证据。只有不同的实例 ID 才能声称“另一台电脑/另一浏览器”；同一实例开多个 tab 仍是同一浏览器租约，不能当成独立机器。

## Preflight 和首证据 watchdog

每个线程在处理站点前必须先保存一个小的 preflight 记录，至少包括：入口 URL、浏览器实例标识（不含 Cookie/凭证）、session name、tab ID、截图是否成功、有限 DOM 是否成功、当前 URL/title 和时间戳。之后才开始视觉路线。

线程还必须设置首证据 watchdog：在有限时间内（建议 60 秒，按站点情况调整）看到入口截图/DOM 和第一个真实 listing 或详情 URL，或者明确记录页面级终态（卖场、challenge、TLS/HTTP 错误）。若没有任何首证据就超时：

- 写 `retry-diagnostic.json`，标记 `failureStage: "subagent_browser_execution"` 或对应执行阶段、`notSiteUnavailableEvidence: true`；
- 停止该线程对旧 tab 的继续操作，保留可恢复的输入/输出 checkpoint；
- 必要时回收当前 tab，从同一个 browser binding 新建 tab，只重试一次；
- 不把“子任务没有回第一条 URL”“Chrome 导航超时”写成 `site unavailable`，也不生成 0 商品的成功结果。

如果 preflight 成功但第一条详情导航超时，使用同一个 binding 的新 tab 顺序重试一次。若新 tab 能打开，分类为可恢复的 `browser_execution_error` 观测，不污染站点 profile；若截图明确显示 challenge/TLS/HTTP 页面，才按站点终态分类。

## 顺序读取与并发上限

- 未知站点视觉首遍、代表详情、画廊/Facts、变体选择和语义补全始终顺序执行。
- 外部 Chrome 的详情批量默认 `batchSize: 1`；`browser.tabs.content({urls: [...]})` 的后台并行只适用于已验证 profile、非交互字段且用户明确接受的成本优化，不能作为第一轮视觉路线或 Facts/变体读取。
- 同一线程永远只有一个活动页面状态。读取下一个产品前，先完成当前产品的字段、画廊、Facts、变体和语义 checkpoint。
- 多个顶层线程的建议并发上限是“独立浏览器实例数”，不是产品 URL 数。没有独立实例就设为 1；出现一次导航/截图争用后，降为顺序并在诊断中记录。

## 10 产品验收

“跑 10 个”表示顺序验证 10 个真实详情 URL，不是只枚举 10 个列表卡片。每个 URL 至少要有：真实 `productUrl`、产品名、全部画廊的图片资产身份、逐张 Facts/Ingredients 判定、`productForm`、`healthFunctions`、`mainIngredients` 及其证据。存在变体时，10 个 URL 之外还要把详情页实际可售的变体状态逐一记录；Bundle/Pack/Kit 和非 Nutrition 项仍按主 Skill 排除并保留原因。

10 个产品未必代表全站完成。若目录还有未处理 URL，结果必须是 `inventory_partial`，写 `inventory-partial.json` 和 `semantic-review-queue.json`，不能生成正式 `products.json`。只有目录覆盖闭环、10 个样本全部通过严格门且整站 completion 完成时，才允许 API-ready 导出。

## 结束和交接

线程结束前保留必要的站点/产品页，调用浏览器的 tab finalize；不要留下用于研究的临时 tab。报告中区分：线程成功、线程仍 incomplete、浏览器执行失败、站点明确终态，以及没有连接到第二台电脑这一环境缺口。
