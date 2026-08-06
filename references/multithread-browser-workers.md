# 多站点、浏览器租约与 worker 线程

约束 `crawl-products` 在多个任务、多个 Chrome Profile、Codex In-App Browser 或另一台电脑上运行时的边界。核心变化（相对旧协议）：**并发决策在 spawn 时刻一次做完，运行期零协调**。旧的"worker 停在 preflight 等协调者派发指令"的调度屏障协议已废除——它本身就是停顿点。

## 浏览器模式与租约身份

- `"extension"`（默认）：`agent.browsers.get("extension")`，保留登录态、代理和本地 Profile；同一个 `extensionInstanceId` 只能安全串行。
- `"iab"`：`agent.browsers.get("iab")`，适合公开站点的任务隔离并发；不继承用户 Chrome 的 Cookie、登录态、Clash 路由或 Profile。

用户明确选择的浏览器模式是硬约束：iab 遇到 challenge/TLS/网络失败必须记录并报告，不得偷偷切到 extension，反之亦然。**同模式重建断掉的 binding 不是切换**，是 `incomplete` 恢复的标准动作。

租约身份以实例 ID 为准：extension 用 `extensionInstanceId`，iab 用 `browserId`（有 `codexAppSessionId` 一并记录）。只有实例 ID 不同才是独立租约；同一实例开多个 tab 仍是同一个租约，不能当成另一台电脑。

## spawn 时定并发

用户给出多个站点时，协调者在派生线程**之前**完成全部并发决策：

1. 枚举可用浏览器租约，按实例 ID 验证独立性；
2. N 个独立租约 → 最多 N 个并行 worker 线程；
3. 共享同一租约的站点合并进**同一个**线程，由该线程内部顺序跑；
4. 每个线程分配独立 `outDir`，binding 由线程自己建立——不得把父线程的 `browser`/`tab` 对象传给子线程。

没有独立租约就是单线程顺序跑完所有站点。并发上限是"独立浏览器实例数"，不是站点数或产品数。

## 一个线程 = 一个站点组 = 一个 goal

worker 线程的初始 prompt 就是它的 goal，写成完成契约而不是步骤清单：

```
你的唯一目标：让 <sites> 全部达到三种终态之一，在此之前不得结束回合：
  complete / terminal(带证据) / blocked(点名具体阻塞物)
工作方式：读各站 <outDir>/state.json，按 crawl-products SKILL.md 的状态机从对应状态继续。
汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume。
```

线程的完整时间线不换手：Preflight A/B/C（模型活跃）→ `await runHarvest()`（阻塞在长调用上，脚本机械爬取）→ 语义队列（模型活跃，无浏览器）→ 验证 → 导出。脚本运行期间线程没有任何理由结束回合或等待外部指令。

**可重入**：每个阶段落盘（state.json、HarvestPlan、checkpoint、证据包、语义队列）。线程死亡（超时、崩溃、被回收）不丢工作——把同一 goal prompt 原样重发，新线程读 state.json 从断点继续。

## 协调者只做两件事

1. **轮询**各线程的 `state.json` 与产物时间戳；
2. **踢一脚**：某线程状态长时间不动或线程已死 → 原样重发它的 goal prompt。不发送任何"下一步做什么"的指令——下一步由 state.json 决定。

收货规则：协调者不信任线程的自我声明，接受 complete 前必跑 `verify.verifyRunArtifacts(outDir)`；审计 fail 就把问题清单连同 goal 重发给线程。任一站点未到终态，批次不得汇报完成或生成正式批次导出。

## 执行面故障的分级恢复

| 故障 | 信号 | 恢复动作 |
|---|---|---|
| tab 污染 | 超时、截图空白、`discardTab` | `replaceTaintedTab()` 换新 tab，同一 binding 内重试一次 |
| binding 丢失 | `tabs.new()` 也失败 | 置 binding 为空 → 重新 `agent.browsers.get(browserMode)` → 新 tab → `runHarvest(..., { resume: true })` |
| 线程死亡 | state.json 停滞、任务无响应 | 协调者重发 goal prompt，重入线程从磁盘续 |

三级都是执行面问题：不得写成站点 unavailable，不得把剩余 URL 转成"待复核"，不得覆盖已学 profile。页面级访问错误的分类（challenge/TLS/HTTP）见 [site-outcomes-and-handoffs.md](site-outcomes-and-handoffs.md)。

## 顺序纪律

- 同一个 tab 上永不并发：不对同一 tab 使用 `Promise.all` 混合导航、截图、点击、CDP 或 Network 读取。
- 未知站点视觉首遍、代表详情验证、变体逐状态记录始终顺序执行。
- `runHarvest()` 内部详情提取默认顺序（小批次 + 单 tab）；后台并行读取仅限已验证 profile、无交互字段且用户明确接受成本时。
- 同一运行时持有多个租约的 binding 时，可在一个进程内并行运行多个 `runHarvest()`（每租约一个），互不共享 tab。

## 验收口径

"跑 10 个"表示 10 个真实详情 URL 各自拿到完整证据包并通过语义与验证门，不是枚举 10 个列表卡片。10 个不代表全站：目录未耗尽就是 `incomplete`，只能 resume 或按用户成本上限明确停在 `inventory_partial`，不得生成正式 `products.json`。

## 结束和交接

线程结束前 finalize 自己的 tab，不留研究用临时 tab。报告区分：线程 complete（过审计）、incomplete（附 resume 入口）、terminal（附证据）、blocked（点名阻塞物）、以及环境缺口（如没有第二个独立租约）。
